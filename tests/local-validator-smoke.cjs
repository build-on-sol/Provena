// Manual R6 integration gate. Run only inside the isolated deployment copy:
// node tests/local-validator-smoke.cjs
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { createPrivateKey, sign, randomBytes } = require('node:crypto');
const { AnchorProvider, Program, Wallet, BN } = require('@coral-xyz/anchor');
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } = require('@solana/web3.js');
const { createProtocolClient, submitContentArgs, claimProofArgs } = require('../dist/packages/protocol-sdk/src');
const { createServiceApp } = require('../dist/services/server');
const { LocalStore } = require('../dist/services/store');
const { RpcNodeReader, RpcReceiptVerifier, finalizedAccountReader } = require('../dist/services/chain');
const { requestMessage } = require('../dist/services/auth');
const { decryptBlob } = require('../dist/services/content-service');

const root = resolve(__dirname, '..');
const rpc = 'http://127.0.0.1:8899';
const tokenPrograms = [
  ['SPL', new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')],
  ['Token-2022', new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')],
];
const key = role => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(root, 'target/local-authorities', role + '.json'), 'utf8'))));
const privateKey = wallet => createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(wallet.secretKey).subarray(0, 32)]), type: 'pkcs8', format: 'der' });
const u64 = amount => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(amount)); return bytes; };
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });

async function main() {
  assert.match(root, /audit[^/]*.*(?:copy|isolated)/, 'Use the isolated audit deployment copy, not the source checkout');
  const admin = key('admin'), originality = key('originality'), rights = key('rights'), treasury = key('treasury');
  assert.equal(new Set([admin, originality, rights, treasury].map(k => k.publicKey.toBase58())).size, 4);
  const connection = new Connection(rpc, 'confirmed');
  const idl = JSON.parse(readFileSync(join(root, 'idl/content_rights_protocol.json'), 'utf8'));
  const program = new Program(idl, new AnchorProvider(connection, new Wallet(admin), { commitment: 'confirmed' }));
  const client = createProtocolClient(idl, program.provider), pdas = client.pdas;
  const config = pdas.config()[0];
  const state = await program.account.protocolConfig.fetch(config);
  for (const [field, role] of [['admin', admin], ['originalityAuthority', originality], ['rightsAuthority', rights], ['treasury', treasury]]) assert(state[field].equals(role.publicKey));
  const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
  const deployed = await connection.getAccountInfo(program.programId);
  assert(deployed?.executable && deployed.owner.equals(loader));
  const programData = PublicKey.findProgramAddressSync([program.programId.toBuffer()], loader)[0];
  const data = await connection.getAccountInfo(programData);
  assert(data?.owner.equals(loader));
  assert.equal(data.data.readUInt32LE(0), 3);
  assert.equal(data.data[12], 1);
  assert(new PublicKey(data.data.subarray(13, 45)).equals(admin.publicKey));
  console.log(JSON.stringify({ gate: 'loader-and-roles', result: 'PASS', rpc, programId: program.programId.toBase58(), programData: programData.toBase58() }));

  const author = Keypair.generate(), buyer = Keypair.generate(), outsider = Keypair.generate();
  async function finalized(signature) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const status = (await connection.getSignatureStatuses([signature])).value[0];
      if (status?.err) throw new Error('Transaction failed: ' + JSON.stringify(status.err));
      if (status?.confirmationStatus === 'finalized') return;
      await new Promise(done => setTimeout(done, 300));
    }
    throw new Error('Finality timeout for ' + signature);
  }
  async function send(instructions, signers = []) {
    return program.provider.sendAndConfirm(new Transaction().add(...instructions), signers, { commitment: 'confirmed' });
  }
  for (const wallet of [author, buyer]) {
    const signature = await connection.requestAirdrop(wallet.publicKey, 2_000_000_000);
    await finalized(signature);
  }
  const store = await LocalStore.open(join(root, 'target/local-smoke-store.json'));
  const reader = finalizedAccountReader(connection), nodeReader = new RpcNodeReader(reader, program.programId);
  const app = createServiceApp({ store, programId: program.programId, nodeReader, contentIdentityReader: nodeReader,
    receiptVerifier: new RpcReceiptVerifier(reader, program.programId), encryptionMasterKey: randomBytes(32) });
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  const serviceUrl = 'http://127.0.0.1:' + app.server.address().port;
  async function request(wallet, path, payload) {
    const signed = { wallet: wallet.publicKey.toBase58(), nonce: randomBytes(16).toString('hex'), timestamp: Date.now(), payload };
    signed.signature = sign(null, requestMessage('POST', path, signed), privateKey(wallet)).toString('base64');
    const response = await fetch(serviceUrl + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signed) });
    return { status: response.status, body: await response.json() };
  }
  async function tokenBalance(account) { return BigInt((await connection.getTokenAccountBalance(account)).value.amount); }
  const signatures = [];
  try {
    for (const [label, tokenProgram] of tokenPrograms) {
      const mint = Keypair.generate(), funding = Keypair.generate(), destination = Keypair.generate();
      const mintRent = await connection.getMinimumBalanceForRentExemption(82);
      const accountRent = await connection.getMinimumBalanceForRentExemption(165);
      // Exact packed base SPL instructions from the locked spl-token 8 source;
      // the common opcodes are supported by both approved plain token programs.
      await send([
        SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: mint.publicKey, lamports: mintRent, space: 82, programId: tokenProgram }),
        new TransactionInstruction({ programId: tokenProgram, keys: [meta(mint.publicKey, true)], data: Buffer.concat([Buffer.from([20, 0]), admin.publicKey.toBuffer(), Buffer.from([0])]) }),
      ], [mint]);
      for (const [account, owner] of [[funding, buyer], [destination, author]]) {
        await send([
          SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: account.publicKey, lamports: accountRent, space: 165, programId: tokenProgram }),
          new TransactionInstruction({ programId: tokenProgram, keys: [meta(account.publicKey, true), meta(mint.publicKey)], data: Buffer.concat([Buffer.from([18]), owner.publicKey.toBuffer()]) }),
        ], [account]);
      }
      await send([new TransactionInstruction({ programId: tokenProgram, keys: [meta(mint.publicKey, true), meta(funding.publicKey, true), meta(admin.publicKey, false, true)], data: Buffer.concat([Buffer.from([7]), u64(1000)]) })]);
      const asset = pdas.asset(mint.publicKey)[0], vault = pdas.vault(asset)[0];
      await send([await client.instruction('addAssetPolicy', [], { admin: admin.publicKey, config, asset, mint: mint.publicKey, vault, tokenProgram, systemProgram: SystemProgram.programId })]);
      for (const paid of [false, true]) {
        const body = `Isolated audit ${program.programId.toBase58()} ${label} ${paid ? 'paid' : 'public'}`;
        const staged = await request(author, '/content', { body, mode: paid ? 'PAID' : 'PUBLIC', title: `${label} smoke` });
        assert.equal(staged.status, 200);
        const artifact = staged.body.artifact;
        const content = new PublicKey(artifact.id), node = pdas.originalNode(content)[0];
        const submitArgs = submitContentArgs({ ...artifact, citationManifestCommitment: artifact.citationManifest.commitment,
          mode: paid ? 1 : 0, quotePolicy: paid ? 0 : 2, price: paid ? 100n : 0n, priceMint: paid ? mint.publicKey : PublicKey.default });
        const signature = await send([
          await client.instruction('submitContent', [submitArgs], { author: author.publicKey, originality: originality.publicKey, config, content, fingerprint: pdas.fingerprint(artifact.canonicalHash)[0], systemProgram: SystemProgram.programId }),
          await client.instruction('approveOriginal', [], { config, originality: originality.publicKey, content }),
          await client.instruction('createOriginalNode', [3000, 3000], { author: author.publicKey, content, node, systemProgram: SystemProgram.programId }),
        ], [author, originality]);
        await finalized(signature);
        const confirmed = await request(author, '/content/confirm', { content: content.toBase58() });
        assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
        assert.equal(confirmed.body.artifact.lifecycle, 'CONFIRMED');
        assert.equal((await request(author, '/provenance/register-original', { node: node.toBase58() })).status, 200);
        const kind = paid ? 1 : 0, epoch = pdas.epoch(node, mint.publicKey, kind, 0n)[0];
        await finalized(await send([await client.instruction('openRevenueEpoch', [kind, new BN(0)], { payer: admin.publicKey, content, node, mint: mint.publicKey, epoch, systemProgram: SystemProgram.programId })]));
        const valueEvent = { epoch: epoch.toBase58(), nonce: '0' };
        assert.equal((await request(author, '/provenance/reveal', { node: node.toBase58(), valueEvent })).status, 403);
        const ownProof = await request(author, '/provenance/proof', { node: node.toBase58(), kind });
        assert.equal(ownProof.status, 200);
        assert.equal(ownProof.body.leaves.length, 1);
        const economic = { funder: buyer.publicKey, config, content, node, epoch, asset, mint: mint.publicKey, source: funding.publicKey, vault, review: null, tokenProgram };
        const receipt = pdas.receipt(content, buyer.publicKey)[0];
        const depositIx = await client.instruction(paid ? 'purchaseAccess' : 'tip', paid ? [] : [new BN(100)], paid ? { buyer: buyer.publicKey, economic, receipt, systemProgram: SystemProgram.programId } : economic);
        const received = await send([depositIx], [buyer]);
        assert.equal(await tokenBalance(vault), 100n);
        await finalized(received);
        assert.equal((await request(author, '/provenance/reveal', { node: node.toBase58(), valueEvent })).status, 200);
        if (paid) {
          await assert.rejects(send([depositIx], [buyer]));
          assert.equal(await tokenBalance(vault), 100n);
          await finalized(received);
          const receiptState = await program.account.accessReceipt.fetch(receipt);
          assert(receiptState.content.equals(content) && receiptState.buyer.equals(buyer.publicKey) && receiptState.purchaseNode.equals(node));
          const released = await request(buyer, '/paid-key', { content: content.toBase58() });
          assert.equal(released.status, 200, JSON.stringify(released.body));
          assert.equal(decryptBlob(artifact.blob, Buffer.from(released.body.key, 'base64'), released.body.associatedData).toString(), body);
          assert.equal((await request(outsider, '/paid-key', { content: content.toBase58() })).status, 403);
          const { ContentService } = require('../dist/services/content-service');
          const unavailable = new ContentService(store, program.programId, { hasAccess: async () => { throw new Error('Isolated RPC unavailable'); } });
          await assert.rejects(unavailable.releaseKey(content.toBase58(), buyer.publicKey.toBase58()), error => error.code === 'AccessVerifierUnavailable');
        }
        const proof = claimProofArgs({ beneficiary: author.publicKey, role: 0, shareBps: 10000, siblings: [] });
        const leaf = pdas.leaf(epoch, 0, author.publicKey)[0], position = pdas.position(leaf, author.publicKey)[0];
        const claimIx = await client.instruction('claimLiquid', [proof, new BN(100)], { recipient: author.publicKey, content, epoch, asset, mint: mint.publicKey, vault, destination: destination.publicKey, leaf, position, review: null, tokenProgram, systemProgram: SystemProgram.programId });
        const claimed = await send([claimIx], [author]);
        await assert.rejects(send([claimIx], [author]));
        const revenue = await program.account.revenueEpoch.fetch(epoch), policy = await program.account.assetPolicy.fetch(asset);
        assert.equal(revenue.gross.toString(), '100'); assert.equal(revenue.paid.toString(), '100'); assert.equal(revenue.fees.toString(), '0');
        assert.equal(policy.userLiability.toString(), '0'); assert.equal(policy.earnedFees.toString(), '0');
        assert.equal(await tokenBalance(vault), 0n);
        assert.equal(await tokenBalance(funding.publicKey), paid ? 800n : 900n);
        assert.equal(await tokenBalance(destination.publicKey), paid ? 200n : 100n);
        signatures.push(claimed);
        console.log(JSON.stringify({ gate: `${label}-${paid ? 'purchase-receipt-key-release' : 'tip'}-claim`, result: 'PASS', gross: '100', paid: '100', fees: '0', userLiability: '0', signature: claimed }));
      }
    }
    for (const signature of signatures) await finalized(signature);
    console.log(JSON.stringify({ result: 'PASS', paths: 4, receiptAllowDeny: 2, scope: 'isolated-loopback-only' }));
  } finally { await new Promise(done => app.server.close(done)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
