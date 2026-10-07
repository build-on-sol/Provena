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
export interface NodeReader { readNode(node: string): Promise<ChainNodeSnapshot>; }
export class RpcNodeReader implements NodeReader {
  constructor(private readonly reader: AccountReader, readonly programId = DEFAULT_PROGRAM_ID) {}
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
      const body = validateAccount(await this.reader.getAccountInfo(content), this.programId, 'Content', 395);
      requireCondition(body.subarray(9, 41).equals(creator.toBuffer()) && body.subarray(246, 278).equals(nodeKey.toBuffer()), 'InvalidOriginalNode', 403);
      const sourceBps = body.readUInt16LE(310);
      snapshot.originalRights = createOriginalNodeRights(creator.toBuffer(), sourceBps > 0 ? [{ beneficiary: body.subarray(278, 310), shareBps: sourceBps }] : []);
    }
    return snapshot;
  }
}
export function finalizedAccountReader(connection: Connection): AccountReader {
  return { getAccountInfo: key => connection.getAccountInfo(key, 'finalized') };
}
