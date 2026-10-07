import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RightsRole, RevenueKind, MAX_U64, PayoutShare, RightsVector, publicKeyHex, createOriginalVector,
  createOriginalNodeRights, deriveChildVector, deriveChildNodeRights, payoutVector, canonicalizePayoutVector,
  buildPayoutTree, verifyPayoutProof, payoutLeafHash, encodePayoutLeaf, merklePairHash,
  floorShare, checkedAdd, allocateRevenue, claimableAmount, settleRevenue, settleUnclaimedLeaf,
  reclassifyOriginRights, paidBeneficiaryCount,
} from '../packages/rights-math/src/index';
const key = (byte: number) => Buffer.alloc(32, byte);
const A = key(1), B = key(2), C = key(3), X = key(4), NODE = key(9);
function row(wallet: Uint8Array, role: RightsRole, shareBps: number): PayoutShare { return { beneficiary: publicKeyHex(wallet), role, shareBps }; }
function shares(vector: RightsVector): number[] { return payoutVector(vector).map(value => value.shareBps); }
function abc() { return deriveChildVector(deriveChildVector(createOriginalVector(A), B, 7000), C, 6000); }

test('A -> B -> C locks ancestors and produces exactly 70/18/12', () => {
  const original = createOriginalVector(A);
  const b = deriveChildVector(original, B, 7000);
  const c = deriveChildVector(b, C, 6000);
  assert.deepEqual(shares(original), [10000]);
  assert.deepEqual(shares(b), [7000, 3000]);
  assert.deepEqual(shares(c), [7000, 1800, 1200]);
  assert.deepEqual(c.locked[0], b.locked[0]);
  assert.ok(Object.isFrozen(original) && Object.isFrozen(c.locked) && Object.isFrozen(c.residual));
  assert.deepEqual(allocateRevenue(100n, payoutVector(c)).allocations.map(value => value.amount), [70n, 18n, 12n]);
});
test('TIP and SALE policies are independent; changing future policy leaves old children intact', () => {
  const original = createOriginalNodeRights(A);
  const policy = { tipRetentionBps: 7000, saleRetentionBps: 8000 };
  const b = deriveChildNodeRights(original, B, policy);
  const c = deriveChildNodeRights(b, C, { tipRetentionBps: 6000, saleRetentionBps: 9000 });
  policy.tipRetentionBps = 1000;
  assert.deepEqual(shares(b.tip), [7000, 3000]);
  assert.deepEqual(shares(b.sale), [8000, 2000]);
  assert.deepEqual(shares(c.tip), [7000, 1800, 1200]);
  assert.deepEqual(shares(c.sale), [8000, 1800, 200]);
  assert.deepEqual(shares(original.tip), [10000]);
});
test('residual floor goes to child and rounding remainder stays with current owner', () => {
  const parent = deriveChildVector(createOriginalVector(A), B, 9997);
  const child = deriveChildVector(parent, C, 5000);
  assert.equal(child.residual.shareBps, 1);
  assert.equal(child.locked[1]!.shareBps, 2);
  assert.equal(payoutVector(child).reduce((sum, value) => sum + value.shareBps, 0), 10000);
});
test('licensed source rights stay locked and distribute only creator residual 20/56/24', () => {
  const original = createOriginalVector(B, [{ beneficiary: A, shareBps: 2000 }]);
  const child = deriveChildVector(original, C, 7000);
  assert.deepEqual(shares(child), [2000, 5600, 2400]);
  assert.equal(payoutVector(child)[0]!.role, RightsRole.LicensedSource);
  assert.throws(() => createOriginalVector(B, [{ beneficiary: A, shareBps: 5001 }]), /SourceRightsCapExceeded/);
});
test('reusing one wallet cannot dilute earlier locked distributor residual', () => {
  const b = deriveChildVector(createOriginalVector(A), B, 7000);
  const c = deriveChildVector(b, B, 6000);
  const d = deriveChildVector(c, C, 5000);
  assert.deepEqual(shares(c), [7000, 3000]);
  assert.deepEqual(shares(d), [7000, 2400, 600]);
  assert.equal(c.residual.shareBps, 1200);
});
test('canonical leaves aggregate each wallet/role while keeping distinct rights roles', () => {
  const vector = canonicalizePayoutVector([row(B, RightsRole.Distributor, 2000), row(A, RightsRole.Origin, 5000), row(A, RightsRole.LicensedSource, 1000), row(B, RightsRole.Distributor, 2000)]);
  assert.deepEqual(vector.map(value => [value.beneficiary, value.role, value.shareBps]), [
    [publicKeyHex(A), 0, 5000], [publicKeyHex(A), 2, 1000], [publicKeyHex(B), 1, 4000],
  ]);
  assert.equal(paidBeneficiaryCount(100n, vector), 2);
  assert.throws(() => canonicalizePayoutVector([row(A, RightsRole.Origin, 9999)]), /InvalidPayoutTotal/);
});
test('payout binary encoding and odd-leaf Merkle root match independent golden vectors', () => {
  const tree = buildPayoutTree(NODE, RevenueKind.Tip, payoutVector(abc()));
  assert.deepEqual(tree.leafHashes, [
    'cd3feeaf1b793c6d092b852565673541d274850a9ae27967b33f77274d676ccc',
    '96128b52b3f047a19f76bc7fff55f03f2265617d9c1e954761b038cc6a6c8475',
    '8707c2273dc4f823e9918e8f9c4429324936c38783f42ee1f563f3e8560145bd',
  ]);
  assert.equal(tree.root, '36e1cfeede2c752d4634b4a29de20367e64c54595879e99b378407a1458e2ae9');
  assert.equal(encodePayoutLeaf(NODE, RevenueKind.Tip, tree.leaves[0]!).readUInt16LE(83), 7000);
  tree.leaves.forEach((leaf, index) => assert.equal(verifyPayoutProof(NODE, RevenueKind.Tip, leaf, tree.proofs[index]!, tree.root), true));
  assert.equal(merklePairHash(tree.leafHashes[0]!, tree.leafHashes[1]!), merklePairHash(tree.leafHashes[1]!, tree.leafHashes[0]!));
});
test('proofs reject changed beneficiary/share/node/revenue kind/role/root and malformed siblings', () => {
  const tree = buildPayoutTree(NODE, RevenueKind.Tip, payoutVector(abc()));
  const leaf = tree.leaves[0]!, proof = tree.proofs[0]!;
  for (const modified of [{ ...leaf, beneficiary: publicKeyHex(X) }, { ...leaf, shareBps: 7001 }, { ...leaf, role: RightsRole.Distributor }]) assert.equal(verifyPayoutProof(NODE, RevenueKind.Tip, modified, proof, tree.root), false);
  assert.equal(verifyPayoutProof(X, RevenueKind.Tip, leaf, proof, tree.root), false);
  assert.equal(verifyPayoutProof(NODE, RevenueKind.Sale, leaf, proof, tree.root), false);
  assert.equal(verifyPayoutProof(NODE, RevenueKind.Tip, leaf, proof, '00'.repeat(32)), false);
  assert.equal(verifyPayoutProof(NODE, RevenueKind.Tip, leaf, ['bad'], tree.root), false);
  assert.equal(verifyPayoutProof(NODE, RevenueKind.Tip, leaf, Array(33).fill(tree.root), tree.root), false);
  assert.notEqual(payoutLeafHash(NODE, RevenueKind.Sale, leaf), payoutLeafHash(NODE, RevenueKind.Tip, leaf));
});
test('integer arithmetic preserves full u64 range, bounds dust and rejects overflow', () => {
  assert.equal(floorShare(MAX_U64, 10000), MAX_U64);
  assert.equal(floorShare(MAX_U64, 500), MAX_U64 / 20n);
  assert.throws(() => floorShare(MAX_U64 + 1n, 1), /MathOverflow/);
  assert.throws(() => checkedAdd(MAX_U64, 1n), /MathOverflow/);
  assert.throws(() => floorShare(100n, 10001), /InvalidShareBps/);
  assert.throws(() => floorShare(-1n, 10000), /MathOverflow/);
  assert.deepEqual(allocateRevenue(1n, payoutVector(abc())).allocations.map(value => value.amount), [0n, 0n, 0n]);
  assert.equal(allocateRevenue(1n, payoutVector(abc())).dust, 1n);
});
test('cumulative claims do not compound rounding or pay the same entitlement twice', () => {
  assert.equal(claimableAmount(3n, 3333, 0n), 0n);
  assert.equal(claimableAmount(4n, 3333, 0n), 1n);
  assert.equal(claimableAmount(4n, 3333, 1n), 0n);
  assert.equal(claimableAmount(7n, 3333, 1n), 1n);
  assert.throws(() => claimableAmount(4n, 3333, 2n), /InvalidClaimedAmount/);
});
test('final derivative settlement produces 5/66.5/28.5 and independent pays zero fee', () => {
  const vector = [row(A, RightsRole.Origin, 7000), row(B, RightsRole.Origin, 3000)];
  const derivative = settleRevenue(10000n, 'DERIVATIVE', vector);
  assert.equal(derivative.protocolFee, 500n);
  assert.deepEqual(derivative.allocations.map(value => value.amount), [6650n, 2850n]);
  assert.equal(settleRevenue(10000n, 'INDEPENDENT', vector).protocolFee, 0n);
  assert.throws(() => settleRevenue(100n, 'UNRESOLVED' as 'DERIVATIVE', vector), /SettlementNotFinal/);
});
test('leaf settlement preserves already-paid funds and never repartitions a distributor liability', () => {
  assert.deepEqual(settleUnclaimedLeaf(7000n, 6000n, 7000, true), { protocolFee: 50n, source: 665n, owner: 285n });
  assert.deepEqual(settleUnclaimedLeaf(30n, 0n, 7000, false), { protocolFee: 1n, source: 0n, owner: 29n });
  assert.deepEqual(settleUnclaimedLeaf(70n, 70n, 7000, true), { protocolFee: 0n, source: 0n, owner: 0n });
  assert.deepEqual(settleUnclaimedLeaf(100n, 0n, 7000, true), { protocolFee: 5n, source: 66n, owner: 29n });
  assert.throws(() => settleUnclaimedLeaf(70n, 71n, 7000, true), /InvalidClaimedAmount/);
});
test('origin reclassification preserves both downstream distributor shares', () => {
  const before = payoutVector(abc());
  const after = reclassifyOriginRights(before, X, 7000);
  for (const distributor of before.filter(value => value.role === RightsRole.Distributor)) assert.deepEqual(after.find(value => value.beneficiary === distributor.beneficiary && value.role === distributor.role), distributor);
  assert.equal(after.find(value => value.beneficiary === publicKeyHex(X))!.shareBps, 4900);
  assert.equal(after.reduce((sum, value) => sum + value.shareBps, 0), 10000);
  assert.deepEqual(before.map(value => value.shareBps), [7000, 1800, 1200]);
});
test('deterministic property vectors conserve all shares and never reduce locked ancestors', () => {
  let seed = 0x12345678;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let trial = 0; trial < 100; trial++) {
    let vector = createOriginalVector(A);
    for (let depth = 0; depth < 24; depth++) {
      const locked = [...vector.locked];
      vector = deriveChildVector(vector, key(depth + 2), random() % 10001);
      assert.deepEqual(vector.locked.slice(0, locked.length), locked);
      assert.equal(payoutVector(vector).reduce((sum, value) => sum + value.shareBps, 0), 10000);
      const total = BigInt(random());
      const allocated = allocateRevenue(total, payoutVector(vector));
      assert.equal(allocated.allocations.reduce((sum, value) => sum + value.amount, 0n) + allocated.dust, total);
      assert.ok(allocated.dust < BigInt(allocated.allocations.length));
    }
  }
});
test('deterministic leaf settlement property conserves historical payments and user liabilities', () => {
  for (let total = 0n; total < 2000n; total++) {
    const paid = total / 3n;
    const result = settleUnclaimedLeaf(total, paid, Number(total % 10001n), true);
    assert.equal(paid + result.protocolFee + result.source + result.owner, total);
    assert.ok(result.protocolFee <= (total - paid) / 20n);
  }
});
