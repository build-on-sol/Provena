import { createServer, IncomingMessage, Server } from 'node:http';
import { createPrivateKey, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import { Idl } from '@coral-xyz/anchor';
import { CitationError, sha256 } from '../packages/canonicalization/src';
import { RevenueKind, RightsMathError } from '../packages/rights-math/src';
import { AuthoritySigner, canonicalJson, Ed25519AuthoritySigner, WalletAuthenticator } from './auth';
import { ContentIdentityReader, DEFAULT_PROGRAM_ID, finalizedAccountReader, NodeReader, RpcNodeReader, RpcReceiptVerifier, ValueEventEvidence } from './chain';
import { ContentService, ReceiptVerifier, SubmitContent } from './content-service';
import { EventIndexer, RpcEventPoller } from './indexer';
import { ProvenanceService } from './provenance-service';
import { LocalStore, requireCondition, ServiceError } from './store';

export interface ServiceOptions {
  store: LocalStore;
  receiptVerifier: ReceiptVerifier;
  nodeReader: NodeReader;
  contentIdentityReader?: ContentIdentityReader;
  programId?: PublicKey;
  encryptionMasterKey?: Buffer;
  rightsAuthority?: AuthoritySigner;
  originalityAuthority?: AuthoritySigner;
  now?: () => number;
}
async function readJson(request: IncomingMessage): Promise<unknown> {
  requireCondition(request.headers['content-type']?.split(';')[0] === 'application/json', 'JsonContentTypeRequired', 415);
  let size = 0;
  const buffers: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.byteLength;
    requireCondition(size <= 1_048_576, 'RequestTooLarge', 413);
    buffers.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(buffers).toString('utf8')); } catch { throw new ServiceError('InvalidJson'); }
}
function object(value: unknown): Record<string, unknown> {
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value), 'InvalidPayload');
  return value as Record<string, unknown>;
}
function string(value: unknown): string { requireCondition(typeof value === 'string', 'InvalidPayload'); return value; }
function valueEvent(value: unknown): ValueEventEvidence | undefined {
  if (value === undefined) return undefined;
  const evidence = object(value);
  return { epoch: string(evidence.epoch), nonce: string(evidence.nonce) };
}
export function createServiceApp(options: ServiceOptions): { server: Server; content: ContentService; provenance: ProvenanceService; indexer: EventIndexer } {
  const programId = options.programId ?? DEFAULT_PROGRAM_ID;
  requireCondition(options.rightsAuthority === undefined || options.originalityAuthority === undefined || options.rightsAuthority.wallet !== options.originalityAuthority.wallet, 'AuthorityRolesMustBeSeparate');
  const content = new ContentService(options.store, programId, options.receiptVerifier, options.encryptionMasterKey, options.now, options.contentIdentityReader);
  const provenance = new ProvenanceService(options.store, options.nodeReader, programId, options.rightsAuthority);
  const indexer = new EventIndexer(options.store);
  const auth = new WalletAuthenticator(options.store, options.now);
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    try {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      let result: unknown;
      if (request.method === 'GET' && path === '/health') result = { status: 'ok', protocol: 'provena-v0', offchainOnly: true, indexerCheckpoint: options.store.snapshot().checkpoint, indexerSync: indexer.syncStatus() };
      else if (request.method === 'GET' && path === '/feed') result = indexer.feed();
      else if (request.method === 'GET' && path.startsWith('/content/')) result = { artifact: content.publicArtifact(path.slice('/content/'.length)), chainState: indexer.feed().find(row => row.content === path.slice('/content/'.length)) ?? null, storageState: 'OFFCHAIN_ARTIFACT' };
      else if (request.method === 'GET' && path.startsWith('/metrics/')) result = indexer.metrics(path.slice('/metrics/'.length));
      else {
        requireCondition(request.method === 'POST', 'RouteNotFound', 404);
        const signed = await auth.authenticate('POST', path, await readJson(request));
        const payload = object(signed.payload);
        switch (path) {
          case '/content': result = { artifact: await content.stage(signed.wallet, payload as unknown as SubmitContent), storageState: 'STAGED_FOR_CHAIN_SUBMISSION' }; break;
          case '/content/confirm': result = { artifact: await content.confirm(signed.wallet, string(payload.content)), storageState: 'CHAIN_CONFIRMED_ARTIFACT' }; break;
          case '/paid-key': result = await content.releaseKey(string(payload.content), signed.wallet); break;
          case '/originality': {
            requireCondition(options.originalityAuthority, 'OriginalityAuthorityUnconfigured', 503);
            const body = string(payload.body);
            requireCondition(Buffer.byteLength(body) <= 500_000, 'RequestTooLarge', 413);
            const risk = content.originalityRisk(body);
            const message = canonicalJson({ domain: 'provena:originality-risk:v1', programId: programId.toBase58(), author: signed.wallet, bodyHash: sha256(body), ...risk });
            result = { risk, auditAttestation: { message, signer: options.originalityAuthority.wallet, signature: await options.originalityAuthority.sign(Buffer.from(message)), transactionCosigningRequired: true } };
            break;
          }
          case '/reactions': await indexer.react(signed.wallet, string(payload.content), string(payload.value) as 'LIKE' | 'UNLIKE' | 'VIEW' | 'CLEAR'); result = indexer.metrics(string(payload.content)); break;
          case '/provenance/register-original': result = await provenance.registerOriginal(signed.wallet, string(payload.node)); break;
          case '/provenance/attest': {
            const policy = object(payload.policy);
            requireCondition(typeof policy.tipRetentionBps === 'number' && typeof policy.saleRetentionBps === 'number', 'InvalidRepostPolicy');
            result = await provenance.attestRepost(signed.wallet, { parent: string(payload.parent), nonce: string(payload.nonce), policy: { tipRetentionBps: policy.tipRetentionBps, saleRetentionBps: policy.saleRetentionBps } });
            break;
          }
          case '/provenance/confirm': await provenance.confirmNode(signed.wallet, string(payload.node)); result = { confirmed: true }; break;
          case '/provenance/reveal': result = await provenance.reveal(signed.wallet, string(payload.node), valueEvent(payload.valueEvent)); break;
          case '/provenance/proof': requireCondition(payload.kind === RevenueKind.Tip || payload.kind === RevenueKind.Sale, 'InvalidRevenueKind'); result = await provenance.payoutProof(signed.wallet, string(payload.node), payload.kind, valueEvent(payload.valueEvent)); break;
          case '/review/messages': {
            const evidenceCommitment = payload.evidenceCommitment === undefined ? {} : { evidenceCommitment: string(payload.evidenceCommitment) };
            await indexer.message(signed.wallet, string(payload.case), { wallet: signed.wallet, timestamp: signed.timestamp, text: string(payload.text), ...evidenceCommitment, signature: signed.signature, nonce: signed.nonce });
            result = { stored: true };
            break;
          }
          case '/review/thread': result = indexer.thread(signed.wallet, string(payload.case)); break;
          case '/creator/review': result = indexer.creatorReviewList(signed.wallet); break;
          case '/dashboard/claims': result = indexer.claimDashboard(signed.wallet); break;
          default: throw new ServiceError('RouteNotFound', 404);
        }
      }
      response.statusCode = 200;
      response.end(JSON.stringify(result));
    } catch (error) {
      const known = error instanceof ServiceError || error instanceof CitationError || error instanceof RightsMathError;
      response.statusCode = error instanceof ServiceError ? error.status : known ? 400 : 500;
      response.end(JSON.stringify({ error: known ? error.code : 'InternalServiceError' }));
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return { server, content, provenance, indexer };
}
async function loadSigner(path: string | undefined): Promise<AuthoritySigner | undefined> {
  if (path === undefined) return undefined;
  const file = await readFile(path, 'utf8');
  // Accept the same Solana 64-byte keypair files used by the SDK setup script.
  let key: Buffer | null = null;
  if (file.trim().startsWith('[')) {
    const bytes: unknown = JSON.parse(file);
    requireCondition(Array.isArray(bytes) && bytes.length === 64 && bytes.every(value => Number.isInteger(value) && value >= 0 && value <= 255), 'InvalidAuthorityKey');
    key = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(bytes as number[]).subarray(0, 32)]);
  }
  return new Ed25519AuthoritySigner(key ? createPrivateKey({ key, type: 'pkcs8', format: 'der' }) : createPrivateKey(file));
}
export async function startLocalService(): Promise<Server> {
  const programId = process.env.PROGRAM_ID ? new PublicKey(process.env.PROGRAM_ID) : DEFAULT_PROGRAM_ID;
  const connection = new Connection(process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899', 'finalized');
  const reader = finalizedAccountReader(connection);
  const store = await LocalStore.open(resolve(process.env.PROVENA_DATA_FILE ?? '.local-data/provena.json'));
  requireCondition(process.env.CONTENT_MASTER_KEY === undefined || /^[0-9a-fA-F]{64}$/.test(process.env.CONTENT_MASTER_KEY), 'InvalidMasterKey');
  const [rightsAuthority, originalityAuthority] = await Promise.all([loadSigner(process.env.RIGHTS_AUTHORITY_KEY), loadSigner(process.env.ORIGINALITY_AUTHORITY_KEY)]);
  const chainReader = new RpcNodeReader(reader, programId);
  const app = createServiceApp({ store, programId, receiptVerifier: new RpcReceiptVerifier(reader, programId), nodeReader: chainReader, contentIdentityReader: chainReader, ...(process.env.CONTENT_MASTER_KEY ? { encryptionMasterKey: Buffer.from(process.env.CONTENT_MASTER_KEY, 'hex') } : {}), rightsAuthority, originalityAuthority });
  const port = Number(process.env.PORT ?? '8787');
  requireCondition(Number.isInteger(port) && port > 0 && port <= 65_535, 'InvalidPort');
  let poller: RpcEventPoller | undefined;
  if (process.env.IDL_PATH) {
    const idl = JSON.parse(await readFile(process.env.IDL_PATH, 'utf8')) as Idl;
    poller = new RpcEventPoller(connection, programId, idl, app.indexer);
  }
  await new Promise<void>((resolveListen, reject) => { app.server.once('error', reject); app.server.listen(port, '127.0.0.1', () => { app.server.off('error', reject); resolveListen(); }); });
  if (poller) {
    const eventPoller = poller;
    let running = false;
    const poll = async () => {
      if (running) return;
      running = true;
      try { await eventPoller.pollOnce(); } catch { process.stderr.write('Finalized event indexing unavailable; no financial state is inferred.\n'); }
      finally { running = false; }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, 10_000);
    app.server.on('close', () => clearInterval(timer));
  }
  process.stdout.write(`Provena local offchain service listening on http://127.0.0.1:${port}; instance ${randomUUID()}\n`);
  return app.server;
}
if (require.main === module) void startLocalService().catch((error: unknown) => { process.stderr.write(`${error instanceof ServiceError ? error.code : 'ServiceStartupFailed'}\n`); process.exitCode = 1; });
