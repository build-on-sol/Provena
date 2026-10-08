import { Connection, PublicKey } from '@solana/web3.js';
import { BorshCoder, Idl } from '@coral-xyz/anchor';
import { LocalStore, requireCondition, ServiceError } from '../store';

const fields: Record<string, readonly string[]> = {
  ContentSubmitted: ['content', 'author', 'rawHash'], ContentApproved: ['content'],
  DistributionNodeCreated: ['content', 'node', 'creator'], RepostPolicyUpdated: ['node', 'tip', 'sale'],
  TipReceived: ['content', 'node', 'mint', 'amount'], AccessPurchased: ['content', 'node', 'buyer', 'mint', 'amount'],
  RevenueClaimed: ['epoch', 'beneficiary', 'amount'], RevenueEnteredSafeguard: ['epoch'],
  SafeguardExitRequested: ['position', 'amount', 'requestedAt'], SafeguardExitClaimable: ['position', 'readyAt'],
  SimilarityCaseOpened: ['case', 'candidate', 'reference', 'cutoff'], SettlementProposed: ['case', 'settlement'],
  SettlementAccepted: ['settlement', 'author'], IndependentConfirmed: ['case'], DerivativeConfirmed: ['case', 'sourceBps'],
};
export interface IndexedEvent { signature: string; slot: number; index: number; name: string; data: Record<string, string>; }
interface ContentProjection { content: string; author: string; status: string; }
export interface CaseProjection { id: string; candidate: string; reference: string; candidateAuthor: string | null; referenceAuthor: string | null; cutoff: string; status: string; }
export interface ReviewMessage { wallet: string; timestamp: number; text: string; evidenceCommitment?: string; signature: string; nonce: string; }
export interface IndexerSyncStatus {
  status: 'NOT_STARTED' | 'SYNCING' | 'SYNCED' | 'ERROR';
  checkpoint: string | null;
  lastSuccessfulPollAt: number | null;
  error: { code: string; signature: string | null } | null;
}
export class EventIndexer {
  private synchronization: Omit<IndexerSyncStatus, 'checkpoint'> = { status: 'NOT_STARTED', lastSuccessfulPollAt: null, error: null };
  constructor(readonly store: LocalStore) {}
  /** A persisted checkpoint alone does not establish synchronization after restart. */
  syncStatus(): IndexerSyncStatus { return { ...structuredClone(this.synchronization), checkpoint: this.store.snapshot().checkpoint }; }
  beginSync(): void { this.synchronization.status = 'SYNCING'; this.synchronization.error = null; }
  completeSync(): void { this.synchronization = { status: 'SYNCED', lastSuccessfulPollAt: Date.now(), error: null }; }
  failSync(error: unknown, signature: string | null): void {
    const code = error instanceof ServiceError ? error.code : (error as { code?: unknown })?.code === -32015 ? 'UnsupportedTransactionVersion' : 'ChainRpcReadFailed';
    this.synchronization.status = 'ERROR'; this.synchronization.error = { code, signature };
  }
  /** Trusted internal ingestion only. No HTTP endpoint accepts financial events. */
  async ingest(events: readonly IndexedEvent[], checkpoint?: string): Promise<void> {
    await this.store.transact(state => {
      for (const event of events) {
        requireCondition(Number.isSafeInteger(event.slot) && event.slot >= 0 && Number.isSafeInteger(event.index) && event.index >= 0 && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(event.signature), 'InvalidChainEvent');
        const allowed = fields[event.name];
        requireCondition(allowed, 'UnknownChainEvent');
        requireCondition(Object.keys(event.data).length === allowed.length && allowed.every(field => typeof event.data[field] === 'string'), 'InvalidChainEventFields');
        const clean = Object.fromEntries(allowed.map(field => [field, event.data[field]!]));
        for (const key of ['content', 'node', 'creator', 'author', 'buyer', 'mint', 'epoch', 'position', 'candidate', 'reference', 'case', 'settlement', 'beneficiary']) {
          if (clean[key] !== undefined) { try { requireCondition(new PublicKey(clean[key]!).toBase58() === clean[key], 'InvalidEventPublicKey'); } catch { requireCondition(false, 'InvalidEventPublicKey'); } }
        }
        for (const key of ['amount', 'sourceBps', 'tip', 'sale']) if (clean[key] !== undefined) requireCondition(/^(0|[1-9][0-9]*)$/.test(clean[key]!) && BigInt(clean[key]!) <= (1n << 64n) - 1n, 'InvalidEventAmount');
        const id = `${event.signature}:${event.index}`;
        if (!Object.hasOwn(state.events, id)) state.events[id] = { ...event, data: clean };
      }
      if (checkpoint !== undefined) state.checkpoint = checkpoint;
    });
  }
  events(): IndexedEvent[] { return Object.values(this.store.snapshot().events) as IndexedEvent[]; }
  private projection(): { content: Map<string, ContentProjection>; cases: Map<string, CaseProjection> } {
    const content = new Map<string, ContentProjection>(), cases = new Map<string, CaseProjection>();
    for (const event of this.events()) {
      const data = event.data;
      if (event.name === 'ContentSubmitted') content.set(data.content!, { content: data.content!, author: data.author!, status: 'SUBMITTED' });
      if (event.name === 'ContentApproved') { const row = content.get(data.content!); if (row) row.status = 'ORIGINAL'; }
      if (event.name === 'SimilarityCaseOpened') {
        const candidate = content.get(data.candidate!);
        if (candidate) candidate.status = 'PENDING_SIMILARITY';
        cases.set(data.case!, { id: data.case!, candidate: data.candidate!, reference: data.reference!, candidateAuthor: null, referenceAuthor: null, cutoff: data.cutoff!, status: 'PENDING_REVIEW' });
      }
      if (event.name === 'IndependentConfirmed' || event.name === 'DerivativeConfirmed') {
        const similarity = cases.get(data.case!);
        if (similarity) { similarity.status = event.name === 'IndependentConfirmed' ? 'INDEPENDENT' : 'DERIVATIVE'; const candidate = content.get(similarity.candidate); if (candidate) candidate.status = similarity.status; }
      }
    }
    for (const similarity of cases.values()) { similarity.candidateAuthor = content.get(similarity.candidate)?.author ?? null; similarity.referenceAuthor = content.get(similarity.reference)?.author ?? null; }
    return { content, cases };
  }
  feed(): ContentProjection[] { return [...this.projection().content.values()]; }
  metrics(content: string): { likes: number; unlikes: number; views: number; revenueByAsset: Record<string, { tip: string; sale: string }>; paidBeneficiaryCount: null; beneficiaryCountStatus: 'NEEDS_VERIFIED_ENTITLEMENTS'; source: 'FINALIZED_CHAIN_EVENTS_AND_SIGNED_SOCIAL_STATE'; indexerSync: IndexerSyncStatus } {
    const state = this.store.snapshot();
    const reactions = Object.values(state.reactions[content] ?? {});
    const revenue = new Map<string, { tip: bigint; sale: bigint }>();
    for (const event of this.events()) {
      if ((event.name !== 'TipReceived' && event.name !== 'AccessPurchased') || event.data.content !== content) continue;
      const asset = event.data.mint!;
      const current = revenue.get(asset) ?? { tip: 0n, sale: 0n };
      if (event.name === 'TipReceived') current.tip += BigInt(event.data.amount!); else current.sale += BigInt(event.data.amount!);
      revenue.set(asset, current);
    }
    return { likes: reactions.filter(value => value === 'LIKE').length, unlikes: reactions.filter(value => value === 'UNLIKE').length, views: state.views[content] ?? 0, revenueByAsset: Object.fromEntries([...revenue].map(([asset, value]) => [asset, { tip: String(value.tip), sale: String(value.sale) }])), paidBeneficiaryCount: null, beneficiaryCountStatus: 'NEEDS_VERIFIED_ENTITLEMENTS', source: 'FINALIZED_CHAIN_EVENTS_AND_SIGNED_SOCIAL_STATE', indexerSync: this.syncStatus() };
  }
  async react(wallet: string, content: string, value: 'LIKE' | 'UNLIKE' | 'VIEW' | 'CLEAR'): Promise<void> {
    requireCondition(this.projection().content.has(content), 'ChainContentNotIndexed', 404);
    requireCondition(['LIKE', 'UNLIKE', 'VIEW', 'CLEAR'].includes(value), 'InvalidReaction');
    await this.store.transact(state => {
      if (value === 'VIEW') { const count = state.views[content] ?? 0; requireCondition(count < Number.MAX_SAFE_INTEGER, 'MetricsOverflow'); state.views[content] = count + 1; return; }
      const reactions = state.reactions[content] ?? {};
      if (value === 'CLEAR') delete reactions[wallet]; else reactions[wallet] = value;
      state.reactions[content] = reactions;
    });
  }
  creatorReviewList(wallet: string): CaseProjection[] { return [...this.projection().cases.values()].filter(row => row.referenceAuthor === wallet && row.status === 'PENDING_REVIEW'); }
  caseForParticipant(wallet: string, caseId: string): CaseProjection {
    const similarity = this.projection().cases.get(caseId);
    requireCondition(similarity, 'CaseNotIndexed', 404);
    requireCondition(wallet === similarity.candidateAuthor || wallet === similarity.referenceAuthor, 'Unauthorized', 403);
    return similarity;
  }
  async message(wallet: string, caseId: string, message: ReviewMessage): Promise<void> {
    this.caseForParticipant(wallet, caseId);
    requireCondition(message.wallet === wallet && typeof message.text === 'string' && message.text.length > 0 && message.text.length <= 8000 && (message.evidenceCommitment === undefined || /^[0-9a-f]{64}$/.test(message.evidenceCommitment)), 'InvalidReviewMessage');
    await this.store.transact(state => { const messages = state.messages[caseId] ?? []; requireCondition(messages.length < 10_000, 'ThreadCapacityReached', 409); messages.push(message); state.messages[caseId] = messages; });
  }
  thread(wallet: string, caseId: string): { similarity: CaseProjection; messages: readonly ReviewMessage[] } {
    return { similarity: this.caseForParticipant(wallet, caseId), messages: (this.store.snapshot().messages[caseId] ?? []) as ReviewMessage[] };
  }
  claimDashboard(wallet: string): { wallet: string; claimedByEpoch: Record<string, string>; source: 'FINALIZED_CHAIN_EVENTS'; balances: null; instruction: string; indexerSync: IndexerSyncStatus } {
    const amounts = new Map<string, bigint>();
    for (const event of this.events()) if (event.name === 'RevenueClaimed' && event.data.beneficiary === wallet) amounts.set(event.data.epoch!, (amounts.get(event.data.epoch!) ?? 0n) + BigInt(event.data.amount!));
    return { wallet, claimedByEpoch: Object.fromEntries([...amounts].map(([key, value]) => [key, String(value)])), source: 'FINALIZED_CHAIN_EVENTS', balances: null, instruction: 'Read chain RevenueEpoch, LeafPosition and ClaimPosition accounts before constructing a claim; this dashboard cannot authorize withdrawals.', indexerSync: this.syncStatus() };
  }
}
function eventValue(value: unknown): string {
  if (Array.isArray(value)) return Buffer.from(value as number[]).toString('hex');
  requireCondition(value !== null && value !== undefined, 'InvalidChainEventValue');
  return String(value);
}
/** Reads finalized program logs; never submits instructions or decides financial ownership.
 * web3.js 1.99.0 supplies real MessageV1 reads. Anchor's existing Borsh coder
 * decodes events independently of message versions; framing is checked here to
 * retain CPI attribution and reject unknown/truncated logs without losing events.
 */
export class RpcEventPoller {
  private readonly coder: BorshCoder;
  private running: Promise<number> | null = null;
  constructor(private readonly connection: Connection, private readonly programId: PublicKey, idl: Idl, private readonly indexer: EventIndexer) {
    requireCondition(idl.address === programId.toBase58(), 'IdlProgramMismatch');
    this.coder = new BorshCoder(idl);
  }
  async pollOnce(): Promise<number> {
    if (this.running !== null) return this.running;
    this.running = this.poll();
    try { return await this.running; } finally { this.running = null; }
  }
  private async poll(): Promise<number> {
    this.indexer.beginSync();
    let processingSignature: string | null = null;
    try {
      const checkpoint = this.indexer.store.snapshot().checkpoint;
      const signatures: Awaited<ReturnType<Connection['getSignaturesForAddress']>> = [];
      const seen = new Set<string>();
      let before: string | undefined;
      while (true) {
        const page = await this.connection.getSignaturesForAddress(this.programId, { ...(before ? { before } : {}), ...(checkpoint ? { until: checkpoint } : {}), limit: 1000 }, 'finalized');
        for (const signature of page) {
          requireCondition(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature.signature) && Number.isSafeInteger(signature.slot) && signature.slot >= 0, 'InvalidChainSignature', 503);
          // Historical RPCs may omit confirmationStatus; the finalized request
          // remains authoritative. An explicit contradictory status is rejected.
          requireCondition(signature.confirmationStatus == null || signature.confirmationStatus === 'finalized', 'UnfinalizedChainSignature', 503);
          requireCondition(!seen.has(signature.signature) && signature.signature !== before && signature.signature !== checkpoint, 'IndexerPaginationDidNotAdvance', 503);
          seen.add(signature.signature); signatures.push(signature);
        }
        if (page.length < 1000) break;
        before = page[page.length - 1]!.signature;
      }
      for (const signature of [...signatures].reverse()) {
        processingSignature = signature.signature;
        if (signature.err !== null) {
          await this.indexer.ingest([], signature.signature);
          continue;
        }
        const transaction = await this.connection.getTransaction(signature.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 1 });
        requireCondition(transaction !== null && transaction.meta !== null, 'ChainTransactionUnavailable', 503);
        requireCondition(transaction.slot === signature.slot && transaction.transaction.signatures[0] === signature.signature, 'ChainTransactionMismatch', 503);
        requireCondition(transaction.version === undefined || transaction.version === 'legacy' || transaction.version === 0 || transaction.version === 1, 'UnsupportedTransactionVersion', 503);
        if (transaction.meta.err !== null) {
          await this.indexer.ingest([], signature.signature);
          continue;
        }
        requireCondition(Array.isArray(transaction.meta.logMessages), 'ChainTransactionLogsUnavailable', 503);
        const message = transaction.transaction.message;
        const keys = message.getAccountKeys(transaction.meta.loadedAddresses ? { accountKeysFromLookups: transaction.meta.loadedAddresses } : undefined);
        const invoked = new Set<string>();
        for (const instruction of [...message.compiledInstructions, ...(transaction.meta.innerInstructions ?? []).flatMap(group => group.instructions)]) {
          requireCondition(Number.isSafeInteger(instruction.programIdIndex), 'InvalidChainProgramIndex', 503);
          const program = keys.get(instruction.programIdIndex);
          requireCondition(program, 'InvalidChainProgramIndex', 503);
          invoked.add(program.toBase58());
        }
        const events = this.parseLogs(transaction.meta.logMessages, invoked, signature.signature, signature.slot);
        // Events and checkpoint commit atomically. Failed reads, unknown formats,
        // or incomplete logs never discard the unprocessed signature.
        await this.indexer.ingest(events, signature.signature);
      }
      this.indexer.completeSync();
      return signatures.length;
    } catch (error) {
      this.indexer.failSync(error, processingSignature);
      throw error;
    }
  }
  private parseLogs(logs: readonly string[], invoked: ReadonlySet<string>, signature: string, slot: number): IndexedEvent[] {
    const frames: Array<{ program: string; events: IndexedEvent[] }> = [];
    const committed: IndexedEvent[] = [];
    let index = 0;
    let sawProtocol = false;
    for (const log of logs) {
      const invoke = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/.exec(log);
      if (invoke) {
        const program = invoke[1]!;
        requireCondition(Number(invoke[2]) === frames.length + 1 && invoked.has(program), 'InvalidChainInvocation', 503);
        sawProtocol ||= program === this.programId.toBase58();
        frames.push({ program, events: [] });
        continue;
      }
      const finish = /^Program ([1-9A-HJ-NP-Za-km-z]+) (success|failed:.*)$/.exec(log);
      if (finish) {
        const frame = frames.pop();
        requireCondition(frame && frame.program === finish[1], 'InvalidChainLogStack', 503);
        if (finish[2] === 'success') (frames[frames.length - 1]?.events ?? committed).push(...frame.events);
        // A failed CPI can be caught by its caller. Its events (and successful
        // descendants' events) rolled back, even when the full tx succeeded.
        continue;
      }
      if (frames[frames.length - 1]?.program !== this.programId.toBase58()) continue;
      const encoded = log.startsWith('Program data: ') ? log.slice('Program data: '.length) : log.startsWith('Program log: ') ? log.slice('Program log: '.length) : null;
      if (encoded === null) continue;
      const event = this.coder.events.decode(encoded);
      requireCondition(event !== null || !log.startsWith('Program data: '), 'UnknownChainEvent', 503);
      if (event === null) continue; // Normal msg! text is not an Anchor event.
      const name = Object.keys(fields).find(name => name.toLowerCase() === event.name.toLowerCase());
      requireCondition(name, 'UnknownChainEvent', 503);
      const data = event.data as Record<string, unknown>;
      const values = Object.fromEntries(fields[name]!.map(field => [field, eventValue(data[field] ?? data[field.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)])]));
      frames[frames.length - 1]!.events.push({ signature, slot, index: index++, name, data: values });
    }
    requireCondition(frames.length === 0 && (!invoked.has(this.programId.toBase58()) || sawProtocol), 'IncompleteChainLogs', 503);
    return committed;
  }
}
