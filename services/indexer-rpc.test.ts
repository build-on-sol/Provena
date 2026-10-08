import test, { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BN, BorshCoder, Idl, utils } from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';
import { EventIndexer, RpcEventPoller } from './indexer';
import { LocalStore } from './store';

const PROGRAM = new PublicKey('Fg6PaFpoGXkYsidMpWxTWqkZ86H8vFnafnHCW3Yj6nD');
const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const content = key(1), node = key(2), mint = key(3), payer = key(4), foreign = key(5);
const signature = (n: number) => { const value = Buffer.alloc(64); value.writeUInt32LE(n); value.fill(17, 4); return utils.bytes.bs58.encode(value); };
interface RawTransaction {
  slot: number; version: 'legacy' | number;
  transaction: { signatures: string[]; message: Record<string, unknown> };
  meta: { err: unknown; logMessages: string[] | null; fee: number; preBalances: number[]; postBalances: number[]; innerInstructions: Array<{ index: number; instructions: Array<{ programIdIndex: number; accounts: number[]; data: string; stackHeight: number }> }>; loadedAddresses: { writable: string[]; readonly: string[] } };
}
interface SignatureInfo { signature: string; slot: number; err: unknown; memo: null; blockTime: null; confirmationStatus: 'finalized' | 'confirmed'; }
interface RpcCall { method: string; params: unknown[]; }
interface SyncStatus { status: 'NOT_STARTED' | 'SYNCING' | 'SYNCED' | 'ERROR'; checkpoint: string | null; lastSuccessfulPollAt: number | null; error: { code: string; signature: string | null } | null; }
function sync(indexer: EventIndexer): SyncStatus { return (indexer as unknown as { syncStatus(): SyncStatus }).syncStatus(); }
function rawTransaction(n: number, version: 'legacy' | number, logs: string[], program = PROGRAM): RawTransaction {
  const message: Record<string, unknown> = { header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
    accountKeys: [payer.toBase58(), PROGRAM.toBase58(), foreign.toBase58()], recentBlockhash: key(6).toBase58(),
    instructions: [{ programIdIndex: program.equals(PROGRAM) ? 1 : 2, accounts: [], data: '1', stackHeight: 1 }] };
  if (version === 0) message.addressTableLookups = [];
  // Official RPC v1 shape: transactionConfig is required, ALTs are absent.
  if (version === 1) message.transactionConfig = { computeUnitLimit: 200000, heapSize: null, loadedAccountsDataSizeLimit: 64000000, priorityFee: null };
  return { slot: n, version, transaction: { signatures: [signature(n)], message },
    meta: { err: null, logMessages: logs, fee: 5000, preBalances: [100000, 1, 1], postBalances: [95000, 1, 1], innerInstructions: [], loadedAddresses: { writable: [], readonly: [] } } };
}
class RpcFixture {
  readonly rows: SignatureInfo[] = [];
  readonly transactions = new Map<string, RawTransaction>();
  readonly calls: RpcCall[] = [];
  readonly temporaryErrors = new Map<string, number>();
  readonly connection: Connection;
  constructor() {
    this.connection = new Connection('http://127.0.0.1:8899', { commitment: 'finalized', fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { id: string; method: string; params: unknown[] };
      this.calls.push({ method: request.method, params: request.params });
      let result: unknown;
      let error: { code: number; message: string } | undefined;
      if (request.method === 'getSignaturesForAddress') {
        assert.equal(request.params[0], PROGRAM.toBase58());
        const options = request.params[1] as { commitment: string; before?: string; until?: string; limit: number };
        assert.equal(options.commitment, 'finalized');
        assert.equal(options.limit, 1000);
        const newest = [...this.rows].reverse();
        const before = options.before === undefined ? 0 : newest.findIndex(row => row.signature === options.before) + 1;
        const untilIndex = options.until === undefined ? newest.length : newest.findIndex(row => row.signature === options.until);
        const until = untilIndex < 0 ? newest.length : untilIndex;
        result = newest.slice(before, until).slice(0, options.limit);
      } else if (request.method === 'getTransaction') {
        const requested = request.params[0] as string;
        const options = request.params[1] as { commitment: string; maxSupportedTransactionVersion: number };
        assert.equal(options.commitment, 'finalized');
        const transaction = this.transactions.get(requested);
        const failures = this.temporaryErrors.get(requested) ?? 0;
        if (failures > 0) { this.temporaryErrors.set(requested, failures - 1); error = { code: -32005, message: 'Temporary RPC unavailable' }; }
        else if (transaction && typeof transaction.version === 'number' && transaction.version > options.maxSupportedTransactionVersion) error = { code: -32015, message: `Transaction version (${transaction.version}) is not supported by the requesting client` };
        else result = transaction ?? null;
      } else throw new Error(`Unexpected read-only RPC method:${request.method}`);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(error ? { error } : { result }) }), { status: 200, headers: { 'content-type': 'application/json' } });
    } });
  }
  add(transaction: RawTransaction, signatureError: unknown = transaction.meta.err): void {
    const sig = transaction.transaction.signatures[0]!;
    this.transactions.set(sig, transaction);
    this.rows.push({ signature: sig, slot: transaction.slot, err: signatureError, memo: null, blockTime: null, confirmationStatus: 'finalized' });
  }
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'provena-indexer-r3-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'store.json');
  const store = await LocalStore.open(path), indexer = new EventIndexer(store);
  const idl = JSON.parse(await readFile(join(process.cwd(), 'idl/content_rights_protocol.json'), 'utf8')) as Idl;
  const coder = new BorshCoder(idl), rpc = new RpcFixture();
  const event = (amount: number) => {
    const descriptor = idl.events!.find(value => value.name === 'TipReceived')!;
    return `Program data: ${Buffer.concat([Buffer.from(descriptor.discriminator), coder.types.encode('TipReceived', { content, node, mint, amount: new BN(amount) })]).toString('base64')}`;
  };
  const logs = (amount: number) => [`Program ${PROGRAM} invoke [1]`, 'Program log: Instruction: Tip', event(amount), `Program ${PROGRAM} success`];
  return { path, store, indexer, idl, rpc, event, logs, poller: new RpcEventPoller(rpc.connection, PROGRAM, idl, indexer) };
}

test('real RPC/client decodes legacy, v0 and v1 and indexes events before and after v1 once', async t => {
  const { rpc, poller, indexer, logs } = await fixture(t);
  for (const [n, version] of [[1, 'legacy'], [2, 0], [3, 1], [4, 0], [5, 'legacy']] as const) rpc.add(rawTransaction(n, version, logs(10)));
  assert.equal(await poller.pollOnce(), 5);
  assert.equal(indexer.events().length, 5);
  assert.deepEqual(indexer.metrics(content.toBase58()).revenueByAsset[mint.toBase58()], { tip: '50', sale: '0' });
  assert.equal(sync(indexer).status, 'SYNCED');
  assert.equal(sync(indexer).checkpoint, signature(5));
  const v1 = await rpc.connection.getTransaction(signature(3), { commitment: 'finalized', maxSupportedTransactionVersion: 1 });
  assert.equal(v1!.version, 1);
  assert.equal(v1!.transaction.message.version, 1);
  assert.equal(await poller.pollOnce(), 0);
  assert.equal(indexer.events().length, 5);
});
test('real RPC/client continues decoding legacy and v0 independently', async t => {
  const { rpc, logs } = await fixture(t);
  rpc.add(rawTransaction(1, 'legacy', logs(1))); rpc.add(rawTransaction(2, 0, logs(1)));
  assert.equal((await rpc.connection.getTransaction(signature(1), { commitment: 'finalized', maxSupportedTransactionVersion: 1 }))!.transaction.message.version, 'legacy');
  assert.equal((await rpc.connection.getTransaction(signature(2), { commitment: 'finalized', maxSupportedTransactionVersion: 1 }))!.transaction.message.version, 0);
});
test('v0 loaded address tables resolve the actual protocol invocation', async t => {
  const { rpc, poller, indexer, logs } = await fixture(t);
  const transaction = rawTransaction(1, 0, logs(10));
  transaction.transaction.message.accountKeys = [payer.toBase58(), foreign.toBase58()];
  transaction.transaction.message.instructions = [{ programIdIndex: 2, accounts: [], data: '1', stackHeight: 1 }];
  transaction.transaction.message.addressTableLookups = [{ accountKey: key(7).toBase58(), writableIndexes: [], readonlyIndexes: [0] }];
  transaction.meta.loadedAddresses.readonly = [PROGRAM.toBase58()];
  rpc.add(transaction);
  assert.equal(await poller.pollOnce(), 1);
  assert.equal(indexer.events().length, 1);
  assert.equal(indexer.metrics(content.toBase58()).revenueByAsset[mint.toBase58()]!.tip, '10');
  assert.equal(sync(indexer).checkpoint, signature(1));
});
test('failed finalized transactions and reference-only foreign logs advance checkpoint without inventing revenue', async t => {
  const { rpc, poller, indexer, event, logs } = await fixture(t);
  rpc.add(rawTransaction(1, 'legacy', logs(10)));
  rpc.add(rawTransaction(2, 1, [`Program ${foreign} invoke [1]`, `Program log: Program ${PROGRAM} invoke [1]`, event(999999), `Program ${foreign} success`], foreign));
  const failed = rawTransaction(3, 0, logs(100000)); failed.meta.err = { InstructionError: [0, { Custom: 1 }] }; rpc.add(failed);
  const failedMeta = rawTransaction(4, 'legacy', logs(100000)); failedMeta.meta.err = { InstructionError: [0, { Custom: 1 }] }; rpc.add(failedMeta, null);
  assert.equal(await poller.pollOnce(), 4);
  assert.equal(indexer.events().length, 1);
  assert.equal(sync(indexer).checkpoint, signature(4));
  assert.equal(await poller.pollOnce(), 0);
  assert.equal(indexer.metrics(content.toBase58()).revenueByAsset[mint.toBase58()]!.tip, '10');
});
test('temporary RPC error preserves earlier checkpoint, exposes incomplete sync and recovers after restart', async t => {
  const { rpc, poller, indexer, logs, path, idl } = await fixture(t);
  for (let n = 1; n <= 3; n++) rpc.add(rawTransaction(n, n === 2 ? 1 : 0, logs(10)));
  rpc.temporaryErrors.set(signature(2), 1);
  await assert.rejects(poller.pollOnce(), /Temporary RPC unavailable/);
  assert.equal(indexer.store.snapshot().checkpoint, signature(1));
  assert.equal(indexer.events().length, 1);
  assert.equal(sync(indexer).status, 'ERROR');
  assert.equal(sync(indexer).error!.signature, signature(2));
  assert.equal(indexer.metrics(content.toBase58()).indexerSync.status, 'ERROR');
  assert.equal(indexer.claimDashboard(payer.toBase58()).indexerSync.status, 'ERROR');
  assert.equal(rpc.calls.some(call => call.method === 'getTransaction' && call.params[0] === signature(3)), false);
  const restarted = new EventIndexer(await LocalStore.open(path));
  assert.equal(sync(restarted).status, 'NOT_STARTED');
  const recovery = new RpcEventPoller(rpc.connection, PROGRAM, idl, restarted);
  assert.equal(await recovery.pollOnce(), 2);
  assert.equal(restarted.events().length, 3);
  assert.equal(sync(restarted).status, 'SYNCED');
  assert.equal(sync(restarted).error, null);
  assert.equal(restarted.metrics(content.toBase58()).revenueByAsset[mint.toBase58()]!.tip, '30');
  // Replay backfill of already recorded signatures must remain financially idempotent.
  await restarted.store.transact(state => { state.checkpoint = null; });
  assert.equal(await recovery.pollOnce(), 3);
  assert.equal(restarted.events().length, 3);
  assert.equal(restarted.metrics(content.toBase58()).revenueByAsset[mint.toBase58()]!.tip, '30');
});
test('pagination processes the oldest page first and restart resumes durable finalized checkpoint', async t => {
  const { rpc, poller, indexer, logs, path, idl } = await fixture(t);
  for (let n = 1; n <= 1002; n++) rpc.add(rawTransaction(n, n === 501 ? 1 : 0, [1, 501, 1002].includes(n) ? logs(10) : [`Program ${foreign} invoke [1]`, `Program ${foreign} success`], [1, 501, 1002].includes(n) ? PROGRAM : foreign));
  assert.equal(await poller.pollOnce(), 1002);
  assert.equal(indexer.store.snapshot().checkpoint, signature(1002));
  assert.equal(indexer.events().length, 3);
  const pages = rpc.calls.filter(call => call.method === 'getSignaturesForAddress');
  assert.equal(pages.length, 2);
  assert.equal((pages[1]!.params[1] as { before: string }).before, signature(3));
  const restarted = new EventIndexer(await LocalStore.open(path));
  assert.equal(await new RpcEventPoller(rpc.connection, PROGRAM, idl, restarted).pollOnce(), 0);
  assert.equal(restarted.events().length, 3);
});
test('unsupported future version blocks progress explicitly and never labels partial projection synchronized', async t => {
  const { rpc, poller, indexer, logs } = await fixture(t);
  rpc.add(rawTransaction(1, 0, logs(10))); rpc.add(rawTransaction(2, 2, logs(10))); rpc.add(rawTransaction(3, 1, logs(10)));
  await assert.rejects(poller.pollOnce());
  assert.equal(indexer.store.snapshot().checkpoint, signature(1));
  assert.equal(indexer.events().length, 1);
  assert.equal(sync(indexer).status, 'ERROR');
  assert.equal(sync(indexer).error!.code, 'UnsupportedTransactionVersion');
  assert.equal(sync(indexer).error!.signature, signature(2));
  assert.equal(rpc.calls.some(call => call.method === 'getTransaction' && call.params[0] === signature(3)), false);
});
test('unknown program event or incomplete logs fail closed with no transaction checkpoint or partial events', async t => {
  const { rpc, poller, indexer, logs } = await fixture(t);
  const unknown = rawTransaction(1, 0, [`Program ${PROGRAM} invoke [1]`, `Program data: ${Buffer.alloc(32, 255).toString('base64')}`, `Program ${PROGRAM} success`]);
  rpc.add(unknown);
  await assert.rejects(poller.pollOnce(), /UnknownChainEvent/);
  assert.equal(indexer.store.snapshot().checkpoint, null);
  assert.equal(indexer.events().length, 0);
  rpc.transactions.set(signature(1), rawTransaction(1, 0, logs(10).slice(0, -1)));
  await assert.rejects(poller.pollOnce(), /IncompleteChainLogs/);
  assert.equal(indexer.store.snapshot().checkpoint, null);
  assert.equal(indexer.events().length, 0);
});
test('validated invocation context accepts successful protocol CPI but discards foreign and rolled-back CPI events', async t => {
  const { rpc, poller, indexer, event } = await fixture(t);
  const tx = rawTransaction(1, 1, [`Program ${foreign} invoke [1]`, event(999999), `Program ${PROGRAM} invoke [2]`, event(10), `Program ${PROGRAM} success`,
    `Program ${PROGRAM} invoke [2]`, event(999999), `Program ${PROGRAM} failed: custom program error: 0x1`, `Program ${foreign} success`], foreign);
  tx.meta.innerInstructions = [{ index: 0, instructions: [{ programIdIndex: 1, accounts: [], data: '1', stackHeight: 2 }, { programIdIndex: 1, accounts: [], data: '1', stackHeight: 2 }] }];
  rpc.add(tx);
  assert.equal(await poller.pollOnce(), 1);
  assert.equal(indexer.events().length, 1);
  assert.equal(indexer.metrics(content.toBase58()).revenueByAsset[mint.toBase58()]!.tip, '10');
});
test('mismatched signature/slot and nonfinalized response cannot create events', async t => {
  const { rpc, poller, indexer, logs } = await fixture(t);
  rpc.add(rawTransaction(1, 0, logs(10)));
  rpc.transactions.get(signature(1))!.slot = 2;
  await assert.rejects(poller.pollOnce(), /ChainTransactionMismatch/);
  assert.equal(indexer.store.snapshot().checkpoint, null);
  rpc.transactions.get(signature(1))!.slot = 1;
  rpc.transactions.get(signature(1))!.transaction.signatures[0] = signature(2);
  await assert.rejects(poller.pollOnce(), /ChainTransactionMismatch/);
  assert.equal(indexer.events().length, 0);
  rpc.transactions.get(signature(1))!.transaction.signatures[0] = signature(1);
  rpc.rows[0]!.confirmationStatus = 'confirmed';
  await assert.rejects(poller.pollOnce(), /UnfinalizedChainSignature/);
  assert.equal(indexer.store.snapshot().checkpoint, null);
});
test('concurrent poll requests share one execution and do not race a durable checkpoint', async t => {
  const { rpc, poller, indexer, logs } = await fixture(t);
  rpc.add(rawTransaction(1, 0, logs(10)));
  assert.deepEqual(await Promise.all([poller.pollOnce(), poller.pollOnce()]), [1, 1]);
  assert.equal(rpc.calls.filter(call => call.method === 'getTransaction').length, 1);
  assert.equal(indexer.events().length, 1);
  assert.equal(sync(indexer).status, 'SYNCED');
});
