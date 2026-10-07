import { createPublicKey, verify, sign, KeyObject } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { sha256 } from '../packages/canonicalization/src';
import { LocalStore, requireCondition, ServiceError } from './store';

export interface SignedRequest<T = unknown> {
  wallet: string;
  nonce: string;
  timestamp: number;
  payload: T;
  signature: string;
}
/** The encoding is versioned and never relies on caller JSON key ordering. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { requireCondition(Number.isFinite(value), 'InvalidJson'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  requireCondition(typeof value === 'object' && value !== null, 'InvalidJson');
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}
export function requestMessage(method: string, path: string, request: Omit<SignedRequest, 'signature'>): Buffer {
  return Buffer.from(canonicalJson({ domain: 'provena:wallet-request:v1', method: method.toUpperCase(), path, wallet: request.wallet, nonce: request.nonce, timestamp: request.timestamp, payloadHash: sha256(canonicalJson(request.payload)) }), 'utf8');
}
export function walletKey(wallet: string): PublicKey {
  try {
    const key = new PublicKey(wallet);
    requireCondition(key.toBase58() === wallet, 'InvalidWallet');
    return key;
  } catch { throw new ServiceError('InvalidWallet'); }
}
export function verifyWalletSignature(wallet: string, message: Uint8Array, signature: string): boolean {
  try {
    if (!/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false;
    const bytes = Buffer.from(signature, 'base64');
    if (bytes.length !== 64) return false;
    const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), walletKey(wallet).toBuffer()]), format: 'der', type: 'spki' });
    return verify(null, message, publicKey, bytes);
  } catch { return false; }
}
export class WalletAuthenticator {
  constructor(private readonly store: LocalStore, private readonly now = Date.now, readonly maxAgeMs = 300_000) {}
  async authenticate(method: string, path: string, value: unknown): Promise<SignedRequest> {
    requireCondition(value !== null && typeof value === 'object', 'InvalidSignedRequest');
    const request = value as SignedRequest;
    requireCondition(typeof request.wallet === 'string' && typeof request.nonce === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(request.nonce), 'InvalidSignedRequest');
    const current = this.now();
    requireCondition(Number.isSafeInteger(request.timestamp) && Math.abs(current - request.timestamp) <= this.maxAgeMs, 'ExpiredRequest', 401);
    requireCondition(typeof request.signature === 'string' && verifyWalletSignature(request.wallet, requestMessage(method, path, request), request.signature), 'InvalidWalletSignature', 401);
    await this.store.transact(state => {
      for (const [nonce, expires] of Object.entries(state.nonces)) if (expires < current) delete state.nonces[nonce];
      const key = `${request.wallet}:${request.nonce}`;
      requireCondition(!Object.hasOwn(state.nonces, key), 'RequestReplay', 409);
      state.nonces[key] = request.timestamp + this.maxAgeMs;
    });
    return request;
  }
}
export interface AuthoritySigner { readonly wallet: string; sign(message: Uint8Array): Promise<string>; }
/** Detached evidence signatures are audit artifacts; onchain handlers still require transaction co-signing. */
export class Ed25519AuthoritySigner implements AuthoritySigner {
  readonly wallet: string;
  constructor(private readonly privateKey: KeyObject) {
    const publicDer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    requireCondition(privateKey.asymmetricKeyType === 'ed25519', 'InvalidAuthorityKey');
    this.wallet = new PublicKey(publicDer.subarray(publicDer.length - 32)).toBase58();
  }
  async sign(message: Uint8Array): Promise<string> { return sign(null, message, this.privateKey).toString('base64'); }
}
