import { randomBytes } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { buildPayoutTree, deriveChildNodeRights, NodeRights, payoutVector, RevenueKind, RepostPolicy } from '../../packages/rights-math/src';
import { provenanceCommitment, verifyProvenanceReveal, ProvenanceReveal } from '../../packages/protocol-sdk/src';
import { AuthoritySigner, canonicalJson, walletKey } from '../auth';
import { ChainNodeSnapshot, NodeReader } from '../chain';
import { LocalStore, requireCondition } from '../store';

export interface PrivateNode {
  readonly node: string;
  readonly content: string;
  readonly creator: string;
  readonly parent: string | null;
  readonly parentCommitment: string;
  readonly salt: string;
  readonly commitment: string;
  readonly rights: NodeRights;
  readonly tipRoot: string;
  readonly saleRoot: string;
  readonly nonce?: string;
  readonly state: 'CHAIN_VERIFIED' | 'ATTESTED_PLAN';
}
export interface RepostPlan {
  readonly publicPlan: { node: string; content: string; creator: string; nonce: string; tipRoot: string; saleRoot: string; tipResidualBps: number; saleResidualBps: number; provenanceCommitment: string; tipChildBps: number; saleChildBps: number };
  readonly auditAttestation: { message: string; signer: string; signature: string; transactionCosigningRequired: true };
}
/** Parent mapping stays private. Audit signatures cannot replace the chain authority signer. */
export class ProvenanceService {
  constructor(private readonly store: LocalStore, private readonly reader: NodeReader, readonly programId: PublicKey, private readonly authority?: AuthoritySigner) {}
  private get(node: string): PrivateNode {
    const nodes = this.store.snapshot().provenance;
    const value = Object.hasOwn(nodes, node) ? nodes[node] as PrivateNode : undefined;
    requireCondition(value, 'UnknownPrivateNode', 404);
    return value;
  }
  private verifySnapshot(privateNode: PrivateNode, chain: ChainNodeSnapshot): void {
    requireCondition(privateNode.node === chain.node && privateNode.content === chain.content && privateNode.creator === chain.creator && privateNode.tipRoot === chain.tipRoot && privateNode.saleRoot === chain.saleRoot && privateNode.commitment === chain.commitment && privateNode.rights.tip.residual.shareBps === chain.tipResidualBps && privateNode.rights.sale.residual.shareBps === chain.saleResidualBps, 'ChainRightsMismatch', 409);
  }
  async registerOriginal(requester: string, node: string): Promise<{ node: string; content: string; tipRoot: string; saleRoot: string }> {
    const chain = await this.reader.readNode(node);
    requireCondition(chain.creator === requester, 'Unauthorized', 403);
    requireCondition(chain.originalRights && chain.commitment === '00'.repeat(32), 'InvalidOriginalNode');
    const tipRoot = buildPayoutTree(new PublicKey(node).toBuffer(), RevenueKind.Tip, payoutVector(chain.originalRights.tip)).root;
    const saleRoot = buildPayoutTree(new PublicKey(node).toBuffer(), RevenueKind.Sale, payoutVector(chain.originalRights.sale)).root;
    requireCondition(tipRoot === chain.tipRoot && saleRoot === chain.saleRoot, 'ChainRightsMismatch', 409);
    const privateNode: PrivateNode = { node, content: chain.content, creator: requester, parent: null, parentCommitment: '00'.repeat(32), salt: '00'.repeat(32), commitment: chain.commitment, rights: chain.originalRights, tipRoot, saleRoot, state: 'CHAIN_VERIFIED' };
    await this.store.transact(state => { requireCondition(!Object.hasOwn(state.provenance, node), 'NodeAlreadyRegistered', 409); state.provenance[node] = privateNode; });
    return { node, content: chain.content, tipRoot, saleRoot };
  }
  async attestRepost(creator: string, input: { parent: string; nonce: string; policy: RepostPolicy }): Promise<RepostPlan> {
    requireCondition(this.authority, 'RightsAuthorityUnconfigured', 503);
    walletKey(creator);
    requireCondition(/^[0-9a-f]{64}$/.test(input.nonce), 'InvalidNodeNonce');
    const parent = this.get(input.parent);
    // Read the current chain policy every time. Updates affect future children only.
    const chain = await this.reader.readNode(input.parent);
    this.verifySnapshot(parent, chain);
    const node = PublicKey.findProgramAddressSync([Buffer.from('node'), new PublicKey(parent.content).toBuffer(), walletKey(creator).toBuffer(), Buffer.from(input.nonce, 'hex')], this.programId)[0].toBase58();
    const rights = deriveChildNodeRights(parent.rights, walletKey(creator).toBuffer(), { tipRetentionBps: chain.tipRetentionBps, saleRetentionBps: chain.saleRetentionBps });
    const policy = input.policy;
    requireCondition(Number.isInteger(policy.tipRetentionBps) && policy.tipRetentionBps >= 0 && policy.tipRetentionBps <= 10_000 && Number.isInteger(policy.saleRetentionBps) && policy.saleRetentionBps >= 0 && policy.saleRetentionBps <= 10_000, 'InvalidRepostPolicy');
    const tipRoot = buildPayoutTree(new PublicKey(node).toBuffer(), RevenueKind.Tip, payoutVector(rights.tip)).root;
    const saleRoot = buildPayoutTree(new PublicKey(node).toBuffer(), RevenueKind.Sale, payoutVector(rights.sale)).root;
    const salt = randomBytes(32).toString('hex');
    const commitment = provenanceCommitment({ node, parent: input.parent, parentCommitment: parent.commitment, salt });
    const publicPlan = { node, content: parent.content, creator, nonce: input.nonce, tipRoot, saleRoot, tipResidualBps: rights.tip.residual.shareBps, saleResidualBps: rights.sale.residual.shareBps, provenanceCommitment: commitment, tipChildBps: 10_000 - policy.tipRetentionBps, saleChildBps: 10_000 - policy.saleRetentionBps };
    const message = canonicalJson({ domain: 'provena:rights-attestation:v1', programId: this.programId.toBase58(), ...publicPlan });
    const signature = await this.authority.sign(Buffer.from(message));
    const privateNode: PrivateNode = { node, content: parent.content, creator, parent: input.parent, parentCommitment: parent.commitment, salt, commitment, rights, tipRoot, saleRoot, nonce: input.nonce, state: 'ATTESTED_PLAN' };
    await this.store.transact(state => { requireCondition(!Object.hasOwn(state.provenance, node), 'NodeAlreadyRegistered', 409); state.provenance[node] = privateNode; });
    return { publicPlan, auditAttestation: { message, signer: this.authority.wallet, signature, transactionCosigningRequired: true } };
  }
  async confirmNode(requester: string, node: string): Promise<void> {
    const privateNode = this.get(node);
    requireCondition(privateNode.creator === requester || requester === this.authority?.wallet, 'Unauthorized', 403);
    this.verifySnapshot(privateNode, await this.reader.readNode(node));
    await this.store.transact(state => { state.provenance[node] = { ...privateNode, state: 'CHAIN_VERIFIED' }; });
  }
  reveal(requester: string, node: string): readonly ProvenanceReveal[] {
    const tip = this.get(node);
    requireCondition(tip.creator === requester || requester === this.authority?.wallet, 'Unauthorized', 403);
    const result: ProvenanceReveal[] = [];
    const visited = new Set<string>();
    let current = tip;
    while (current.parent !== null) {
      requireCondition(!visited.has(current.node), 'InvalidProvenanceChain');
      visited.add(current.node);
      const link = { node: current.node, parent: current.parent, parentCommitment: current.parentCommitment, salt: current.salt, commitment: current.commitment };
      requireCondition(verifyProvenanceReveal(link), 'InvalidProvenanceCommitment');
      result.push(link);
      current = this.get(current.parent);
    }
    return result;
  }
  payoutProof(requester: string, node: string, kind: RevenueKind): { root: string; leaves: readonly { beneficiary: string; role: number; shareBps: number }[]; proofs: readonly (readonly string[])[] } {
    const privateNode = this.get(node);
    // Beneficiaries need their own leaf/proof. Never publish the entire ancestry vector.
    const tree = buildPayoutTree(new PublicKey(node).toBuffer(), kind, payoutVector(kind === RevenueKind.Tip ? privateNode.rights.tip : privateNode.rights.sale));
    if (requester === this.authority?.wallet || requester === privateNode.creator) return { root: tree.root, leaves: tree.leaves, proofs: tree.proofs };
    const requesterHex = walletKey(requester).toBuffer().toString('hex');
    const indexes = tree.leaves.flatMap((leaf, index) => leaf.beneficiary === requesterHex ? [index] : []);
    requireCondition(indexes.length > 0, 'Unauthorized', 403);
    return { root: tree.root, leaves: indexes.map(index => tree.leaves[index]!), proofs: indexes.map(index => tree.proofs[index]!) };
  }
}
