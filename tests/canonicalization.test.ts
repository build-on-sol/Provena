import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  canonicalizeV1, hashContent, graphemeLength, renderSourceSegments,
  validateCitationManifest, CitationReference, CitationSource, DEFAULT_CITATION_POLICY,
} from '../packages/canonicalization/src/index';

const source: CitationSource = { contentId: 'source-a', author: 'author-a', body: '甲'.repeat(1000), mode: 'PUBLIC' };
function reference(count = 100, surface: CitationReference['surface'] = 'BODY'): CitationReference {
  return { sourceContentId: source.contentId, sourceAuthor: source.author, citingContentId: 'new-content', surface,
    sourceSegments: [{ start: 0, end: count }], excerpt: '甲'.repeat(count) };
}
function manifest(ref = reference(), overrides: Partial<Parameters<typeof validateCitationManifest>[0]> = {}) {
  return validateCitationManifest({ citingContentId: 'new-content', renderedBody: ref.excerpt + '论'.repeat(300), references: [ref], sources: [source], ...overrides });
}

test('canonicalization V1 fixes NFKC/newline/zero-width/horizontal whitespace deterministically', () => {
  const raw = ' Ａ\u200B\tB\r\n e\u0301\u00A0C \r\uFEFF ';
  assert.equal(canonicalizeV1(raw), 'A B\né C');
  const hashes = hashContent(raw);
  assert.equal(hashes.rawHash, createHash('sha256').update(Buffer.from(raw, 'utf8')).digest('hex'));
  assert.equal(hashes.canonicalHash, hashContent('A B\né C').canonicalHash);
  assert.notEqual(hashes.rawHash, hashes.canonicalHash);
  assert.equal(hashes.canonicalizationVersion, 1);
  assert.ok(Object.isFrozen(hashes));
});
test('fingerprints are globally content-derived and preserve meaningful paragraph boundaries', () => {
  assert.equal(hashContent('Ａ \r\nB').canonicalHash, hashContent('A\nB').canonicalHash);
  assert.notEqual(hashContent('A\nB').canonicalHash, hashContent('AB').canonicalHash);
  assert.equal(canonicalizeV1('A\n\n B'), 'A\n\nB');
});
test('grapheme counts treat joined emoji and combining characters as user-perceived units', () => {
  assert.equal(graphemeLength('👨‍👩‍👧‍👦e\u0301🇨🇳'), 3);
  const body = 'a👨‍👩‍👧‍👦e\u0301z';
  assert.equal(renderSourceSegments(body, [{ start: 1, end: 3 }]), '👨‍👩‍👧‍👦e\u0301');
  assert.equal(renderSourceSegments(body, [{ start: 0, end: 1 }, { start: 3, end: 4 }]), 'a\n…\nz');
});
test('citation manifests validate exact source text and commit mandatory attribution', () => {
  const result = manifest();
  assert.equal(result.references[0]!.sourceAuthor, source.author);
  assert.equal(result.references[0]!.sourceContentId, source.contentId);
  assert.equal(result.references[0]!.excerptHash, createHash('sha256').update(reference().excerpt).digest('hex'));
  assert.ok(Object.isFrozen(result.references));
  assert.ok(Object.isFrozen(result.references[0]!.sourceSegments[0]));
  const ref = reference();
  const reordered: CitationReference = { excerpt: ref.excerpt, sourceSegments: ref.sourceSegments, surface: ref.surface, citingContentId: ref.citingContentId, sourceAuthor: ref.sourceAuthor, sourceContentId: ref.sourceContentId };
  assert.equal(manifest(reordered).commitment, result.commitment);
  assert.throws(() => manifest({ ...ref, excerpt: '乙' + ref.excerpt.slice(1) }), /ModifiedCitationExcerpt/);
  assert.throws(() => manifest({ ...ref, sourceAuthor: 'attacker' }), /InvalidSourceAttribution/);
  assert.throws(() => manifest({ ...ref, citingContentId: 'another-content' }), /WrongCitingContent/);
  assert.throws(() => manifest(ref, { renderedBody: '论'.repeat(400) }), /CitationMissingFromRenderedContent/);
});
test('citation thresholds are inclusive and integer-checked for source and rendered totals', () => {
  manifest(); // 100/1000 source and 100/400 rendered.
  assert.throws(() => manifest(reference(101), { renderedBody: '甲'.repeat(101) + '论'.repeat(303) }), /CitationSourceLimitExceeded/);
  assert.throws(() => manifest(reference(), { renderedBody: '甲'.repeat(100) + '论'.repeat(299) }), /CitationRenderedLimitExceeded/);
  assert.throws(() => manifest(reference(321), { sources: [{ ...source, body: '甲'.repeat(5000) }], renderedBody: '甲'.repeat(321) + '论'.repeat(963) }), /CitationAbsoluteLimitExceeded/);
});
test('splitting one source into several citations cannot evade aggregate source limits', () => {
  const ref = reference();
  assert.throws(() => manifest(ref, { references: [ref, ref], renderedBody: ref.excerpt + '论' + ref.excerpt + '论'.repeat(700) }), /CitationSourceLimitExceeded/);
  assert.throws(() => manifest(ref, { references: [ref, ref] }), /CitationMissingFromRenderedContent/);
});
test('structured omissions require ordered disjoint source segments without edits', () => {
  const customSource: CitationSource = { ...source, body: '甲乙丙丁'.repeat(250) };
  const segments = [{ start: 0, end: 2 }, { start: 4, end: 6 }];
  const excerpt = renderSourceSegments(customSource.body, segments);
  manifest({ ...reference(4), sourceSegments: segments, excerpt }, { sources: [customSource], renderedBody: excerpt + '论'.repeat(100) });
  assert.throws(() => renderSourceSegments(customSource.body, [{ start: 0, end: 5 }, { start: 4, end: 6 }]), /InvalidSourceSegment/);
  assert.throws(() => renderSourceSegments(customSource.body, [{ start: 0.1, end: 2 }]), /InvalidSourceSegment/);
  assert.throws(() => renderSourceSegments(customSource.body, []), /EmptyCitation/);
});
test('paid body defaults NONE; paid previews require explicit author permission', () => {
  const paid: CitationSource = { ...source, mode: 'PAID', preview: '甲'.repeat(100) };
  assert.throws(() => manifest(reference(), { sources: [paid] }), /PaidBodyQuoteForbidden/);
  assert.throws(() => manifest(reference(100, 'PREVIEW'), { sources: [paid] }), /PreviewQuoteForbidden/);
  manifest(reference(100, 'PREVIEW'), { sources: [{ ...paid, previewQuoteAllowed: true }] });
  manifest(reference(100, 'PREVIEW'), { sources: [{ ...paid, quotePolicy: 'PREVIEW_ONLY' }] });
  assert.throws(() => manifest(reference(), { sources: [{ ...paid, quotePolicy: 'PREVIEW_ONLY' }] }), /PaidBodyQuoteForbidden/);
  manifest(reference(), { sources: [{ ...paid, quotePolicy: 'LIMITED' }] });
  manifest(reference(100, 'TITLE'), { sources: [{ ...paid, title: '甲'.repeat(100) }] });
});
test('citation policy is explicit, versioned and validated', () => {
  const wider = { ...DEFAULT_CITATION_POLICY, version: 2, sourceLimitBps: 2000 };
  manifest(reference(150), { renderedBody: '甲'.repeat(150) + '论'.repeat(450), policy: wider });
  assert.throws(() => manifest(reference(), { policy: { ...wider, sourceLimitBps: 10001 } }), /InvalidCitationPolicy/);
  assert.throws(() => manifest(reference(), { policy: { ...wider, absoluteGraphemeLimit: 0 } }), /InvalidCitationPolicy/);
  assert.throws(() => manifest(reference(), { sources: [source, source] }), /AmbiguousCitationSource/);
});
