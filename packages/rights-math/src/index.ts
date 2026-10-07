import { createHash, timingSafeEqual } from 'node:crypto';

export const BPS_DENOMINATOR = 10_000;
export const MAX_U64 = (1n << 64n) - 1n;
export const MAX_U128 = (1n << 128n) - 1n;
export enum RevenueKind { Tip = 0, Sale = 1 }
export enum RightsRole { Origin = 0, Distributor = 1, LicensedSource = 2 }
export type PublicKeyBytes = string | Uint8Array;
export interface PayoutShare {
  readonly beneficiary: string; // Lowercase hex, exactly 32 bytes.
  readonly role: RightsRole;
  readonly shareBps: number;
}
export interface RightsVector {
  readonly locked: readonly PayoutShare[];
  readonly residual: PayoutShare;
}
export interface NodeRights { readonly tip: RightsVector; readonly sale: RightsVector; }
export interface RepostPolicy { readonly tipRetentionBps: number; readonly saleRetentionBps: number; }
export class RightsMathError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'RightsMathError'; }
}
function fail(code: string): never { throw new RightsMathError(code); }
export function bytes32(value: PublicKeyBytes): Buffer {
  if (typeof value === 'string') {
    if (!/^[0-9a-fA-F]{64}$/.test(value)) fail('InvalidBytes32');
    return Buffer.from(value, 'hex');
  }
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) fail('InvalidBytes32');
  return Buffer.from(value);
}
export function publicKeyHex(value: PublicKeyBytes): string { return bytes32(value).toString('hex'); }
export function assertBps(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > BPS_DENOMINATOR) fail('InvalidShareBps');
}
export function assertAmount(value: bigint): void {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_U64) fail('MathOverflow');
}
export function checkedAdd(a: bigint, b: bigint): bigint { assertAmount(a); assertAmount(b); const value = a + b; assertAmount(value); return value; }
export function floorShare(total: bigint, shareBps: number): bigint {
  assertAmount(total); assertBps(shareBps);
  const product = total * BigInt(shareBps);
  if (product > MAX_U128) fail('MathOverflow');
  return product / BigInt(BPS_DENOMINATOR);
}
function share(beneficiary: PublicKeyBytes, role: RightsRole, shareBps: number): PayoutShare {
  assertBps(shareBps);
  if (![RightsRole.Origin, RightsRole.Distributor, RightsRole.LicensedSource].includes(role)) fail('InvalidRightsRole');
  return Object.freeze({ beneficiary: publicKeyHex(beneficiary), role, shareBps });
}
/** Aggregate by wallet AND economic role; a source right cannot become a distributor right. */
export function canonicalizePayoutVector(rows: readonly PayoutShare[]): readonly PayoutShare[] {
  const aggregate = new Map<string, PayoutShare>();
  for (const row of rows) {
    const normalized = share(row.beneficiary, row.role, row.shareBps);
    if (normalized.shareBps === 0) continue;
    const key = `${normalized.beneficiary}:${normalized.role}`;
    const previous = aggregate.get(key);
    aggregate.set(key, share(normalized.beneficiary, normalized.role, (previous?.shareBps ?? 0) + normalized.shareBps));
  }
  const result = [...aggregate.values()].sort((a, b) => (a.beneficiary < b.beneficiary ? -1 : a.beneficiary > b.beneficiary ? 1 : 0) || a.role - b.role);
  if (result.reduce((sum, row) => sum + row.shareBps, 0) !== BPS_DENOMINATOR) fail('InvalidPayoutTotal');
  return Object.freeze(result);
}
function freezeVector(locked: readonly PayoutShare[], residual: PayoutShare): RightsVector {
  const copied = Object.freeze(locked.filter(row => row.shareBps > 0).map(row => share(row.beneficiary, row.role, row.shareBps)));
  const retained = share(residual.beneficiary, residual.role, residual.shareBps);
  canonicalizePayoutVector([...copied, retained]);
  return Object.freeze({ locked: copied, residual: retained });
}
/** Licensed sources are locked before the creator divides their remaining distribution rights. */
export function createOriginalVector(author: PublicKeyBytes, sources: readonly { beneficiary: PublicKeyBytes; shareBps: number }[] = [], sourceCapBps = 5000): RightsVector {
  assertBps(sourceCapBps);
  const locked = sources.map(source => share(source.beneficiary, RightsRole.LicensedSource, source.shareBps));
  const sourceTotal = locked.reduce((sum, row) => sum + row.shareBps, 0);
  if (sourceTotal > sourceCapBps) fail('SourceRightsCapExceeded');
  return freezeVector(locked, share(author, RightsRole.Origin, BPS_DENOMINATOR - sourceTotal));
}
export function payoutVector(rights: RightsVector): readonly PayoutShare[] {
  return canonicalizePayoutVector([...rights.locked, rights.residual]);
}
/** Only the current owner's residual is divisible. Previously locked rights remain byte-for-byte equal. */
export function deriveChildVector(parent: RightsVector, child: PublicKeyBytes, retentionBps: number): RightsVector {
  assertBps(retentionBps);
  payoutVector(parent); // Reject untrusted malformed parent vectors.
  if (parent.residual.role !== RightsRole.Origin && parent.residual.role !== RightsRole.Distributor) fail('InvalidResidualRole');
  const childResidual = Number(floorShare(BigInt(parent.residual.shareBps), BPS_DENOMINATOR - retentionBps));
  const retained = parent.residual.shareBps - childResidual;
  return freezeVector([...parent.locked, share(parent.residual.beneficiary, parent.residual.role, retained)], share(child, RightsRole.Distributor, childResidual));
}
export function createOriginalNodeRights(author: PublicKeyBytes, sources: readonly { beneficiary: PublicKeyBytes; shareBps: number }[] = []): NodeRights {
  return Object.freeze({ tip: createOriginalVector(author, sources), sale: createOriginalVector(author, sources) });
}
export function deriveChildNodeRights(parent: NodeRights, child: PublicKeyBytes, policy: RepostPolicy): NodeRights {
  return Object.freeze({ tip: deriveChildVector(parent.tip, child, policy.tipRetentionBps), sale: deriveChildVector(parent.sale, child, policy.saleRetentionBps) });
}
/** Preview a newly attested vector while preserving distributor and existing source rights.
 * Existing node roots stay immutable; their settlement uses settleUnclaimedLeaf.
 */
export function reclassifyOriginRights(rows: readonly PayoutShare[], source: PublicKeyBytes, sourceBpsOfOrigin: number): readonly PayoutShare[] {
  assertBps(sourceBpsOfOrigin);
  const current = canonicalizePayoutVector(rows);
  const replacement: PayoutShare[] = [];
  for (const row of current) {
    if (row.role !== RightsRole.Origin) { replacement.push(row); continue; }
    const sourceBps = Number(floorShare(BigInt(row.shareBps), sourceBpsOfOrigin));
    replacement.push(share(source, RightsRole.LicensedSource, sourceBps), share(row.beneficiary, row.role, row.shareBps - sourceBps));
  }
  return canonicalizePayoutVector(replacement);
}
export interface AllocatedShare extends PayoutShare { readonly amount: bigint; }
export function allocateRevenue(total: bigint, rows: readonly PayoutShare[]): Readonly<{ allocations: readonly AllocatedShare[]; dust: bigint }> {
  assertAmount(total);
  const allocations = canonicalizePayoutVector(rows).map(row => Object.freeze({ ...row, amount: floorShare(total, row.shareBps) }));
  const allocated = allocations.reduce((sum, row) => sum + row.amount, 0n);
  return Object.freeze({ allocations: Object.freeze(allocations), dust: total - allocated });
}
export function claimableAmount(totalReceived: bigint, shareBps: number, alreadyClaimed: bigint): bigint {
  assertAmount(alreadyClaimed);
  const entitlement = floorShare(totalReceived, shareBps);
  if (alreadyClaimed > entitlement) fail('InvalidClaimedAmount');
  return entitlement - alreadyClaimed;
}
/** Aggregate settlement preview of a pristine rights pool. Existing partially paid
 * epochs MUST use settleUnclaimedLeaf; repartitioning their global remainder
 * would erase unpaid downstream entitlements. Independent has zero fee.
 */
export function settleRevenue(gross: bigint, resolution: 'INDEPENDENT' | 'DERIVATIVE', rights: readonly PayoutShare[]): Readonly<{ protocolFee: bigint; rightsPool: bigint; allocations: readonly AllocatedShare[]; dust: bigint }> {
  assertAmount(gross);
  if (resolution !== 'INDEPENDENT' && resolution !== 'DERIVATIVE') fail('SettlementNotFinal');
  const protocolFee = resolution === 'DERIVATIVE' ? floorShare(gross, 500) : 0n;
  const rightsPool = gross - protocolFee;
  return Object.freeze({ protocolFee, rightsPool, ...allocateRevenue(rightsPool, rights) });
}
/** Finalized derivative settlement of a single immutable leaf, preserving past claims.
 * Per-leaf fee floors retain the fraction as user liability. Callers must store a
 * finalization checkpoint; pure arithmetic alone cannot prevent replay.
 */
export function settleUnclaimedLeaf(grossEntitlement: bigint, alreadyPaid: bigint, sourceBps: number, isOrigin: boolean): Readonly<{ protocolFee: bigint; source: bigint; owner: bigint }> {
  assertAmount(grossEntitlement); assertAmount(alreadyPaid); assertBps(sourceBps);
  if (alreadyPaid > grossEntitlement) fail('InvalidClaimedAmount');
  const unclaimed = grossEntitlement - alreadyPaid;
  const protocolFee = floorShare(unclaimed, 500);
  const rights = unclaimed - protocolFee;
  const source = isOrigin ? floorShare(rights, sourceBps) : 0n;
  return Object.freeze({ protocolFee, source, owner: rights - source });
}
const LEAF_DOMAIN = Buffer.from('provena:payout:v1');
const PAIR_DOMAIN = Buffer.from('provena:merkle:v1');
function hash(bytes: Uint8Array): Buffer { return createHash('sha256').update(bytes).digest(); }
function assertKind(kind: RevenueKind): void { if (kind !== RevenueKind.Tip && kind !== RevenueKind.Sale) fail('InvalidRevenueKind'); }
export function encodePayoutLeaf(node: PublicKeyBytes, kind: RevenueKind, row: PayoutShare): Buffer {
  assertKind(kind);
  const normalized = share(row.beneficiary, row.role, row.shareBps);
  const shareBytes = Buffer.alloc(2); shareBytes.writeUInt16LE(normalized.shareBps);
  return Buffer.concat([LEAF_DOMAIN, bytes32(node), Buffer.from([kind, normalized.role]), bytes32(normalized.beneficiary), shareBytes]);
}
export function payoutLeafHash(node: PublicKeyBytes, kind: RevenueKind, row: PayoutShare): string { return hash(encodePayoutLeaf(node, kind, row)).toString('hex'); }
export function merklePairHash(a: PublicKeyBytes, b: PublicKeyBytes): string {
  const left = bytes32(a), right = bytes32(b);
  return hash(Buffer.concat([PAIR_DOMAIN, ...(Buffer.compare(left, right) <= 0 ? [left, right] : [right, left])])).toString('hex');
}
export interface PayoutTree {
  readonly root: string;
  readonly leaves: readonly PayoutShare[];
  readonly leafHashes: readonly string[];
  readonly proofs: readonly (readonly string[])[];
}
export function buildPayoutTree(node: PublicKeyBytes, kind: RevenueKind, rows: readonly PayoutShare[]): PayoutTree {
  const leaves = canonicalizePayoutVector(rows);
  const leafHashes = leaves.map(row => payoutLeafHash(node, kind, row));
  const levels: string[][] = [leafHashes];
  while (levels[levels.length - 1]!.length > 1) {
    const previous = levels[levels.length - 1]!, next: string[] = [];
    for (let i = 0; i < previous.length; i += 2) next.push(merklePairHash(previous[i]!, previous[i + 1] ?? previous[i]!));
    levels.push(next);
  }
  const proofs = leaves.map((_, leafIndex) => {
    const proof: string[] = [];
    let index = leafIndex;
    for (let level = 0; level < levels.length - 1; level++) {
      const siblings = levels[level]!;
      proof.push(siblings[index ^ 1] ?? siblings[index]!); index = Math.floor(index / 2);
    }
    return Object.freeze(proof);
  });
  return Object.freeze({ root: levels[levels.length - 1]![0]!, leaves, leafHashes: Object.freeze(leafHashes), proofs: Object.freeze(proofs) });
}
export function verifyPayoutProof(node: PublicKeyBytes, kind: RevenueKind, row: PayoutShare, proof: readonly PublicKeyBytes[], root: PublicKeyBytes): boolean {
  try {
    if (proof.length > 32 || row.shareBps <= 0) return false;
    let current = payoutLeafHash(node, kind, row);
    for (const sibling of proof) current = merklePairHash(current, sibling);
    return timingSafeEqual(bytes32(current), bytes32(root));
  } catch { return false; }
}
export function paidBeneficiaryCount(totalRevenue: bigint, rows: readonly PayoutShare[]): number {
  return new Set(allocateRevenue(totalRevenue, rows).allocations.filter(row => row.amount > 0n).map(row => row.beneficiary)).size;
}
