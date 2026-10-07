import { createHash } from 'node:crypto';

/** V1 is permanent: changing normalization requires a new version. */
export const CANONICALIZATION_VERSION = 1 as const;
export function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function canonicalizeV1(body: string): string {
  return body.normalize('NFKC')
    .replace(/\r\n?|\u0085|\u2028|\u2029/g, '\n')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .split('\n').map(line => line.replace(/[^\S\n]+/gu, ' ').trim()).join('\n').trim();
}
export function hashContent(body: string): Readonly<{
  rawHash: string; canonicalHash: string; canonicalBody: string; canonicalizationVersion: 1;
}> {
  const canonicalBody = canonicalizeV1(body);
  return Object.freeze({ rawHash: sha256(Buffer.from(body, 'utf8')), canonicalHash: sha256(Buffer.from(canonicalBody, 'utf8')), canonicalBody, canonicalizationVersion: CANONICALIZATION_VERSION });
}
const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), part => part.segment);
}
export function graphemeLength(text: string): number {
  return graphemes(text).length;
}

export type QuotePolicy = 'NONE' | 'PREVIEW_ONLY' | 'LIMITED';
export type QuoteSurface = 'BODY' | 'PREVIEW' | 'TITLE' | 'PUBLIC_METADATA';
export interface CitationPolicy {
  readonly version: number;
  readonly absoluteGraphemeLimit: number;
  readonly sourceLimitBps: number;
  readonly renderedLimitBps: number;
}
export const DEFAULT_CITATION_POLICY: CitationPolicy = Object.freeze({
  version: 1, absoluteGraphemeLimit: 320, sourceLimitBps: 1000, renderedLimitBps: 2500,
});
export interface CitationSource {
  readonly contentId: string;
  readonly author: string;
  readonly body: string;
  readonly mode: 'PUBLIC' | 'PAID';
  readonly quotePolicy?: QuotePolicy;
  readonly preview?: string;
  readonly previewQuoteAllowed?: boolean;
  readonly title?: string;
  readonly publicMetadata?: string;
}
/** Offsets refer to grapheme clusters of the exact, unnormalized source surface. */
export interface SourceSegment { readonly start: number; readonly end: number; }
export interface CitationReference {
  readonly sourceContentId: string;
  readonly sourceAuthor: string;
  readonly citingContentId: string;
  readonly surface: QuoteSurface;
  readonly sourceSegments: readonly SourceSegment[];
  readonly excerpt: string;
}
export interface VerifiedCitationReference extends CitationReference { readonly excerptHash: string; }
export interface VerifiedCitationManifest {
  readonly version: 1;
  readonly policyVersion: number;
  readonly citingContentId: string;
  readonly references: readonly VerifiedCitationReference[];
  readonly commitment: string;
}
export class CitationError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'CitationError'; }
}
function fail(code: string): never { throw new CitationError(code); }
function validatePolicy(policy: CitationPolicy): void {
  if (!Number.isSafeInteger(policy.version) || policy.version < 1 ||
      !Number.isSafeInteger(policy.absoluteGraphemeLimit) || policy.absoluteGraphemeLimit < 1 ||
      !Number.isSafeInteger(policy.sourceLimitBps) || policy.sourceLimitBps < 0 || policy.sourceLimitBps > 10_000 ||
      !Number.isSafeInteger(policy.renderedLimitBps) || policy.renderedLimitBps < 0 || policy.renderedLimitBps > 10_000) fail('InvalidCitationPolicy');
}
function surfaceText(source: CitationSource, surface: QuoteSurface): string {
  switch (surface) {
    case 'BODY':
      if (source.mode === 'PAID' && (source.quotePolicy ?? 'NONE') !== 'LIMITED') fail('PaidBodyQuoteForbidden');
      return source.body;
    case 'PREVIEW':
      if (source.preview === undefined || (source.mode === 'PAID' && source.quotePolicy !== 'PREVIEW_ONLY' && source.quotePolicy !== 'LIMITED' && source.previewQuoteAllowed !== true)) fail('PreviewQuoteForbidden');
      return source.preview;
    case 'TITLE': if (source.title === undefined) fail('MissingQuoteSurface'); return source.title;
    case 'PUBLIC_METADATA': if (source.publicMetadata === undefined) fail('MissingQuoteSurface'); return source.publicMetadata;
    default: return fail('InvalidQuoteSurface');
  }
}
export function renderSourceSegments(source: string, segments: readonly SourceSegment[]): string {
  const units = graphemes(source);
  if (segments.length === 0) fail('EmptyCitation');
  let previousEnd = 0;
  const parts = segments.map(segment => {
    if (!Number.isSafeInteger(segment.start) || !Number.isSafeInteger(segment.end) || segment.start < previousEnd || segment.end <= segment.start || segment.end > units.length) fail('InvalidSourceSegment');
    previousEnd = segment.end;
    return units.slice(segment.start, segment.end).join('');
  });
  return parts.join('\n…\n');
}
/** Exact excerpt validation; manifests commit attribution as well as source offsets. */
export function validateCitationManifest(input: {
  citingContentId: string;
  renderedBody: string;
  references: readonly CitationReference[];
  sources: readonly CitationSource[];
  policy?: CitationPolicy;
}): VerifiedCitationManifest {
  const policy = input.policy ?? DEFAULT_CITATION_POLICY;
  validatePolicy(policy);
  if (!input.citingContentId) fail('WrongCitingContent');
  const sources = new Map<string, CitationSource>();
  for (const source of input.sources) {
    if (!source.contentId || !source.author || sources.has(source.contentId)) fail('AmbiguousCitationSource');
    sources.set(source.contentId, source);
  }
  const sourceTotals = new Map<string, number>();
  let quoteTotal = 0;
  const renderedUnits = graphemeLength(input.renderedBody);
  // Each reference must occupy its own occurrence; repeating a manifest cannot
  // pretend a single rendered quotation is several separately attributed quotes.
  const usedRanges: Array<readonly [number, number]> = [];
  const references = input.references.map(reference => {
    const source = sources.get(reference.sourceContentId);
    if (!source || source.author !== reference.sourceAuthor) fail('InvalidSourceAttribution');
    if (reference.citingContentId !== input.citingContentId || !input.citingContentId) fail('WrongCitingContent');
    const excerpt = renderSourceSegments(surfaceText(source, reference.surface), reference.sourceSegments);
    if (excerpt !== reference.excerpt) fail('ModifiedCitationExcerpt');
    let occurrence = input.renderedBody.indexOf(excerpt);
    while (occurrence >= 0 && usedRanges.some(([start, end]) => occurrence < end && occurrence + excerpt.length > start)) occurrence = input.renderedBody.indexOf(excerpt, occurrence + 1);
    if (occurrence < 0) fail('CitationMissingFromRenderedContent');
    usedRanges.push([occurrence, occurrence + excerpt.length]);
    const quotedLength = reference.sourceSegments.reduce((sum, segment) => sum + segment.end - segment.start, 0);
    quoteTotal += quotedLength;
    sourceTotals.set(source.contentId, (sourceTotals.get(source.contentId) ?? 0) + quotedLength);
    return Object.freeze({
      sourceContentId: reference.sourceContentId,
      sourceAuthor: reference.sourceAuthor,
      citingContentId: reference.citingContentId,
      surface: reference.surface,
      excerpt: reference.excerpt,
      sourceSegments: Object.freeze(reference.sourceSegments.map(segment => Object.freeze({ ...segment }))),
      excerptHash: sha256(Buffer.from(excerpt, 'utf8')),
    });
  });
  for (const [contentId, count] of sourceTotals) {
    const source = sources.get(contentId)!;
    if (count > policy.absoluteGraphemeLimit) fail('CitationAbsoluteLimitExceeded');
    if (BigInt(count) * 10_000n > BigInt(graphemeLength(source.body)) * BigInt(policy.sourceLimitBps)) fail('CitationSourceLimitExceeded');
  }
  if (BigInt(quoteTotal) * 10_000n > BigInt(renderedUnits) * BigInt(policy.renderedLimitBps)) fail('CitationRenderedLimitExceeded');
  const committed = { version: 1 as const, policyVersion: policy.version, citingContentId: input.citingContentId, references: Object.freeze(references) };
  // Field order is fixed above and the domain identifies this encoding forever.
  const commitment = sha256(Buffer.concat([Buffer.from('provena:citation:v1'), Buffer.from(JSON.stringify(committed), 'utf8')]));
  return Object.freeze({ ...committed, commitment });
}
