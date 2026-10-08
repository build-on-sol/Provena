import { AccountInfo, Connection, PublicKey } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { createOriginalNodeRights, NodeRights } from '../packages/rights-math/src';
import { DEFAULT_PROGRAM_ID as SDK_PROGRAM_ID } from '../packages/protocol-sdk/src';
import { ReceiptVerifier } from './content-service';
import { requireCondition } from './store';

export const DEFAULT_PROGRAM_ID = SDK_PROGRAM_ID;
export interface AccountReader { getAccountInfo(key: PublicKey): Promise<AccountInfo<Buffer> | null>; }
export function accountDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
}
function validateAccount(account: AccountInfo<Buffer> | null, program: PublicKey, name: string, minimum: number): Buffer {
  requireCondition(account && account.owner.equals(program) && !account.executable && account.data.length >= minimum && account.data.subarray(0, 8).equals(accountDiscriminator(name)), 'InvalidChainAccount', 403);
  requireCondition(account.data[8] === 1, 'UnsupportedChainAccountVersion', 403);
  return account.data;
}
export class RpcReceiptVerifier implements ReceiptVerifier {
  constructor(private readonly reader: AccountReader, readonly programId = DEFAULT_PROGRAM_ID) {}
  async hasAccess(content: string, buyer: string): Promise<boolean> {
    const contentKey = new PublicKey(content), buyerKey = new PublicKey(buyer);
    const [receipt] = PublicKey.findProgramAddressSync([Buffer.from('access'), contentKey.toBuffer(), buyerKey.toBuffer()], this.programId);
    const account = await this.reader.getAccountInfo(receipt);
    if (account === null) return false;
    try {
      // Layout: discriminator, version, content, buyer, purchase_node, amount, mint, created_at.
      const data = validateAccount(account, this.programId, 'AccessReceipt', 153);
      return data.subarray(9, 41).equals(contentKey.toBuffer()) && data.subarray(41, 73).equals(buyerKey.toBuffer()) && data.readBigUInt64LE(105) > 0n;
    } catch { return false; }
  }
}
export interface ChainNodeSnapshot {
  node: string;
  content: string;
  creator: string;
  tipRoot: string;
  saleRoot: string;
  tipRetentionBps: number;
  saleRetentionBps: number;
  tipResidualBps: number;
  saleResidualBps: number;
  commitment: string;
  originalRights?: NodeRights;
}
export interface ValueEventEvidence { epoch: string; nonce: string; }
export interface ChainContentIdentity {
  id: string;
  author: string;
  rawHash: string;
  canonicalHash: string;
  canonicalizationVersion: number;
  metadataCommitment: string;
  storageCommitment: string;
  citationManifestCommitment: string;
  mode: 'PUBLIC' | 'PAID';
  quotePolicy: 'NONE' | 'PREVIEW_ONLY' | 'LIMITED';
  originalNode: string;
  licensedSource: string;
  licensedSourceBps: number;
}
export interface ChainFingerprint { canonicalHash: string; content: string; }
export interface ContentIdentityReader {
  readContent(content: string): Promise<ChainContentIdentity | null>;
  readFingerprint(canonicalHash: string): Promise<ChainFingerprint | null>;
}
export interface NodeReader {
  readNode(node: string): Promise<ChainNodeSnapshot>;
  hasValueEvent?(node: string, content: string, evidence: ValueEventEvidence): Promise<boolean>;
}
export class RpcNodeReader implements NodeReader, ContentIdentityReader {
  constructor(private readonly reader: AccountReader, readonly programId = DEFAULT_PROGRAM_ID) {}
  async readContent(content: string): Promise<ChainContentIdentity | null> {
    const key = new PublicKey(content);
    const account = await this.reader.getAccountInfo(key);
    if (account === null) return null;
    const data = validateAccount(account, this.programId, 'Content', 395);
    const author = new PublicKey(data.subarray(9, 41)), raw = data.subarray(41, 73);
    const expected = PublicKey.findProgramAddressSync([Buffer.from('content'), author.toBuffer(), raw], this.programId)[0];
    requireCondition(expected.equals(key), 'InvalidContentPda', 403);
    requireCondition(data[203] === 0 || data[203] === 1, 'InvalidChainContentMode', 403);
    const quote = data[205];
    requireCondition(quote === 0 || quote === 1 || quote === 2, 'InvalidChainQuotePolicy', 403);
    return {
      id: content, author: author.toBase58(), rawHash: raw.toString('hex'), canonicalHash: data.subarray(73, 105).toString('hex'), canonicalizationVersion: data.readUInt16LE(105),
      metadataCommitment: data.subarray(107, 139).toString('hex'), storageCommitment: data.subarray(139, 171).toString('hex'), citationManifestCommitment: data.subarray(171, 203).toString('hex'),
      mode: data[203] === 0 ? 'PUBLIC' : 'PAID', quotePolicy: quote === 0 ? 'NONE' : quote === 1 ? 'PREVIEW_ONLY' : 'LIMITED',
      originalNode: new PublicKey(data.subarray(246, 278)).toBase58(), licensedSource: new PublicKey(data.subarray(278, 310)).toBase58(), licensedSourceBps: data.readUInt16LE(310),
    };
  }
  async readFingerprint(canonicalHash: string): Promise<ChainFingerprint | null> {
    requireCondition(/^[0-9a-f]{64}$/.test(canonicalHash), 'InvalidCanonicalHash');
    const hash = Buffer.from(canonicalHash, 'hex');
    const key = PublicKey.findProgramAddressSync([Buffer.from('fingerprint'), hash], this.programId)[0];
    const account = await this.reader.getAccountInfo(key);
    if (account === null) return null;
    const data = validateAccount(account, this.programId, 'FingerprintRegistry', 73);
    requireCondition(data.subarray(9, 41).equals(hash), 'ChainFingerprintMismatch', 403);
    return { canonicalHash, content: new PublicKey(data.subarray(41, 73)).toBase58() };
  }
  async readNode(node: string): Promise<ChainNodeSnapshot> {
    const nodeKey = new PublicKey(node);
    const data = validateAccount(await this.reader.getAccountInfo(nodeKey), this.programId, 'DistributionNode', 185);
    const content = new PublicKey(data.subarray(9, 41));
    const creator = new PublicKey(data.subarray(41, 73));
    const tipChild = data.readUInt16LE(137), saleChild = data.readUInt16LE(139);
    requireCondition(tipChild <= 10_000 && saleChild <= 10_000, 'InvalidChainPolicy');
    const snapshot: ChainNodeSnapshot = { node, content: content.toBase58(), creator: creator.toBase58(), tipRoot: data.subarray(73, 105).toString('hex'), saleRoot: data.subarray(105, 137).toString('hex'), tipRetentionBps: 10_000 - tipChild, saleRetentionBps: 10_000 - saleChild, tipResidualBps: data.readUInt16LE(141), saleResidualBps: data.readUInt16LE(143), commitment: data.subarray(145, 177).toString('hex') };
    const [original] = PublicKey.findProgramAddressSync([Buffer.from('original'), content.toBuffer()], this.programId);
    if (original.equals(nodeKey)) {
      const identity = await this.readContent(content.toBase58());
      requireCondition(identity && identity.author === creator.toBase58() && identity.originalNode === node, 'InvalidOriginalNode', 403);
      snapshot.originalRights = createOriginalNodeRights(creator.toBuffer(), identity.licensedSourceBps > 0 ? [{ beneficiary: new PublicKey(identity.licensedSource).toBuffer(), shareBps: identity.licensedSourceBps }] : []);
    }
    return snapshot;
  }
  async hasValueEvent(node: string, content: string, evidence: ValueEventEvidence): Promise<boolean> {
    requireCondition(typeof evidence.nonce === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(evidence.nonce) && BigInt(evidence.nonce) <= (1n << 64n) - 1n, 'InvalidEpochNonce');
    const chain = await this.readNode(node);
    requireCondition(chain.content === content, 'ValueEventContentMismatch', 403);
    const epochKey = new PublicKey(evidence.epoch);
    const account = await this.reader.getAccountInfo(epochKey);
    if (account === null) return false;
    const data = validateAccount(account, this.programId, 'RevenueEpoch', 179);
    const kind = data[105];
    requireCondition(kind === 0 || kind === 1, 'InvalidRevenueKind', 403);
    const nonce = Buffer.alloc(8); nonce.writeBigUInt64LE(BigInt(evidence.nonce));
    const expected = PublicKey.findProgramAddressSync([Buffer.from('epoch'), new PublicKey(node).toBuffer(), data.subarray(73, 105), Buffer.from([kind]), nonce], this.programId)[0];
    requireCondition(epochKey.equals(expected) && data.subarray(9, 41).equals(new PublicKey(content).toBuffer()) && data.subarray(41, 73).equals(new PublicKey(node).toBuffer()), 'InvalidValueEventEpoch', 403);
    requireCondition(data.subarray(106, 138).toString('hex') === (kind === 0 ? chain.tipRoot : chain.saleRoot), 'ValueEventRootMismatch', 403);
    const gross = data.readBigUInt64LE(138), paid = data.readBigUInt64LE(146), fees = data.readBigUInt64LE(154);
    requireCondition(paid + fees <= gross, 'InvalidValueEventAccounting', 403);
    // Epoch gross can increase only through a successful atomic economic deposit.
    return gross > 0n;
  }
}
export function finalizedAccountReader(connection: Connection): AccountReader {
  return { getAccountInfo: key => connection.getAccountInfo(key, 'finalized') };
}
