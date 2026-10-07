import { createHash, timingSafeEqual } from 'node:crypto';
import { AnchorProvider, BN, Idl, Program } from '@coral-xyz/anchor';
import { AccountMeta, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { hashContent } from '../../canonicalization/src/index';
import { bytes32, MAX_U64, PublicKeyBytes, RevenueKind, RightsRole } from '../../rights-math/src/index';

export const DEFAULT_PROGRAM_ID = new PublicKey('Fg6PaFpoGXkYsidMpWxTWqkZ86H8vFnafnHCW3Yj6nD');
export type PublicKeyInput = PublicKey | string | Uint8Array;
function pubkey(input: PublicKeyInput): PublicKey {
  if (input instanceof PublicKey) return input;
  return new PublicKey(typeof input === 'string' && /^[0-9a-fA-F]{64}$/.test(input) ? Buffer.from(input, 'hex') : input);
}
function keyBytes(input: PublicKeyInput): Buffer { return pubkey(input).toBuffer(); }
export function u64LE(value: bigint): Buffer {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_U64) throw new RangeError('InvalidU64');
  const result = Buffer.alloc(8); result.writeBigUInt64LE(value); return result;
}
export function u64BN(value: bigint): BN { u64LE(value); return new BN(value.toString(10), 10); }
export function hashArray(hash: PublicKeyBytes): number[] { return Array.from(bytes32(hash)); }
function u8(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) throw new RangeError('InvalidU8');
  return Buffer.from([value]);
}
function kindBytes(kind: RevenueKind): Buffer {
  if (kind !== RevenueKind.Tip && kind !== RevenueKind.Sale) throw new RangeError('InvalidRevenueKind');
  return u8(kind);
}
function roleBytes(role: RightsRole): Buffer {
  if (![RightsRole.Origin, RightsRole.Distributor, RightsRole.LicensedSource].includes(role)) throw new RangeError('InvalidRightsRole');
  return u8(role);
}
export const pdaSeeds = Object.freeze({
  config: (): Buffer[] => [Buffer.from('config')],
  asset: (mint: PublicKeyInput): Buffer[] => [Buffer.from('asset'), keyBytes(mint)],
  vault: (asset: PublicKeyInput): Buffer[] => [Buffer.from('vault'), keyBytes(asset)],
  content: (author: PublicKeyInput, rawHash: PublicKeyBytes): Buffer[] => [Buffer.from('content'), keyBytes(author), bytes32(rawHash)],
  fingerprint: (canonicalHash: PublicKeyBytes): Buffer[] => [Buffer.from('fingerprint'), bytes32(canonicalHash)],
  originalNode: (content: PublicKeyInput): Buffer[] => [Buffer.from('original'), keyBytes(content)],
  repost: (content: PublicKeyInput, creator: PublicKeyInput, nonce: PublicKeyBytes): Buffer[] => [Buffer.from('node'), keyBytes(content), keyBytes(creator), bytes32(nonce)],
  epoch: (node: PublicKeyInput, mint: PublicKeyInput, kind: RevenueKind, nonce: bigint): Buffer[] => [Buffer.from('epoch'), keyBytes(node), keyBytes(mint), kindBytes(kind), u64LE(nonce)],
  case: (content: PublicKeyInput): Buffer[] => [Buffer.from('case'), keyBytes(content)],
  settlement: (similarityCase: PublicKeyInput, nonce: bigint): Buffer[] => [Buffer.from('settlement'), keyBytes(similarityCase), u64LE(nonce)],
  leaf: (epoch: PublicKeyInput, role: RightsRole, beneficiary: PublicKeyInput): Buffer[] => [Buffer.from('leaf'), keyBytes(epoch), roleBytes(role), keyBytes(beneficiary)],
  position: (leaf: PublicKeyInput, recipient: PublicKeyInput): Buffer[] => [Buffer.from('position'), keyBytes(leaf), keyBytes(recipient)],
  receipt: (content: PublicKeyInput, buyer: PublicKeyInput): Buffer[] => [Buffer.from('access'), keyBytes(content), keyBytes(buyer)],
});
export class ProtocolPdas {
  constructor(public readonly programId = DEFAULT_PROGRAM_ID) {}
  derive(seeds: readonly Uint8Array[]): readonly [PublicKey, number] {
    return PublicKey.findProgramAddressSync(seeds.map(seed => Buffer.from(seed)), this.programId);
  }
  config() { return this.derive(pdaSeeds.config()); }
  asset(mint: PublicKeyInput) { return this.derive(pdaSeeds.asset(mint)); }
  vault(asset: PublicKeyInput) { return this.derive(pdaSeeds.vault(asset)); }
  content(author: PublicKeyInput, rawHash: PublicKeyBytes) { return this.derive(pdaSeeds.content(author, rawHash)); }
  fingerprint(canonicalHash: PublicKeyBytes) { return this.derive(pdaSeeds.fingerprint(canonicalHash)); }
  originalNode(content: PublicKeyInput) { return this.derive(pdaSeeds.originalNode(content)); }
  repost(content: PublicKeyInput, creator: PublicKeyInput, nonce: PublicKeyBytes) { return this.derive(pdaSeeds.repost(content, creator, nonce)); }
  epoch(node: PublicKeyInput, mint: PublicKeyInput, kind: RevenueKind, nonce: bigint) { return this.derive(pdaSeeds.epoch(node, mint, kind, nonce)); }
  case(content: PublicKeyInput) { return this.derive(pdaSeeds.case(content)); }
  settlement(similarityCase: PublicKeyInput, nonce: bigint) { return this.derive(pdaSeeds.settlement(similarityCase, nonce)); }
  leaf(epoch: PublicKeyInput, role: RightsRole, beneficiary: PublicKeyInput) { return this.derive(pdaSeeds.leaf(epoch, role, beneficiary)); }
  position(leaf: PublicKeyInput, recipient: PublicKeyInput) { return this.derive(pdaSeeds.position(leaf, recipient)); }
  receipt(content: PublicKeyInput, buyer: PublicKeyInput) { return this.derive(pdaSeeds.receipt(content, buyer)); }
}
export interface ProvenanceReveal {
  readonly node: PublicKeyInput;
  readonly parent: PublicKeyInput;
  readonly parentCommitment: PublicKeyBytes;
  readonly salt: PublicKeyBytes;
  readonly commitment: PublicKeyBytes;
}
export function provenanceCommitment(input: Omit<ProvenanceReveal, 'commitment'>): string {
  return createHash('sha256').update(Buffer.concat([
    Buffer.from('provena:provenance:v1'), keyBytes(input.node), keyBytes(input.parent), bytes32(input.parentCommitment), bytes32(input.salt),
  ])).digest('hex');
}
export function verifyProvenanceReveal(reveal: ProvenanceReveal): boolean {
  try { return timingSafeEqual(bytes32(provenanceCommitment(reveal)), bytes32(reveal.commitment)); } catch { return false; }
}
/** Complete reveals are ordered child -> ancestor, terminating at the original node's zero commitment.
 * The first commitment must match a chain-fetched node account. An optional original
 * node address also binds the terminal link to the authoritative Content account.
 */
export function verifyProvenanceChain(reveals: readonly ProvenanceReveal[], trustedTipCommitment: PublicKeyBytes, expectedOriginalNode?: PublicKeyInput): boolean {
  try {
    if (reveals.length === 0 || !timingSafeEqual(bytes32(reveals[0]!.commitment), bytes32(trustedTipCommitment))) return false;
    const visited = new Set<string>();
    for (let i = 0; i < reveals.length; i++) {
      const reveal = reveals[i]!;
      const node = pubkey(reveal.node).toBase58();
      if (visited.has(node) || !verifyProvenanceReveal(reveal)) return false;
      visited.add(node);
      if (i + 1 < reveals.length && (!pubkey(reveal.parent).equals(pubkey(reveals[i + 1]!.node)) || !timingSafeEqual(bytes32(reveal.parentCommitment), bytes32(reveals[i + 1]!.commitment)))) return false;
    }
    const terminal = reveals[reveals.length - 1]!;
    if (!timingSafeEqual(bytes32(terminal.parentCommitment), Buffer.alloc(32)) || visited.has(pubkey(terminal.parent).toBase58())) return false;
    return expectedOriginalNode === undefined || pubkey(terminal.parent).equals(pubkey(expectedOriginalNode));
  } catch { return false; }
}
export function verifyContentIdentity(body: string, identity: {
  readonly rawHash: PublicKeyBytes; readonly canonicalHash: PublicKeyBytes; readonly canonicalizationVersion: number;
}): boolean {
  try {
    if (identity.canonicalizationVersion !== 1) return false;
    const computed = hashContent(body);
    return timingSafeEqual(bytes32(computed.rawHash), bytes32(identity.rawHash)) && timingSafeEqual(bytes32(computed.canonicalHash), bytes32(identity.canonicalHash));
  } catch { return false; }
}

export type ProtocolInstructionName =
  | 'initializeProtocol' | 'setPaused' | 'addAssetPolicy' | 'updateAssetPolicy' | 'licenseSource' | 'withdrawProtocolFees'
  | 'submitContent' | 'approveOriginal' | 'openSimilarityCase'
  | 'createOriginalNode' | 'createRepostNode' | 'updateRepostPolicy'
  | 'tip' | 'purchaseAccess' | 'claimLiquid' | 'requestSafeguardExit' | 'finalizeExit'
  | 'proposeSettlement' | 'acceptSettlement' | 'confirmIndependent'
  | 'finalizeDerivativeSettlement' | 'transitionDisputeToSafeguard' | 'sweepExpiredClaimWindow'
  | 'openRevenueEpoch';
export interface InstructionAccountsInput {
  readonly [name: string]: PublicKeyInput | null | InstructionAccountsInput;
}
interface EncodedInstructionAccounts { [name: string]: PublicKey | EncodedInstructionAccounts; }
function encodeInstructionAccounts(input: InstructionAccountsInput, programId: PublicKey, ancestors = new Set<object>()): EncodedInstructionAccounts {
  if (ancestors.has(input)) throw new TypeError('CyclicInstructionAccounts');
  ancestors.add(input);
  const result: EncodedInstructionAccounts = Object.create(null) as EncodedInstructionAccounts;
  for (const [name, value] of Object.entries(input)) {
    if (value === null) result[name] = programId; // Anchor optional-account sentinel.
    else if (typeof value === 'string' || value instanceof PublicKey || value instanceof Uint8Array) result[name] = pubkey(value);
    else if (typeof value === 'object' && value !== null && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) result[name] = encodeInstructionAccounts(value, programId, ancestors);
    else throw new TypeError(`InvalidInstructionAccount:${name}`);
  }
  ancestors.delete(input);
  return result;
}
interface InstructionBuilder {
  accountsStrict(accounts: EncodedInstructionAccounts): InstructionBuilder;
  remainingAccounts(accounts: AccountMeta[]): InstructionBuilder;
  instruction(): Promise<TransactionInstruction>;
}
/** Uses the generated IDL as the instruction authority and builds unsigned instructions. */
export class ProtocolClient {
  readonly pdas: ProtocolPdas;
  constructor(public readonly program: Program<Idl>) { this.pdas = new ProtocolPdas(program.programId); }
  async instruction(name: ProtocolInstructionName, args: readonly unknown[], accounts: InstructionAccountsInput, remainingAccounts: readonly AccountMeta[] = []): Promise<TransactionInstruction> {
    const method = this.program.methods[name] as unknown as ((...args: unknown[]) => InstructionBuilder) | undefined;
    if (typeof method !== 'function') throw new Error(`InstructionMissingFromIdl:${name}`);
    const accountKeys = encodeInstructionAccounts(accounts, this.program.programId);
    const builder = method(...args).accountsStrict(accountKeys);
    if (remainingAccounts.length > 0) builder.remainingAccounts([...remainingAccounts]);
    return builder.instruction();
  }
  /** Fetches the content-scoped receipt PDA and validates its recorded owner/content. */
  async hasAccess(content: PublicKeyInput, buyer: PublicKeyInput): Promise<boolean> {
    const [address] = this.pdas.receipt(content, buyer);
    const accounts = this.program.account as unknown as Record<string, { fetchNullable(address: PublicKey): Promise<unknown> }>;
    const namespace = accounts.accessReceipt;
    if (!namespace) throw new Error('AccountMissingFromIdl:accessReceipt');
    // Anchor's fetchNullable checks the discriminator, but not the owning program.
    // Read once so owner/discriminator/fields describe the same RPC account state.
    const account = await this.program.provider.connection.getAccountInfo(address, 'confirmed');
    if (account === null || !account.owner.equals(this.program.programId) || account.executable) return false;
    try {
      const receipt = this.program.coder.accounts.decode('accessReceipt', account.data) as { version: number; content: PublicKey; buyer: PublicKey; amount: BN };
      return receipt.version === 1 && receipt.amount.gt(new BN(0)) && receipt.content.equals(pubkey(content)) && receipt.buyer.equals(pubkey(buyer));
    } catch { return false; }
  }
}
export function createProtocolClient(idl: Idl, provider: AnchorProvider): ProtocolClient {
  return new ProtocolClient(new Program<Idl>(idl, provider));
}

/** Numeric variants match the Anchor V0 account fields; financial amounts decode as BN. */
export enum ContentMode { Public = 0, Paid = 1 }
export enum ContentStatus { Submitted = 0, Original = 1, PendingSimilarity = 2, Independent = 3, Derivative = 4 }
export enum PublicQuotePolicy { None = 0, PreviewOnly = 1, Limited = 2 }
export enum SimilarityCaseStatus { PendingReview = 0, Negotiating = 1, SafeguardMode = 3, Resolved = 4 }
export enum CaseResolution { Unresolved = 0, Independent = 1, Derivative = 2 }
export interface ProtocolConfigAccount { version: number; admin: PublicKey; originalityAuthority: PublicKey; rightsAuthority: PublicKey; treasury: PublicKey; paused: boolean; }
export interface AssetPolicyAccount { version: number; mint: PublicKey; tokenProgram: PublicKey; enabled: boolean; safeguardEnabled: boolean; futureStrategyEnabled: boolean; userLiability: BN; earnedFees: BN; bump: number; }
export interface ContentAccount {
  version: number; author: PublicKey; rawHash: number[]; canonicalHash: number[]; canonicalizationVersion: number;
  metadataCommitment: number[]; storageCommitment: number[]; citationManifestCommitment: number[];
  mode: ContentMode; status: ContentStatus; quotePolicy: PublicQuotePolicy; price: BN; priceMint: PublicKey;
  originalNode: PublicKey; licensedSource: PublicKey; licensedSourceBps: number;
  derivativeSource: PublicKey; derivativeSourceBps: number; createdAt: BN; normalDeadline: BN; activeCase: PublicKey; caseResolved: boolean;
}
/** Plain parent relationships deliberately have no public field. */
export interface DistributionNodeAccount {
  version: number; content: PublicKey; creator: PublicKey; tipPayoutRoot: number[]; salePayoutRoot: number[];
  tipChildBps: number; saleChildBps: number; tipResidualBps: number; saleResidualBps: number;
  provenanceCommitment: number[]; nextEpoch: BN;
}
export interface RevenueEpochAccount {
  version: number; content: PublicKey; node: PublicKey; mint: PublicKey; kind: RevenueKind; payoutRoot: number[];
  gross: BN; paid: BN; fees: BN; openedAt: BN; deadline: BN; postReview: boolean;
}
export interface LeafPositionAccount { version: number; epoch: PublicKey; wallet: PublicKey; role: RightsRole; shareBps: number; paid: BN; finalized: boolean; ownerAllocation: BN; sourceAllocation: BN; source: PublicKey; }
export interface ClaimPositionAccount { version: number; leaf: PublicKey; recipient: PublicKey; paid: BN; exitAmount: BN; exitRequestedAt: BN; automaticExitApplied: boolean; }
export interface AccessReceiptAccount { version: number; content: PublicKey; buyer: PublicKey; purchaseNode: PublicKey; amount: BN; mint: PublicKey; createdAt: BN; }
export interface SimilarityCaseAccount {
  version: number; candidate: PublicKey; reference: PublicKey; candidateAuthor: PublicKey; referenceAuthor: PublicKey;
  evidenceCommitment: number[]; startedAt: BN; cutoff: BN; status: SimilarityCaseStatus; resolution: CaseResolution;
  resolvedAt: BN; sourceBps: number; nextProposal: BN; settlementCommitment: number[];
}
export interface SettlementAccount { version: number; case: PublicKey; sourceBps: number; candidateAccepted: boolean; referenceAccepted: boolean; finalized: boolean; commitment: number[]; }
export interface SubmitContentInput {
  rawHash: PublicKeyBytes; canonicalHash: PublicKeyBytes; canonicalizationVersion: number;
  metadataCommitment: PublicKeyBytes; storageCommitment: PublicKeyBytes; citationManifestCommitment: PublicKeyBytes;
  mode: ContentMode; quotePolicy?: PublicQuotePolicy; price: bigint; priceMint: PublicKeyInput;
}
export function submitContentArgs(input: SubmitContentInput) {
  if (input.canonicalizationVersion !== 1) throw new RangeError('InvalidCanonicalizationVersion');
  if (input.mode !== ContentMode.Public && input.mode !== ContentMode.Paid) throw new RangeError('InvalidContentMode');
  const quotePolicy = input.quotePolicy ?? (input.mode === ContentMode.Paid ? PublicQuotePolicy.None : PublicQuotePolicy.Limited);
  if (![PublicQuotePolicy.None, PublicQuotePolicy.PreviewOnly, PublicQuotePolicy.Limited].includes(quotePolicy)) throw new RangeError('InvalidQuotePolicy');
  return {
    rawHash: hashArray(input.rawHash), canonicalHash: hashArray(input.canonicalHash), canonicalizationVersion: input.canonicalizationVersion,
    metadataCommitment: hashArray(input.metadataCommitment), storageCommitment: hashArray(input.storageCommitment), citationManifestCommitment: hashArray(input.citationManifestCommitment),
    mode: input.mode, quotePolicy, price: u64BN(input.price), priceMint: pubkey(input.priceMint),
  };
}
export interface RepostNodeInput {
  nonce: PublicKeyBytes; tipRoot: PublicKeyBytes; saleRoot: PublicKeyBytes;
  tipChildBps: number; saleChildBps: number; tipResidualBps: number; saleResidualBps: number; provenanceCommitment: PublicKeyBytes;
}
export function repostNodeArgs(input: RepostNodeInput) {
  for (const bps of [input.tipChildBps, input.saleChildBps, input.tipResidualBps, input.saleResidualBps]) {
    if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) throw new RangeError('InvalidShareBps');
  }
  return { nonce: hashArray(input.nonce), tipRoot: hashArray(input.tipRoot), saleRoot: hashArray(input.saleRoot),
    tipChildBps: input.tipChildBps, saleChildBps: input.saleChildBps, tipResidualBps: input.tipResidualBps, saleResidualBps: input.saleResidualBps,
    provenanceCommitment: hashArray(input.provenanceCommitment) };
}
export function claimProofArgs(input: { beneficiary: PublicKeyInput; role: RightsRole; shareBps: number; siblings: readonly PublicKeyBytes[] }) {
  roleBytes(input.role);
  if (!Number.isSafeInteger(input.shareBps) || input.shareBps <= 0 || input.shareBps > 10_000 || input.siblings.length > 32) throw new RangeError('InvalidClaimProof');
  return { beneficiary: pubkey(input.beneficiary), role: input.role, shareBps: input.shareBps, siblings: input.siblings.map(hashArray) };
}
