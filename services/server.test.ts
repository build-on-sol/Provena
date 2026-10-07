import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { AccountInfo, Connection, PublicKey } from '@solana/web3.js';
import { BN, BorshCoder, Idl } from '@coral-xyz/anchor';
import { hashContent } from '../packages/canonicalization/src';
import { buildPayoutTree, createOriginalNodeRights, payoutVector, RevenueKind } from '../packages/rights-math/src';
import { verifyProvenanceChain, verifyProvenanceReveal } from '../packages/protocol-sdk/src';
import { Ed25519AuthoritySigner, requestMessage, SignedRequest, verifyWalletSignature, WalletAuthenticator } from './auth';
import { accountDiscriminator, ChainNodeSnapshot, DEFAULT_PROGRAM_ID, RpcNodeReader, RpcReceiptVerifier } from './chain';
import { ContentService, decryptBlob } from './content-service';
import { EventIndexer, IndexedEvent, RpcEventPoller } from './indexer';
import { ProvenanceService } from './provenance-service';
import { createServiceApp } from './server';
import { LocalStore } from './store';

function wallet() {
  const keys = generateKeyPairSync('ed25519');
  const der = keys.publicKey.export({ format: 'der', type: 'spki' });
  const address = new PublicKey(der.subarray(der.length - 32)).toBase58();
  return { ...keys, address };
}
function signedRequest(keys: ReturnType<typeof wallet>, path: string, payload: unknown, timestamp = 1_000_000, nonce = randomBytes(16).toString('hex')): SignedRequest {
  const value = { wallet: keys.address, nonce, timestamp, payload };
  return { ...value, signature: sign(null, requestMessage('POST', path, value), keys.privateKey).toString('base64') };
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'provena-services-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: await LocalStore.open(join(directory, 'store.json')) };
}
const unavailableNodeReader = { readNode: async (): Promise<ChainNodeSnapshot> => { throw new Error('offline'); } };
function key(): string { return wallet().address; }
function event(index: number, name: string, data: Record<string, string>): IndexedEvent {
  return { signature: '2'.repeat(88), slot: 42, index, name, data };
}

test('wallet request signatures bind action, content, time and durable one-use nonce', async t => {
  const { directory, store } = await fixture(t);
  const keys = wallet();
  const auth = new WalletAuthenticator(store, () => 1_000_000);
  const request = signedRequest(keys, '/reactions', { content: key(), value: 'LIKE' });
  await auth.authenticate('POST', '/reactions', request);
  await assert.rejects(auth.authenticate('POST', '/reactions', request), /RequestReplay/);
  const restarted = new WalletAuthenticator(await LocalStore.open(join(directory, 'store.json')), () => 1_000_000);
  await assert.rejects(restarted.authenticate('POST', '/reactions', request), /RequestReplay/);
  await assert.rejects(auth.authenticate('POST', '/paid-key', request), /InvalidWalletSignature/);
  await assert.rejects(auth.authenticate('POST', '/reactions', { ...request, payload: { value: 'UNLIKE' } }), /InvalidWalletSignature/);
  await assert.rejects(auth.authenticate('POST', '/reactions', signedRequest(keys, '/reactions', {}, 600_000)), /ExpiredRequest/);
  await assert.rejects(auth.authenticate('POST', '/reactions', signedRequest(keys, '/reactions', {}, 1_400_000)), /ExpiredRequest/);
  const other = wallet();
  await assert.rejects(auth.authenticate('POST', '/reactions', { ...signedRequest(keys, '/reactions', {}), wallet: other.address }), /InvalidWalletSignature/);
  const concurrent = signedRequest(keys, '/reactions', {});
  const results = await Promise.allSettled([auth.authenticate('POST', '/reactions', concurrent), auth.authenticate('POST', '/reactions', concurrent)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
});

test('content keeps raw identity, global local fingerprint and immutable author', async t => {
  const { directory, store } = await fixture(t);
  const first = wallet(), second = wallet();
  const service = new ContentService(store, DEFAULT_PROGRAM_ID, { hasAccess: async () => false });
  const artifact = await service.stage(first.address, { body: 'Ａ  text\r\n', mode: 'PUBLIC', title: 'Original' });
  assert.equal(artifact.rawHash, hashContent('Ａ  text\r\n').rawHash);
  assert.equal(artifact.canonicalizationVersion, 1);
  await assert.rejects(service.stage(second.address, { body: 'A text\n', mode: 'PUBLIC', title: 'Copy' }), /DuplicateContent/);
  assert.equal(service.get(artifact.id).author, first.address);
  const reloaded = new ContentService(await LocalStore.open(join(directory, 'store.json')), DEFAULT_PROGRAM_ID, { hasAccess: async () => false });
  assert.equal(reloaded.get(artifact.id).plaintext, 'Ａ  text\r\n');
  assert.equal(reloaded.originalityRisk('A text').assessment, 'EXACT_DUPLICATE');
  const risk = reloaded.originalityRisk('unrelated language');
  assert.equal(risk.assessment, 'NO_MOCK_SIGNAL');
  assert.equal(Object.hasOwn(risk, 'guilt'), false);
});

test('paid artifacts persist ciphertext; key service fails closed without receipt or RPC', async t => {
  const { directory, store } = await fixture(t);
  const author = wallet(), buyer = wallet(), master = randomBytes(32);
  let authorized = false, unavailable = false;
  const service = new ContentService(store, DEFAULT_PROGRAM_ID, { hasAccess: async (content, wallet) => { assert.equal(wallet, buyer.address); assert.ok(content); if (unavailable) throw new Error('RPC offline'); return authorized; } }, master);
  const text = 'Secret paid body which is never stored in plaintext.';
  const artifact = await service.stage(author.address, { body: text, mode: 'PAID', title: 'Paid' });
  assert.equal(artifact.quotePolicy, 'NONE');
  assert.equal(artifact.plaintext, undefined);
  assert.equal(Object.hasOwn(artifact, 'wrappedKey'), false);
  const persisted = await readFile(join(directory, 'store.json'), 'utf8');
  assert.equal(persisted.includes(text), false);
  assert.equal(persisted.includes(master.toString('hex')), false);
  await assert.rejects(service.releaseKey(artifact.id, buyer.address), /AccessReceiptRequired/);
  unavailable = true;
  await assert.rejects(service.releaseKey(artifact.id, buyer.address), /AccessVerifierUnavailable/);
  unavailable = false; authorized = true;
  const released = await service.releaseKey(artifact.id, buyer.address);
  assert.equal(decryptBlob(artifact.blob!, Buffer.from(released.key, 'base64'), released.associatedData).toString(), text);
  const tampered = { ...artifact.blob!, tag: randomBytes(16).toString('base64') };
  assert.throws(() => decryptBlob(tampered, Buffer.from(released.key, 'base64'), released.associatedData));
  const restarted = new ContentService(await LocalStore.open(join(directory, 'store.json')), DEFAULT_PROGRAM_ID, { hasAccess: async () => true }, master);
  assert.equal(restarted.privateBody(restarted.get(artifact.id)), text);
  await assert.rejects(new ContentService(store, DEFAULT_PROGRAM_ID, { hasAccess: async () => false }).stage(author.address, { body: 'another paid text', mode: 'PAID', title: 'Paid' }), /KeyServiceUnconfigured/);
});

test('RPC receipt verifier checks expected PDA, owner, discriminator and exact content/buyer', async () => {
  const content = new PublicKey(key()), buyer = new PublicKey(key());
  const expected = PublicKey.findProgramAddressSync([Buffer.from('access'), content.toBuffer(), buyer.toBuffer()], DEFAULT_PROGRAM_ID)[0];
  const data = Buffer.alloc(153);
  accountDiscriminator('AccessReceipt').copy(data, 0); data[8] = 1;
  content.toBuffer().copy(data, 9); buyer.toBuffer().copy(data, 41); data.writeBigUInt64LE(123n, 105);
  let account: AccountInfo<Buffer> | null = { data, owner: DEFAULT_PROGRAM_ID, executable: false, lamports: 1, rentEpoch: 1 };
  const verifier = new RpcReceiptVerifier({ getAccountInfo: async requested => { assert.ok(requested.equals(expected)); return account; } });
  assert.equal(await verifier.hasAccess(content.toBase58(), buyer.toBase58()), true);
  const original = account;
  for (const mutation of [
    { ...original, owner: new PublicKey(key()) },
    { ...original, executable: true },
    { ...original, data: Buffer.from(data.subarray(0, 80)) },
    { ...original, data: Buffer.from(data) },
  ]) {
    if (mutation.data.length === 153 && mutation.owner.equals(DEFAULT_PROGRAM_ID) && !mutation.executable) mutation.data[0] = 0;
    account = mutation;
    assert.equal(await verifier.hasAccess(content.toBase58(), buyer.toBase58()), false);
  }
  for (const offset of [8, 9, 41, 105]) {
    const invalid = Buffer.from(data);
    if (offset === 8) invalid[8] = 2;
    else if (offset === 105) invalid.writeBigUInt64LE(0n, 105);
    else randomBytes(32).copy(invalid, offset);
    account = { ...original, data: invalid };
    assert.equal(await verifier.hasAccess(content.toBase58(), buyer.toBase58()), false);
  }
  account = null;
  assert.equal(await verifier.hasAccess(content.toBase58(), buyer.toBase58()), false);
  await assert.rejects(new RpcReceiptVerifier({ getAccountInfo: async () => { throw new Error('offline'); } }).hasAccess(content.toBase58(), buyer.toBase58()), /offline/);
});

test('citation service verifies stored attribution and rejects public paid-body disclosure', async t => {
  const { store } = await fixture(t);
  const author = wallet(), citing = wallet();
  const service = new ContentService(store, DEFAULT_PROGRAM_ID, { hasAccess: async () => false }, randomBytes(32));
  const source = await service.stage(author.address, { body: 'abc' + 'x'.repeat(97), mode: 'PUBLIC', title: 'Source' });
  const body = 'abc ' + 'commentary '.repeat(8);
  const id = PublicKey.findProgramAddressSync([Buffer.from('content'), new PublicKey(citing.address).toBuffer(), Buffer.from(hashContent(body).rawHash, 'hex')], DEFAULT_PROGRAM_ID)[0].toBase58();
  const reference = { sourceContentId: source.id, sourceAuthor: author.address, citingContentId: id, surface: 'BODY' as const, sourceSegments: [{ start: 0, end: 3 }], excerpt: 'abc' };
  const artifact = await service.stage(citing.address, { body, mode: 'PUBLIC', title: 'Comment', citations: [reference] });
  assert.equal(artifact.citationManifest.references[0]!.sourceAuthor, author.address);
  assert.equal(artifact.citationManifest.references[0]!.excerptHash, hashContent('abc').rawHash);
  const paid = await service.stage(author.address, { body: 'private'.repeat(100), mode: 'PAID', title: 'Paid source' });
  const leakBody = 'private ' + 'commentary '.repeat(20);
  const leakId = PublicKey.findProgramAddressSync([Buffer.from('content'), new PublicKey(citing.address).toBuffer(), Buffer.from(hashContent(leakBody).rawHash, 'hex')], DEFAULT_PROGRAM_ID)[0].toBase58();
  await assert.rejects(service.stage(citing.address, { body: leakBody, mode: 'PUBLIC', title: 'Leak', citations: [{ ...reference, citingContentId: leakId, sourceContentId: paid.id, excerpt: 'private', sourceSegments: [{ start: 0, end: 7 }] }] }), /PaidBodyQuoteForbidden/);
  await assert.rejects(service.stage(citing.address, { body: body + '!', mode: 'PUBLIC', title: 'Forgery', citations: [{ ...reference, sourceAuthor: citing.address }] }), /InvalidSourceAttribution/);
});

test('provenance plans keep parents private and enforce real parent roots and independent policies', async t => {
  const { store } = await fixture(t);
  const a = wallet(), b = wallet(), c = wallet(), outsider = wallet();
  const authority = new Ed25519AuthoritySigner(wallet().privateKey);
  const content = key(), original = key();
  const rights = createOriginalNodeRights(new PublicKey(a.address).toBuffer());
  const tipRoot = buildPayoutTree(new PublicKey(original).toBuffer(), RevenueKind.Tip, payoutVector(rights.tip)).root;
  const saleRoot = buildPayoutTree(new PublicKey(original).toBuffer(), RevenueKind.Sale, payoutVector(rights.sale)).root;
  const snapshots = new Map<string, ChainNodeSnapshot>([[original, { node: original, content, creator: a.address, tipRoot, saleRoot, tipRetentionBps: 7000, saleRetentionBps: 8000, tipResidualBps: 10_000, saleResidualBps: 10_000, commitment: '00'.repeat(32), originalRights: rights }]]);
  const service = new ProvenanceService(store, { readNode: async node => { const row = snapshots.get(node); assert.ok(row); return row; } }, DEFAULT_PROGRAM_ID, authority);
  await assert.rejects(service.registerOriginal(outsider.address, original), /Unauthorized/);
  await service.registerOriginal(a.address, original);
  const planB = await service.attestRepost(b.address, { parent: original, nonce: '01'.repeat(32), policy: { tipRetentionBps: 6000, saleRetentionBps: 5000 } });
  assert.equal(planB.publicPlan.tipResidualBps, 3000);
  assert.equal(planB.publicPlan.saleResidualBps, 2000);
  assert.equal(JSON.stringify(planB).includes(original), false);
  assert.equal(verifyWalletSignature(authority.wallet, Buffer.from(planB.auditAttestation.message), planB.auditAttestation.signature), true);
  assert.equal(planB.auditAttestation.transactionCosigningRequired, true);
  snapshots.set(planB.publicPlan.node, { node: planB.publicPlan.node, content, creator: b.address, tipRoot: planB.publicPlan.tipRoot, saleRoot: planB.publicPlan.saleRoot, tipRetentionBps: 6000, saleRetentionBps: 5000, tipResidualBps: 3000, saleResidualBps: 2000, commitment: planB.publicPlan.provenanceCommitment });
  await service.confirmNode(b.address, planB.publicPlan.node);
  const planC = await service.attestRepost(c.address, { parent: planB.publicPlan.node, nonce: '02'.repeat(32), policy: { tipRetentionBps: 10_000, saleRetentionBps: 10_000 } });
  const tip = service.payoutProof(c.address, planC.publicPlan.node, RevenueKind.Tip);
  const byWallet = Object.fromEntries(tip.leaves.map(leaf => [leaf.beneficiary, leaf.shareBps]));
  assert.equal(byWallet[new PublicKey(a.address).toBuffer().toString('hex')], 7000);
  assert.equal(byWallet[new PublicKey(b.address).toBuffer().toString('hex')], 1800);
  assert.equal(byWallet[new PublicKey(c.address).toBuffer().toString('hex')], 1200);
  const reveal = service.reveal(c.address, planC.publicPlan.node);
  assert.equal(reveal.length, 2);
  assert.ok(reveal.every(verifyProvenanceReveal));
  assert.ok(verifyProvenanceChain(reveal, planC.publicPlan.provenanceCommitment));
  await assert.rejects(async () => service.reveal(outsider.address, planC.publicPlan.node), /Unauthorized/);
  assert.equal(service.payoutProof(a.address, planC.publicPlan.node, RevenueKind.Tip).leaves.length, 1);
  assert.throws(() => service.payoutProof(outsider.address, planC.publicPlan.node, RevenueKind.Tip), /Unauthorized/);
  const oldRoot = planB.publicPlan.tipRoot;
  snapshots.get(original)!.tipRetentionBps = 9000;
  const updatedPolicy = await service.attestRepost(outsider.address, { parent: original, nonce: '03'.repeat(32), policy: { tipRetentionBps: 10_000, saleRetentionBps: 10_000 } });
  assert.equal(updatedPolicy.publicPlan.tipResidualBps, 1000);
  assert.equal(service.payoutProof(b.address, planB.publicPlan.node, RevenueKind.Tip).root, oldRoot);
  snapshots.get(original)!.tipRoot = 'ff'.repeat(32);
  await assert.rejects(service.attestRepost(b.address, { parent: original, nonce: '04'.repeat(32), policy: { tipRetentionBps: 7000, saleRetentionBps: 7000 } }), /ChainRightsMismatch/);
});

test('RPC node reader matches exact chain account layout and rejects ownership substitution', async () => {
  const creator = wallet(), content = new PublicKey(key());
  const original = PublicKey.findProgramAddressSync([Buffer.from('original'), content.toBuffer()], DEFAULT_PROGRAM_ID)[0];
  const rights = createOriginalNodeRights(new PublicKey(creator.address).toBuffer());
  const nodeData = Buffer.alloc(185), contentData = Buffer.alloc(395);
  accountDiscriminator('DistributionNode').copy(nodeData); nodeData[8] = 1;
  content.toBuffer().copy(nodeData, 9); new PublicKey(creator.address).toBuffer().copy(nodeData, 41);
  Buffer.from(buildPayoutTree(original.toBuffer(), RevenueKind.Tip, payoutVector(rights.tip)).root, 'hex').copy(nodeData, 73);
  Buffer.from(buildPayoutTree(original.toBuffer(), RevenueKind.Sale, payoutVector(rights.sale)).root, 'hex').copy(nodeData, 105);
  nodeData.writeUInt16LE(3000, 137); nodeData.writeUInt16LE(2000, 139); nodeData.writeUInt16LE(10_000, 141); nodeData.writeUInt16LE(10_000, 143);
  accountDiscriminator('Content').copy(contentData); contentData[8] = 1; new PublicKey(creator.address).toBuffer().copy(contentData, 9); original.toBuffer().copy(contentData, 246);
  let owner = DEFAULT_PROGRAM_ID;
  const reader = new RpcNodeReader({ getAccountInfo: async address => ({ data: address.equals(original) ? nodeData : contentData, owner, executable: false, lamports: 1, rentEpoch: 1 }) });
  const snapshot = await reader.readNode(original.toBase58());
  assert.equal(snapshot.tipRetentionBps, 7000);
  assert.equal(snapshot.saleRetentionBps, 8000);
  assert.equal(snapshot.originalRights!.tip.residual.shareBps, 10_000);
  owner = new PublicKey(key());
  await assert.rejects(reader.readNode(original.toBase58()), /InvalidChainAccount/);
});

test('indexer derives revenue only from deduplicated events and scopes reviews to participants', async t => {
  const { store } = await fixture(t);
  const indexer = new EventIndexer(store);
  const candidate = key(), reference = key(), a = key(), b = key(), c = key(), mint = key(), node = key(), similarity = key(), epoch = key();
  const events = [event(0, 'ContentSubmitted', { content: candidate, author: b, rawHash: 'ab'.repeat(32) }), event(1, 'ContentSubmitted', { content: reference, author: a, rawHash: 'cd'.repeat(32) }), event(2, 'TipReceived', { content: candidate, node, mint, amount: '100' }), event(3, 'AccessPurchased', { content: candidate, node, mint, buyer: c, amount: '50' }), event(4, 'RevenueClaimed', { epoch, beneficiary: b, amount: '10' }), event(5, 'SimilarityCaseOpened', { case: similarity, candidate, reference, cutoff: '604800' })];
  await indexer.ingest(events);
  await indexer.ingest(events);
  assert.equal(indexer.events().length, events.length);
  assert.deepEqual(indexer.metrics(candidate).revenueByAsset[mint], { tip: '100', sale: '50' });
  assert.equal(indexer.metrics(candidate).paidBeneficiaryCount, null);
  await indexer.react(b, candidate, 'LIKE'); await indexer.react(b, candidate, 'LIKE');
  assert.equal(indexer.metrics(candidate).likes, 1);
  await indexer.react(b, candidate, 'UNLIKE'); await indexer.react(c, candidate, 'VIEW');
  assert.equal(indexer.metrics(candidate).likes, 0); assert.equal(indexer.metrics(candidate).unlikes, 1); assert.equal(indexer.metrics(candidate).views, 1);
  assert.equal(indexer.creatorReviewList(a).length, 1);
  await assert.rejects(indexer.message(c, similarity, { wallet: c, text: 'Attack', timestamp: 1, signature: 'signature', nonce: 'nonce' }), /Unauthorized/);
  await indexer.message(a, similarity, { wallet: a, text: 'Please review the evidence', timestamp: 1, signature: 'signature', nonce: 'nonce' });
  assert.equal(indexer.thread(b, similarity).messages.length, 1);
  assert.throws(() => indexer.thread(c, similarity), /Unauthorized/);
  assert.equal(indexer.claimDashboard(b).claimedByEpoch[epoch], '10');
  assert.equal(indexer.claimDashboard(b).balances, null);
  await assert.rejects(indexer.ingest([event(6, 'DistributionNodeCreated', { content: candidate, node, creator: b, parent: reference })]), /InvalidChainEventFields/);
  await indexer.ingest([event(6, 'IndependentConfirmed', { case: similarity })]);
  assert.equal(indexer.creatorReviewList(a).length, 0);
  assert.equal(indexer.feed().find(row => row.content === candidate)!.status, 'INDEPENDENT');
});

test('HTTP API authenticates private routes and never accepts financial writes', async t => {
  const { store } = await fixture(t);
  const author = wallet();
  const app = createServiceApp({ store, receiptVerifier: { hasAccess: async () => false }, nodeReader: unavailableNodeReader, now: () => 1_000_000, encryptionMasterKey: randomBytes(32) });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => app.server.close(error => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const call = async (path: string, payload: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const unsigned = await call('/content', { body: 'fake', mode: 'PUBLIC', title: 'Fake' });
  assert.equal(unsigned.status, 400);
  const request = signedRequest(author, '/content', { body: 'Valid signed content', mode: 'PUBLIC', title: 'Title' });
  const created = await call('/content', request);
  assert.equal(created.status, 200);
  const response = await created.json() as { artifact: { id: string; author: string }; storageState: string };
  assert.equal(response.artifact.author, author.address);
  assert.equal(response.storageState, 'STAGED_FOR_CHAIN_SUBMISSION');
  assert.equal((await call('/content', request)).status, 409);
  const fetched = await fetch(`${base}/content/${response.artifact.id}`);
  assert.equal(fetched.headers.get('cache-control'), 'no-store');
  assert.equal((await fetched.json() as { chainState: null }).chainState, null);
  assert.deepEqual(await (await fetch(`${base}/feed`)).json(), []);
  assert.equal((await call('/tip', signedRequest(author, '/tip', { amount: '100' }))).status, 404);
  assert.equal((await fetch(`${base}/provenance/reveal`)).status, 404);
  const wrongRoute = signedRequest(author, '/dashboard/claims', {});
  assert.equal((await call('/provenance/reveal', wrongRoute)).status, 401);
});

test('generated IDL Borsh account bytes agree with service receipt and node layouts', async () => {
  const idl = JSON.parse(await readFile(join(process.cwd(), 'idl/content_rights_protocol.json'), 'utf8')) as Idl;
  assert.equal(idl.address, DEFAULT_PROGRAM_ID.toBase58());
  const coder = new BorshCoder(idl);
  const author = new PublicKey(key()), source = new PublicKey(key()), content = new PublicKey(key()), buyer = new PublicKey(key()), mint = new PublicKey(key());
  const original = PublicKey.findProgramAddressSync([Buffer.from('original'), content.toBuffer()], DEFAULT_PROGRAM_ID)[0];
  const receipt = PublicKey.findProgramAddressSync([Buffer.from('access'), content.toBuffer(), buyer.toBuffer()], DEFAULT_PROGRAM_ID)[0];
  const rights = createOriginalNodeRights(author.toBuffer(), [{ beneficiary: source.toBuffer(), shareBps: 2000 }]);
  const tipRoot = buildPayoutTree(original.toBuffer(), RevenueKind.Tip, payoutVector(rights.tip)).root;
  const saleRoot = buildPayoutTree(original.toBuffer(), RevenueKind.Sale, payoutVector(rights.sale)).root;
  const zeros = Array.from(Buffer.alloc(32));
  const contentBytes = await coder.accounts.encode('Content', {
    version: 1, author, raw_hash: Array.from(randomBytes(32)), canonical_hash: Array.from(randomBytes(32)), canonicalization_version: 1,
    metadata_commitment: zeros, storage_commitment: zeros, citation_manifest_commitment: zeros,
    mode: 1, status: 1, quote_policy: 0, price: new BN(17), price_mint: mint, original_node: original,
    licensed_source: source, licensed_source_bps: 2000, derivative_source: PublicKey.default, derivative_source_bps: 0,
    created_at: new BN(123), normal_deadline: new BN(0), active_case: PublicKey.default, case_resolved: false,
  });
  const nodeBytes = await coder.accounts.encode('DistributionNode', {
    version: 1, content, creator: author, tip_payout_root: Array.from(Buffer.from(tipRoot, 'hex')), sale_payout_root: Array.from(Buffer.from(saleRoot, 'hex')),
    tip_child_bps: 3000, sale_child_bps: 2000, tip_residual_bps: 8000, sale_residual_bps: 8000,
    provenance_commitment: zeros, next_epoch: new BN(7),
  });
  const receiptBytes = await coder.accounts.encode('AccessReceipt', { version: 1, content, buyer, purchase_node: original, amount: new BN(17), mint, created_at: new BN(123) });
  assert.equal(contentBytes.length, 395);
  assert.equal(nodeBytes.length, 185);
  assert.equal(receiptBytes.length, 153);
  const accounts = new Map<string, AccountInfo<Buffer>>([
    [content.toBase58(), { owner: DEFAULT_PROGRAM_ID, executable: false, lamports: 1, rentEpoch: 1, data: contentBytes }],
    [original.toBase58(), { owner: DEFAULT_PROGRAM_ID, executable: false, lamports: 1, rentEpoch: 1, data: nodeBytes }],
    [receipt.toBase58(), { owner: DEFAULT_PROGRAM_ID, executable: false, lamports: 1, rentEpoch: 1, data: receiptBytes }],
  ]);
  const reader = { getAccountInfo: async (address: PublicKey) => accounts.get(address.toBase58()) ?? null };
  const snapshot = await new RpcNodeReader(reader).readNode(original.toBase58());
  assert.equal(snapshot.content, content.toBase58());
  assert.equal(snapshot.creator, author.toBase58());
  assert.equal(snapshot.tipRoot, tipRoot);
  assert.equal(snapshot.saleRoot, saleRoot);
  assert.equal(snapshot.tipRetentionBps, 7000);
  assert.equal(snapshot.saleRetentionBps, 8000);
  assert.equal(snapshot.tipResidualBps, 8000);
  assert.equal(snapshot.saleResidualBps, 8000);
  assert.equal(snapshot.originalRights!.tip.locked[0]!.beneficiary, source.toBuffer().toString('hex'));
  assert.equal(snapshot.originalRights!.tip.locked[0]!.shareBps, 2000);
  assert.equal(await new RpcReceiptVerifier(reader).hasAccess(content.toBase58(), buyer.toBase58()), true);
  const encodedWrongBuyer = await coder.accounts.encode('AccessReceipt', { version: 1, content, buyer: source, purchase_node: original, amount: new BN(17), mint, created_at: new BN(123) });
  accounts.set(receipt.toBase58(), { ...accounts.get(receipt.toBase58())!, data: encodedWrongBuyer });
  assert.equal(await new RpcReceiptVerifier(reader).hasAccess(content.toBase58(), buyer.toBase58()), false);
});

test('generated IDL event logs flow through finalized RPC parser and exclude failed/foreign transactions', async t => {
  const { store } = await fixture(t);
  const idl = JSON.parse(await readFile(join(process.cwd(), 'idl/content_rights_protocol.json'), 'utf8')) as Idl;
  const coder = new BorshCoder(idl);
  const indexer = new EventIndexer(store);
  const content = new PublicKey(key()), reference = new PublicKey(key()), author = new PublicKey(key()), referenceAuthor = new PublicKey(key());
  const node = new PublicKey(key()), mint = new PublicKey(key()), buyer = new PublicKey(key()), similarity = new PublicKey(key()), settlement = new PublicKey(key());
  const epoch = new PublicKey(key()), position = new PublicKey(key()), foreignProgram = new PublicKey(key());
  const rawHash = Array.from(randomBytes(32));
  const log = (name: string, data: Record<string, unknown>): string => {
    const descriptor = idl.events!.find(event => event.name === name);
    assert.ok(descriptor, `Real IDL event ${name} exists`);
    return `Program data: ${Buffer.concat([Buffer.from(descriptor.discriminator), coder.types.encode(name, data)]).toString('base64')}`;
  };
  const oldSignature = '2'.repeat(88), failedSignature = '3'.repeat(88), failedMetaSignature = '4'.repeat(88), latestSignature = '5'.repeat(88);
  const oldLogs = [
    `Program ${DEFAULT_PROGRAM_ID} invoke [1]`,
    log('ContentSubmitted', { content, author, raw_hash: rawHash }),
    log('ContentSubmitted', { content: reference, author: referenceAuthor, raw_hash: Array.from(randomBytes(32)) }),
    log('ContentApproved', { content }),
    log('DistributionNodeCreated', { content, node, creator: author }),
    log('RepostPolicyUpdated', { node, tip: 3000, sale: 2000 }),
    log('TipReceived', { content, node, mint, amount: new BN(100) }),
    log('SimilarityCaseOpened', { case: similarity, candidate: content, reference, cutoff: new BN(604800) }),
    log('SettlementProposed', { case: similarity, settlement }),
    log('SettlementAccepted', { settlement, author }),
    log('RevenueClaimed', { epoch, beneficiary: author, amount: new BN(9) }),
    log('RevenueEnteredSafeguard', { epoch }),
    log('SafeguardExitRequested', { position, amount: new BN(3), requested_at: new BN(77) }),
    log('SafeguardExitClaimable', { position, ready_at: new BN(172877) }),
    log('IndependentConfirmed', { case: similarity }),
    `Program ${DEFAULT_PROGRAM_ID} success`,
  ];
  const latestLogs = [
    `Program ${DEFAULT_PROGRAM_ID} invoke [1]`,
    `Program ${foreignProgram} invoke [2]`,
    log('TipReceived', { content, node, mint, amount: new BN(999999) }),
    `Program ${foreignProgram} success`,
    log('AccessPurchased', { content, node, buyer, mint, amount: new BN(50) }),
    `Program ${DEFAULT_PROGRAM_ID} success`,
  ];
  const transactions = new Map([
    [oldSignature, { meta: { err: null, logMessages: oldLogs } }],
    [failedMetaSignature, { meta: { err: { InstructionError: [0, 'Custom'] }, logMessages: [`Program ${DEFAULT_PROGRAM_ID} invoke [1]`, log('TipReceived', { content, node, mint, amount: new BN(123456) }), `Program ${DEFAULT_PROGRAM_ID} failed: custom program error`] } }],
    [latestSignature, { meta: { err: null, logMessages: latestLogs } }],
  ]);
  const fetched: string[] = [];
  const rpc = {
    getSignaturesForAddress: async (address: PublicKey, options: { until?: string; limit: number }, commitment: string) => {
      assert.ok(address.equals(DEFAULT_PROGRAM_ID)); assert.equal(commitment, 'finalized'); assert.equal(options.limit, 1000);
      if (options.until === latestSignature) return [];
      assert.equal(options.until, undefined);
      return [
        { signature: latestSignature, slot: 45, err: null },
        { signature: failedMetaSignature, slot: 44, err: null },
        { signature: failedSignature, slot: 43, err: { InstructionError: [0, 'Custom'] } },
        { signature: oldSignature, slot: 42, err: null },
      ];
    },
    getTransaction: async (signature: string, options: { commitment: string; maxSupportedTransactionVersion: number }) => {
      assert.equal(options.commitment, 'finalized'); assert.equal(options.maxSupportedTransactionVersion, 0);
      fetched.push(signature);
      const transaction = transactions.get(signature);
      assert.ok(transaction);
      return transaction;
    },
  } as unknown as Connection;
  const poller = new RpcEventPoller(rpc, DEFAULT_PROGRAM_ID, idl, indexer);
  assert.equal(await poller.pollOnce(), 4);
  assert.equal(fetched.includes(failedSignature), false);
  assert.equal(store.snapshot().checkpoint, latestSignature);
  assert.equal(indexer.events().length, 15);
  assert.equal(indexer.events()[0]!.data.rawHash, Buffer.from(rawHash).toString('hex'));
  assert.equal(indexer.events().find(event => event.name === 'SafeguardExitRequested')!.data.requestedAt, '77');
  assert.equal(indexer.events().find(event => event.name === 'SafeguardExitClaimable')!.data.readyAt, '172877');
  assert.deepEqual(indexer.metrics(content.toBase58()).revenueByAsset[mint.toBase58()], { tip: '100', sale: '50' });
  assert.equal(indexer.claimDashboard(author.toBase58()).claimedByEpoch[epoch.toBase58()], '9');
  assert.equal(indexer.creatorReviewList(referenceAuthor.toBase58()).length, 0);
  assert.equal(indexer.feed().find(row => row.content === content.toBase58())!.status, 'INDEPENDENT');
  assert.equal(await poller.pollOnce(), 0);
  assert.equal(indexer.events().length, 15);
  assert.throws(() => new RpcEventPoller(rpc, DEFAULT_PROGRAM_ID, { ...idl, address: foreignProgram.toBase58() }, indexer), /IdlProgramMismatch/);
});
