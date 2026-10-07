import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BN, BorshAccountsCoder, Idl, Program } from '@coral-xyz/anchor';
import { AccountInfo, Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import {
  ProtocolPdas, pdaSeeds, DEFAULT_PROGRAM_ID, u64LE, u64BN,
  provenanceCommitment, verifyProvenanceReveal, verifyProvenanceChain, verifyContentIdentity,
  ProtocolClient, PublicQuotePolicy, ContentMode, submitContentArgs, repostNodeArgs, claimProofArgs,
  AccessReceiptAccount, DistributionNodeAccount,
} from '../packages/protocol-sdk/src/index';
import { RevenueKind, RightsRole, MAX_U64 } from '../packages/rights-math/src/index';
import { hashContent } from '../packages/canonicalization/src/index';
const bytes = (n: number) => Buffer.alloc(32, n);
const wallet = (n: number) => new PublicKey(bytes(n));

test('PDA seeds match global fingerprint and content-scoped paid access account contracts', () => {
  const pdas = new ProtocolPdas();
  const canonicalHash = bytes(9);
  assert.equal(pdaSeeds.fingerprint(canonicalHash).length, 2);
  assert.equal(pdaSeeds.fingerprint(canonicalHash)[0]!.toString(), 'fingerprint');
  assert.equal(pdaSeeds.fingerprint(canonicalHash)[1]!.toString('hex'), canonicalHash.toString('hex'));
  const content = pdas.content(wallet(1), bytes(3))[0];
  const receipt = pdas.receipt(content, wallet(2))[0];
  const manual = PublicKey.findProgramAddressSync([Buffer.from('access'), content.toBuffer(), wallet(2).toBuffer()], DEFAULT_PROGRAM_ID)[0];
  assert.equal(receipt.toBase58(), manual.toBase58());
  assert.notEqual(receipt.toBase58(), pdas.receipt(content, wallet(3))[0].toBase58());
  assert.equal(DEFAULT_PROGRAM_ID.toBuffer().length, 32);
});
test('all dynamic seeds are fixed-width and epochs separate node, mint, kind and nonce', () => {
  const pdas = new ProtocolPdas();
  const tip = pdas.epoch(wallet(1), wallet(2), RevenueKind.Tip, 3n)[0];
  assert.notEqual(tip.toBase58(), pdas.epoch(wallet(1), wallet(2), RevenueKind.Sale, 3n)[0].toBase58());
  assert.notEqual(tip.toBase58(), pdas.epoch(wallet(1), wallet(2), RevenueKind.Tip, 4n)[0].toBase58());
  assert.deepEqual(pdaSeeds.epoch(wallet(1), wallet(2), RevenueKind.Tip, 3n).map(value => value.length), [5, 32, 32, 1, 8]);
  assert.equal(pdaSeeds.repost(wallet(1), wallet(2), bytes(3)).length, 4); // No public parent account.
  assert.equal(pdaSeeds.leaf(wallet(1), RightsRole.Distributor, wallet(2))[2]![0], 1);
  assert.throws(() => pdaSeeds.repost(wallet(1), wallet(2), Buffer.alloc(31)), /InvalidBytes32/);
  assert.throws(() => pdaSeeds.epoch(wallet(1), wallet(2), 2 as RevenueKind, 1n), /InvalidRevenueKind/);
  assert.equal(u64LE(MAX_U64).readBigUInt64LE(), MAX_U64);
  assert.equal(u64BN(MAX_U64).toString(), MAX_U64.toString());
  assert.throws(() => u64LE(MAX_U64 + 1n), /InvalidU64/);
  assert.throws(() => u64LE(-1n), /InvalidU64/);
});
test('fixed-width provenance commitments match independent golden vector and reject edits', () => {
  const input = { node: bytes(3), parent: bytes(2), parentCommitment: bytes(4), salt: bytes(5) };
  const commitment = provenanceCommitment(input);
  assert.equal(commitment, 'f06c78538138df32b3c6d549281fc9881a26ed044914d931d8591b4c3ee0287a');
  assert.equal(verifyProvenanceReveal({ ...input, commitment }), true);
  assert.equal(verifyProvenanceReveal({ ...input, parent: bytes(1), commitment }), false);
  assert.equal(verifyProvenanceReveal({ ...input, salt: bytes(6), commitment }), false);
  assert.equal(verifyProvenanceReveal({ ...input, parentCommitment: bytes(0), commitment }), false);
  assert.equal(verifyProvenanceReveal({ ...input, commitment: Buffer.alloc(31) }), false);
  assert.throws(() => provenanceCommitment({ ...input, salt: Buffer.alloc(33) }), /InvalidBytes32/);
});
test('provenance chain verifies trusted tip, each private link and consecutive commitments', () => {
  const bInput = { node: bytes(2), parent: bytes(1), parentCommitment: bytes(0), salt: bytes(6) };
  const b = { ...bInput, commitment: provenanceCommitment(bInput) };
  const cInput = { node: bytes(3), parent: bytes(2), parentCommitment: b.commitment, salt: bytes(7) };
  const c = { ...cInput, commitment: provenanceCommitment(cInput) };
  assert.equal(verifyProvenanceChain([c, b], c.commitment), true);
  assert.equal(verifyProvenanceChain([c], c.commitment), false);
  assert.equal(verifyProvenanceChain([c, b], c.commitment, bytes(1)), true);
  assert.equal(verifyProvenanceChain([c, b], c.commitment, bytes(8)), false);
  assert.equal(verifyProvenanceChain([b, c], c.commitment), false);
  assert.equal(verifyProvenanceChain([c, { ...b, node: bytes(8) }], c.commitment), false);
  assert.equal(verifyProvenanceChain([c, b], bytes(8)), false);
  assert.equal(verifyProvenanceChain([], c.commitment), false);
});
test('identity verification checks original raw bytes as well as canonical fingerprint and version', () => {
  const body = 'Ａ\r\n内容';
  const hash = hashContent(body);
  assert.equal(verifyContentIdentity(body, hash), true);
  assert.equal(verifyContentIdentity('A\n内容', hash), false);
  assert.equal(verifyContentIdentity(body, { ...hash, canonicalizationVersion: 2 }), false);
  assert.equal(verifyContentIdentity(body, { ...hash, rawHash: 'bad' }), false);
});
test('SDK typed encoders default paid quotes NONE and encode hashes/proofs/u64 without floats', () => {
  const args = submitContentArgs({ rawHash: bytes(1), canonicalHash: bytes(2), canonicalizationVersion: 1,
    metadataCommitment: bytes(3), storageCommitment: bytes(4), citationManifestCommitment: bytes(0),
    mode: ContentMode.Paid, price: MAX_U64, priceMint: wallet(6) });
  assert.equal(args.quotePolicy, PublicQuotePolicy.None);
  assert.equal(args.price.toString(), MAX_U64.toString());
  assert.equal(args.rawHash.length, 32);
  assert.equal(args.priceMint.toBase58(), wallet(6).toBase58());
  const repost = repostNodeArgs({ nonce: bytes(1), tipRoot: bytes(2), saleRoot: bytes(3), tipChildBps: 3000, saleChildBps: 2000, tipResidualBps: 3000, saleResidualBps: 2000, provenanceCommitment: bytes(4) });
  assert.notDeepEqual(repost.tipRoot, repost.saleRoot);
  assert.equal('parent' in repost, false);
  const proof = claimProofArgs({ beneficiary: wallet(1), role: RightsRole.Origin, shareBps: 7000, siblings: [bytes(5)] });
  assert.equal(proof.beneficiary.toBase58(), wallet(1).toBase58());
  assert.deepEqual(proof.siblings, [Array(32).fill(5)]);
  assert.throws(() => claimProofArgs({ beneficiary: wallet(1), role: RightsRole.Origin, shareBps: 0, siblings: [] }), /InvalidClaimProof/);
});
test('synthetic Anchor IDL builds an unsigned instruction with exact discriminator/accounts/data', async () => {
  const discriminator = Array.from(createHash('sha256').update('global:tip').digest().subarray(0, 8));
  const idl: Idl = { address: DEFAULT_PROGRAM_ID.toBase58(), metadata: { name: 'content_rights_protocol', version: '0.1.0', spec: '0.1.0' }, instructions: [
    { name: 'tip', discriminator, accounts: [{ name: 'funder', writable: true, signer: true }], args: [{ name: 'amount', type: 'u64' }] },
  ] };
  const program = new Program<Idl>(idl, { connection: new Connection('http://127.0.0.1:8899') });
  const client = new ProtocolClient(program);
  const instruction = await client.instruction('tip', [new BN(123)], { funder: wallet(1) });
  assert.equal(instruction.programId.toBase58(), DEFAULT_PROGRAM_ID.toBase58());
  assert.equal(instruction.keys[0]!.pubkey.toBase58(), wallet(1).toBase58());
  assert.equal(instruction.keys[0]!.isSigner, true);
  assert.deepEqual(Array.from(instruction.data.subarray(0, 8)), discriminator);
  assert.equal(instruction.data.readBigUInt64LE(8), 123n);
  await assert.rejects(client.instruction('claimLiquid', [], {}), /InstructionMissingFromIdl/);
});

test('synthetic Anchor composite ABI flattens nested contexts and encodes optional null sentinels', async () => {
  const discriminator = Array.from(createHash('sha256').update('global:purchase_access').digest().subarray(0, 8));
  const idl: Idl = { address: DEFAULT_PROGRAM_ID.toBase58(), metadata: { name: 'content_rights_protocol', version: '0.1.0', spec: '0.1.0' }, instructions: [
    { name: 'purchaseAccess', discriminator, accounts: [
      { name: 'economic', accounts: [{ name: 'funder', writable: true, signer: true }, { name: 'case', optional: true }] },
      { name: 'buyer', signer: true }, { name: 'receipt', writable: true },
    ], args: [] },
  ] };
  const client = new ProtocolClient(new Program<Idl>(idl, { connection: new Connection('http://127.0.0.1:8899') }));
  const instruction = await client.instruction('purchaseAccess', [], { economic: { funder: wallet(1), case: null }, buyer: wallet(1), receipt: wallet(3) });
  assert.deepEqual(instruction.keys.map(value => value.pubkey.toBase58()), [wallet(1).toBase58(), DEFAULT_PROGRAM_ID.toBase58(), wallet(1).toBase58(), wallet(3).toBase58()]);
  assert.equal(instruction.keys[1]!.isSigner, false);
  const cyclic: Record<string, unknown> = {};
  cyclic.nested = cyclic;
  await assert.rejects(client.instruction('purchaseAccess', [], cyclic as Parameters<typeof client.instruction>[2]), /CyclicInstructionAccounts/);
});

test('synthetic receipt ABI verifies paid access ownership, discriminator, version, content and buyer', async () => {
  const discriminator = Array.from(createHash('sha256').update('account:AccessReceipt').digest().subarray(0, 8));
  const idl: Idl = { address: DEFAULT_PROGRAM_ID.toBase58(), metadata: { name: 'content_rights_protocol', version: '0.1.0', spec: '0.1.0' }, instructions: [],
    accounts: [{ name: 'accessReceipt', discriminator }], types: [{ name: 'accessReceipt', type: { kind: 'struct', fields: [
      { name: 'version', type: 'u8' }, { name: 'content', type: 'pubkey' }, { name: 'buyer', type: 'pubkey' },
      { name: 'purchaseNode', type: 'pubkey' }, { name: 'amount', type: 'u64' }, { name: 'mint', type: 'pubkey' }, { name: 'createdAt', type: 'i64' },
    ] } }],
  };
  const coder = new BorshAccountsCoder(idl);
  const receipt = { version: 1, content: wallet(1), buyer: wallet(2), purchaseNode: wallet(3), amount: new BN(100), mint: wallet(4), createdAt: new BN(10) };
  const data = await coder.encode('accessReceipt', receipt);
  let info: AccountInfo<Buffer> | null = { executable: false, owner: DEFAULT_PROGRAM_ID, data, lamports: 1 };
  const connection = new Connection('http://127.0.0.1:8899');
  connection.getAccountInfo = async address => {
    assert.equal(address.toBase58(), new ProtocolPdas().receipt(wallet(1), wallet(2))[0].toBase58());
    return info;
  };
  const client = new ProtocolClient(new Program<Idl>(idl, { connection }));
  assert.equal(await client.hasAccess(wallet(1), wallet(2)), true);
  info = { ...info!, owner: wallet(8) };
  assert.equal(await client.hasAccess(wallet(1), wallet(2)), false);
  info = { ...info, owner: DEFAULT_PROGRAM_ID, executable: true };
  assert.equal(await client.hasAccess(wallet(1), wallet(2)), false);
  info = { ...info, executable: false, data: await coder.encode('accessReceipt', { ...receipt, buyer: wallet(8) }) };
  assert.equal(await client.hasAccess(wallet(1), wallet(2)), false);
  info = { ...info, data: await coder.encode('accessReceipt', { ...receipt, content: wallet(8) }) };
  assert.equal(await client.hasAccess(wallet(1), wallet(2)), false);
  info = { ...info, data: await coder.encode('accessReceipt', { ...receipt, amount: new BN(0) }) };
  assert.equal(await client.hasAccess(wallet(1), wallet(2)), false);
  info = { ...info, data: await coder.encode('accessReceipt', { ...receipt, version: 2 }) };
  assert.equal(await client.hasAccess(wallet(1), wallet(2)), false);
  info = { ...info, data: Buffer.alloc(data.length) };
  assert.equal(await client.hasAccess(wallet(1), wallet(2)), false);
  info = null;
  assert.equal(await client.hasAccess(wallet(1), wallet(2)), false);
});

const actualIdl: Idl = JSON.parse(readFileSync(resolve(__dirname, '../../idl/content_rights_protocol.json'), 'utf8')) as Idl;
function actualClient() {
  return new ProtocolClient(new Program<Idl>(actualIdl, { connection: new Connection('http://127.0.0.1:8899') }));
}
function actualDiscriminator(instructionName: string): Buffer {
  const instruction = actualIdl.instructions.find(value => value.name === instructionName);
  assert.ok(instruction, `Actual IDL must contain ${instructionName}`);
  return Buffer.from(instruction.discriminator);
}
function littleU16(value: number): Buffer { const result = Buffer.alloc(2); result.writeUInt16LE(value); return result; }
function littleU32(value: number): Buffer { const result = Buffer.alloc(4); result.writeUInt32LE(value); return result; }
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

test('actual generated ABI encodes SubmitArgs and RepostArgs with exact Rust struct bytes', async () => {
  const client = actualClient();
  assert.equal(actualIdl.instructions.length, 24);
  assert.equal(client.program.programId.toBase58(), DEFAULT_PROGRAM_ID.toBase58());
  const author = wallet(1), originality = wallet(7), mint = wallet(8);
  const config = client.pdas.config()[0];
  const content = client.pdas.content(author, bytes(1))[0];
  const fingerprint = client.pdas.fingerprint(bytes(2))[0];
  const submit = submitContentArgs({ rawHash: bytes(1), canonicalHash: bytes(2), canonicalizationVersion: 1,
    metadataCommitment: bytes(3), storageCommitment: bytes(4), citationManifestCommitment: bytes(5),
    mode: ContentMode.Paid, price: 12345n, priceMint: mint });
  const submitted = await client.instruction('submitContent', [submit], { author, originality, config, content, fingerprint, systemProgram: SystemProgram.programId });
  assert.deepEqual(submitted.data, Buffer.concat([actualDiscriminator('submit_content'), bytes(1), bytes(2), littleU16(1), bytes(3), bytes(4), bytes(5), Buffer.from([ContentMode.Paid, PublicQuotePolicy.None]), u64LE(12345n), mint.toBuffer()]));
  assert.deepEqual(submitted.keys.map(value => value.pubkey.toBase58()), [author, originality, config, content, fingerprint, SystemProgram.programId].map(value => value.toBase58()));
  assert.deepEqual(submitted.keys.map(value => [value.isWritable, value.isSigner]), [[true, true], [false, true], [false, false], [true, false], [true, false], [false, false]]);
  const creator = wallet(2), rights = wallet(9), nonce = bytes(11);
  const node = client.pdas.repost(content, creator, nonce)[0];
  const repost = repostNodeArgs({ nonce, tipRoot: bytes(12), saleRoot: bytes(13), tipChildBps: 3000, saleChildBps: 2000, tipResidualBps: 1200, saleResidualBps: 1000, provenanceCommitment: bytes(14) });
  const created = await client.instruction('createRepostNode', [repost], { creator, config, rights, content, node, systemProgram: SystemProgram.programId });
  assert.deepEqual(created.data, Buffer.concat([actualDiscriminator('create_repost_node'), nonce, bytes(12), bytes(13), littleU16(3000), littleU16(2000), littleU16(1200), littleU16(1000), bytes(14)]));
  assert.deepEqual(created.keys.map(value => value.pubkey.toBase58()), [creator, config, rights, content, node, SystemProgram.programId].map(value => value.toBase58()));
  assert.equal(created.keys.length, 6); // The actual ABI includes no public parent account.
  assert.deepEqual(created.keys.map(value => value.isSigner), [true, false, true, false, false, false]);
});

test('actual generated ClaimProof ABI encodes role/share/proof vector/amount and optional review sentinel', async () => {
  const client = actualClient();
  const recipient = wallet(1), mint = wallet(8), content = wallet(10), node = wallet(11);
  const epoch = client.pdas.epoch(node, mint, RevenueKind.Tip, 0n)[0];
  const asset = client.pdas.asset(mint)[0], vault = client.pdas.vault(asset)[0];
  const leaf = client.pdas.leaf(epoch, RightsRole.Origin, recipient)[0];
  const position = client.pdas.position(leaf, recipient)[0], destination = wallet(12);
  const proof = claimProofArgs({ beneficiary: recipient, role: RightsRole.Origin, shareBps: 7000, siblings: [bytes(5), bytes(6)] });
  const claimed = await client.instruction('claimLiquid', [proof, u64BN(MAX_U64)], { recipient, content, epoch, asset, mint, vault, destination, leaf, position, review: null, tokenProgram: TOKEN_PROGRAM, systemProgram: SystemProgram.programId });
  assert.deepEqual(claimed.data, Buffer.concat([actualDiscriminator('claim_liquid'), recipient.toBuffer(), Buffer.from([RightsRole.Origin]), littleU16(7000), littleU32(2), bytes(5), bytes(6), u64LE(MAX_U64)]));
  assert.deepEqual(claimed.keys.map(value => value.pubkey.toBase58()), [recipient, content, epoch, asset, mint, vault, destination, leaf, position, client.program.programId, TOKEN_PROGRAM, SystemProgram.programId].map(value => value.toBase58()));
  assert.equal(claimed.keys[9]!.isSigner, false);
  assert.equal(claimed.keys[9]!.isWritable, false);
});

test('actual generated purchaseAccess ABI flattens economic context with content-scoped receipt', async () => {
  const client = actualClient();
  const buyer = wallet(1), content = wallet(2), node = wallet(3), mint = wallet(4), source = wallet(5);
  const config = client.pdas.config()[0], asset = client.pdas.asset(mint)[0], vault = client.pdas.vault(asset)[0];
  const epoch = client.pdas.epoch(node, mint, RevenueKind.Sale, 0n)[0], receipt = client.pdas.receipt(content, buyer)[0];
  const purchased = await client.instruction('purchaseAccess', [], { buyer,
    economic: { funder: buyer, config, content, node, epoch, asset, mint, source, vault, review: null, tokenProgram: TOKEN_PROGRAM },
    receipt, systemProgram: SystemProgram.programId });
  assert.deepEqual(purchased.data, actualDiscriminator('purchase_access'));
  assert.deepEqual(purchased.keys.map(value => value.pubkey.toBase58()), [buyer, buyer, config, content, node, epoch, asset, mint, source, vault, client.program.programId, TOKEN_PROGRAM, receipt, SystemProgram.programId].map(value => value.toBase58()));
  assert.deepEqual(purchased.keys.map(value => [value.isWritable, value.isSigner]), [
    [true, true], [false, true], [false, false], [true, false], [false, false], [true, false], [true, false],
    [false, false], [true, false], [true, false], [false, false], [false, false], [true, false], [false, false],
  ]);
  const withReview = await client.instruction('purchaseAccess', [], { buyer,
    economic: { funder: buyer, config, content, node, epoch, asset, mint, source, vault, review: wallet(13), tokenProgram: TOKEN_PROGRAM },
    receipt, systemProgram: SystemProgram.programId });
  assert.equal(withReview.keys[10]!.pubkey.toBase58(), wallet(13).toBase58());
});

test('actual generated AccessReceipt state encoding matches verified Rust layout and SDK reader', async () => {
  const client = actualClient();
  const receipt: AccessReceiptAccount = { version: 1, content: wallet(1), buyer: wallet(2), purchaseNode: wallet(3), amount: u64BN(MAX_U64), mint: wallet(4), createdAt: u64BN(172800n) };
  const discriminator = actualIdl.accounts!.find(value => value.name === 'AccessReceipt')!.discriminator;
  const encoded = await client.program.coder.accounts.encode('accessReceipt', receipt);
  assert.deepEqual(encoded, Buffer.concat([Buffer.from(discriminator), Buffer.from([1]), receipt.content.toBuffer(), receipt.buyer.toBuffer(), receipt.purchaseNode.toBuffer(), u64LE(MAX_U64), receipt.mint.toBuffer(), u64LE(172800n)]));
  assert.equal(encoded.length, 153);
  assert.equal(encoded.readBigUInt64LE(105), MAX_U64);
  const decoded = client.program.coder.accounts.decode('accessReceipt', encoded) as AccessReceiptAccount;
  assert.equal(decoded.content.toBase58(), receipt.content.toBase58());
  assert.equal(decoded.buyer.toBase58(), receipt.buyer.toBase58());
  assert.equal(decoded.purchaseNode.toBase58(), receipt.purchaseNode.toBase58());
  assert.equal(decoded.amount.toString(), MAX_U64.toString());
  assert.equal(decoded.createdAt.toString(), '172800');
  const receiptAddress = client.pdas.receipt(receipt.content, receipt.buyer)[0];
  client.program.provider.connection.getAccountInfo = async address => {
    assert.equal(address.toBase58(), receiptAddress.toBase58());
    return { executable: false, owner: client.program.programId, data: encoded, lamports: 1 };
  };
  assert.equal(await client.hasAccess(receipt.content, receipt.buyer), true);
});

test('actual generated DistributionNode state has independent roots and no plaintext parent field', async () => {
  const client = actualClient();
  const node: DistributionNodeAccount = { version: 1, content: wallet(1), creator: wallet(2), tipPayoutRoot: Array.from(bytes(3)), salePayoutRoot: Array.from(bytes(4)),
    tipChildBps: 3000, saleChildBps: 2000, tipResidualBps: 1200, saleResidualBps: 1000, provenanceCommitment: Array.from(bytes(5)), nextEpoch: u64BN(MAX_U64) };
  const discriminator = actualIdl.accounts!.find(value => value.name === 'DistributionNode')!.discriminator;
  const encoded = await client.program.coder.accounts.encode('distributionNode', node);
  assert.deepEqual(encoded, Buffer.concat([Buffer.from(discriminator), Buffer.from([1]), node.content.toBuffer(), node.creator.toBuffer(), bytes(3), bytes(4), littleU16(3000), littleU16(2000), littleU16(1200), littleU16(1000), bytes(5), u64LE(MAX_U64)]));
  assert.equal(encoded.length, 185);
  assert.equal(encoded.readUInt16LE(137), 3000);
  assert.equal(encoded.readUInt16LE(139), 2000);
  assert.equal(encoded.readBigUInt64LE(177), MAX_U64);
  const decoded = client.program.coder.accounts.decode('distributionNode', encoded) as DistributionNodeAccount;
  assert.deepEqual(decoded.tipPayoutRoot, node.tipPayoutRoot);
  assert.deepEqual(decoded.salePayoutRoot, node.salePayoutRoot);
  assert.deepEqual(decoded.provenanceCommitment, node.provenanceCommitment);
  assert.equal(decoded.nextEpoch.toString(), MAX_U64.toString());
  const nodeDefinition = actualIdl.types!.find(value => value.name === 'DistributionNode')!;
  assert.equal(nodeDefinition.type.kind, 'struct');
  assert.equal(JSON.stringify(nodeDefinition).toLowerCase().includes('parent'), false);
  assert.equal('parent' in decoded, false);
});
