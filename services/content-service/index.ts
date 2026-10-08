import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { CitationReference, CitationSource, hashContent, sha256, QuotePolicy, validateCitationManifest, VerifiedCitationManifest } from '../../packages/canonicalization/src';
import { canonicalJson, walletKey } from '../auth';
import { ContentIdentityReader } from '../chain';
import { LocalStore, requireCondition, ServiceError } from '../store';

export interface CipherBlob { readonly algorithm: 'AES-256-GCM'; readonly iv: string; readonly tag: string; readonly ciphertext: string; }
export interface ContentArtifact {
  readonly id: string;
  readonly author: string;
  readonly mode: 'PUBLIC' | 'PAID';
  readonly title: string;
  readonly publicMetadata: string;
  readonly preview?: string;
  readonly quotePolicy: QuotePolicy;
  readonly rawHash: string;
  readonly canonicalHash: string;
  readonly canonicalizationVersion: 1;
  readonly citationManifest: VerifiedCitationManifest;
  readonly storageCommitment: string;
  readonly metadataCommitment: string;
  readonly stagedAt: number;
  /** Missing in legacy stores means PENDING; labels never establish chain ownership. */
  readonly lifecycle?: 'PENDING' | 'CONFIRMED';
  readonly plaintext?: string;
  readonly blob?: CipherBlob;
  readonly wrappedKey?: CipherBlob;
}
export interface SubmitContent {
  body: string;
  mode: 'PUBLIC' | 'PAID';
  title: string;
  publicMetadata?: string;
  preview?: string;
  quotePolicy?: QuotePolicy;
  citations?: readonly CitationReference[];
}
export interface ReceiptVerifier { hasAccess(content: string, buyer: string): Promise<boolean>; }
function seal(plaintext: Uint8Array, key: Buffer, associatedData: string): CipherBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(associatedData));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { algorithm: 'AES-256-GCM', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}
export function decryptBlob(blob: CipherBlob, key: Buffer, associatedData: string): Buffer {
  requireCondition(blob.algorithm === 'AES-256-GCM', 'InvalidEncryptionAlgorithm');
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  cipher.setAAD(Buffer.from(associatedData));
  cipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  return Buffer.concat([cipher.update(Buffer.from(blob.ciphertext, 'base64')), cipher.final()]);
}
export class ContentService {
  constructor(readonly store: LocalStore, readonly programId: PublicKey, private readonly receiptVerifier: ReceiptVerifier, private readonly masterKey?: Buffer, private readonly now = Date.now, private readonly identityReader?: ContentIdentityReader) {
    requireCondition(masterKey === undefined || masterKey.length === 32, 'InvalidMasterKey');
  }
  get(id: string): ContentArtifact {
    const content = this.store.snapshot().content;
    const record = Object.hasOwn(content, id) ? content[id] as ContentArtifact : undefined;
    requireCondition(record, 'ContentNotFound', 404);
    return record;
  }
  publicArtifact(id: string): Omit<ContentArtifact, 'wrappedKey'> {
    const { wrappedKey: _privateKey, ...artifact } = this.get(id);
    return { ...artifact, lifecycle: artifact.lifecycle ?? 'PENDING' };
  }
  privateKey(artifact: ContentArtifact): Buffer {
    requireCondition(this.masterKey, 'KeyServiceUnconfigured', 503);
    requireCondition(artifact.wrappedKey, 'ContentNotPaid');
    return decryptBlob(artifact.wrappedKey, this.masterKey, `provena:key:v1:${artifact.id}`);
  }
  privateBody(artifact: ContentArtifact): string {
    if (artifact.mode === 'PUBLIC') return artifact.plaintext!;
    return decryptBlob(artifact.blob!, this.privateKey(artifact), `provena:body:v1:${artifact.id}`).toString('utf8');
  }
  async stage(author: string, input: SubmitContent): Promise<Omit<ContentArtifact, 'wrappedKey'>> {
    walletKey(author);
    requireCondition(typeof input.body === 'string' && input.body.length > 0 && Buffer.byteLength(input.body) <= 500_000 && hashContent(input.body).canonicalBody.length > 0, 'InvalidContentBody');
    requireCondition(input.mode === 'PUBLIC' || input.mode === 'PAID', 'InvalidContentMode');
    requireCondition(typeof input.title === 'string' && input.title.length <= 200 && (input.publicMetadata === undefined || typeof input.publicMetadata === 'string' && input.publicMetadata.length <= 5000) && (input.preview === undefined || typeof input.preview === 'string' && input.preview.length <= 5000), 'InvalidContentMetadata');
    const quotePolicy = input.quotePolicy ?? (input.mode === 'PAID' ? 'NONE' : 'LIMITED');
    requireCondition(['NONE', 'PREVIEW_ONLY', 'LIMITED'].includes(quotePolicy), 'InvalidQuotePolicy');
    const hashes = hashContent(input.body);
    const [contentKey] = PublicKey.findProgramAddressSync([Buffer.from('content'), walletKey(author).toBuffer(), Buffer.from(hashes.rawHash, 'hex')], this.programId);
    const id = contentKey.toBase58();
    // Drafts do not reserve a global identity. Only the finalized registry can reject it.
    if (this.identityReader) {
      try { requireCondition(await this.identityReader.readFingerprint(hashes.canonicalHash) === null, 'DuplicateContent', 409); }
      catch (error) { if (error instanceof ServiceError) throw error; throw new ServiceError('ContentIdentityVerifierUnavailable', 503); }
    }
    const references = input.citations ?? [];
    requireCondition(Array.isArray(references) && references.length <= 64, 'InvalidCitationManifest');
    requireCondition(references.every(reference => reference !== null && typeof reference === 'object' && typeof reference.sourceContentId === 'string' && typeof reference.sourceAuthor === 'string' && typeof reference.citingContentId === 'string' && typeof reference.excerpt === 'string' && Array.isArray(reference.sourceSegments) && reference.sourceSegments.every((segment: unknown) => segment !== null && typeof segment === 'object')), 'InvalidCitationManifest');
    const sources: CitationSource[] = [...new Set(references.map(reference => reference.sourceContentId))].map(sourceId => {
      const source = this.get(sourceId);
      return { contentId: source.id, author: source.author, body: this.privateBody(source), mode: source.mode, quotePolicy: source.quotePolicy, title: source.title, publicMetadata: source.publicMetadata, ...(source.preview !== undefined ? { preview: source.preview } : {}) };
    });
    const citationManifest = validateCitationManifest({ citingContentId: id, renderedBody: input.body, references, sources });
    const metadata = { title: input.title, publicMetadata: input.publicMetadata ?? '', quotePolicy, ...(input.preview !== undefined ? { preview: input.preview } : {}) };
    let payload: Pick<ContentArtifact, 'plaintext' | 'blob' | 'wrappedKey'>;
    if (input.mode === 'PAID') {
      requireCondition(this.masterKey, 'KeyServiceUnconfigured', 503);
      const dataKey = randomBytes(32);
      payload = { blob: seal(Buffer.from(input.body), dataKey, `provena:body:v1:${id}`), wrappedKey: seal(dataKey, this.masterKey, `provena:key:v1:${id}`) };
    } else payload = { plaintext: input.body };
    const artifact: ContentArtifact = { id, author, mode: input.mode, ...metadata, rawHash: hashes.rawHash, canonicalHash: hashes.canonicalHash, canonicalizationVersion: 1, citationManifest, ...payload, storageCommitment: sha256(input.mode === 'PUBLIC' ? Buffer.from(input.body) : canonicalJson(payload.blob)), metadataCommitment: sha256(canonicalJson(metadata)), stagedAt: this.now(), lifecycle: 'PENDING' };
    await this.store.transact(state => {
      requireCondition(!Object.hasOwn(state.content, id), 'ContentAlreadyStaged', 409);
      state.content[id] = artifact;
    });
    return this.publicArtifact(id);
  }
  async confirm(requester: string, id: string): Promise<Omit<ContentArtifact, 'wrappedKey'>> {
    const artifact = this.get(id);
    requireCondition(requester === artifact.author, 'Unauthorized', 403);
    requireCondition(this.identityReader, 'ContentIdentityVerifierUnconfigured', 503);
    try {
      const identity = await this.identityReader.readContent(id);
      const fingerprint = await this.identityReader.readFingerprint(artifact.canonicalHash);
      requireCondition(identity && fingerprint && fingerprint.content === id && fingerprint.canonicalHash === artifact.canonicalHash, 'ContentNotConfirmed', 409);
      requireCondition(identity.id === id && identity.author === artifact.author && identity.rawHash === artifact.rawHash && identity.canonicalHash === artifact.canonicalHash && identity.canonicalizationVersion === artifact.canonicalizationVersion && identity.mode === artifact.mode && identity.quotePolicy === artifact.quotePolicy && identity.storageCommitment === artifact.storageCommitment && identity.metadataCommitment === artifact.metadataCommitment && identity.citationManifestCommitment === artifact.citationManifest.commitment, 'ChainContentMismatch', 409);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      throw new ServiceError('ContentIdentityVerifierUnavailable', 503);
    }
    await this.store.transact(state => {
      const current = state.content[id] as ContentArtifact;
      requireCondition(canonicalJson(current) === canonicalJson(artifact), 'ContentArtifactChanged', 409);
      // Confirmation changes only the local status, never signed commitments or key material.
      state.content[id] = { ...current, lifecycle: 'CONFIRMED' };
      state.fingerprints[artifact.canonicalHash] = id;
    });
    return this.publicArtifact(id);
  }
  async releaseKey(id: string, buyer: string): Promise<{ key: string; associatedData: string }> {
    walletKey(buyer);
    const artifact = this.get(id);
    requireCondition(artifact.mode === 'PAID', 'ContentNotPaid');
    // A cached event or client assertion never establishes paid access.
    let allowed = false;
    try { allowed = await this.receiptVerifier.hasAccess(id, buyer); } catch { requireCondition(false, 'AccessVerifierUnavailable', 503); }
    requireCondition(allowed, 'AccessReceiptRequired', 403);
    return { key: this.privateKey(artifact).toString('base64'), associatedData: `provena:body:v1:${id}` };
  }
  originalityRisk(body: string): { exactDuplicate: string | null; potentialSources: string[]; assessment: 'EXACT_DUPLICATE' | 'POTENTIAL_SIMILAR' | 'NO_MOCK_SIGNAL'; model: 'deterministic-mock-v1'; scope: 'OFFCHAIN_RISK_ONLY'; approved: false } {
    const hash = hashContent(body);
    const state = this.store.snapshot();
    const exactDuplicate = (Object.values(state.content) as ContentArtifact[]).filter(artifact => artifact.canonicalHash === hash.canonicalHash).map(artifact => artifact.id).sort()[0] ?? null;
    const grams = (text: string): Set<string> => { const units = Array.from(hashContent(text).canonicalBody); return new Set(units.slice(0, -3).map((_, index) => units.slice(index, index + 4).join(''))); };
    const candidate = grams(body);
    const potentialSources: string[] = [];
    for (const value of Object.values(state.content)) {
      const source = value as ContentArtifact;
      if (source.id === exactDuplicate) continue;
      const sourceGrams = grams(this.privateBody(source));
      const union = new Set([...candidate, ...sourceGrams]).size;
      const overlap = [...candidate].filter(gram => sourceGrams.has(gram)).length;
      if (union > 0 && overlap * 100 >= union * 70) potentialSources.push(source.id);
    }
    return { exactDuplicate, potentialSources: potentialSources.sort(), assessment: exactDuplicate ? 'EXACT_DUPLICATE' : potentialSources.length ? 'POTENTIAL_SIMILAR' : 'NO_MOCK_SIGNAL', model: 'deterministic-mock-v1', scope: 'OFFCHAIN_RISK_ONLY', approved: false };
  }
}
