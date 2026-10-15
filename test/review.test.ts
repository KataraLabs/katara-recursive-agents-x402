import { describe, expect, it, vi } from 'vitest';
import { digest } from '../src/sources.js';
import { reviewFindings, reviewSynopsis, policyIssue, sourceSpans, parseReviews } from '../src/review.js';
import { masterEvidence } from '../src/synopsis.js';
import { loadExample } from '../src/examples.js';
import { DemoError, type Finding, type Source } from '../src/types.js';
import { report } from './helpers.js';

const source: Source = { id: 'package', title: 'Package', url: 'https://example.com/package.json', retrievedAt: '2026-09-11', status: 200, sha256: 'rawhash', text: '1: {"scripts":{"test":"mocha"}}\n2: The two URLs are https://example.com/a and https://example.com/a.\n3: Price: $10.' };
const finding = (claim = 'The package has a test script.'): Finding => ({ claim, citations: [{ sourceId: source.id, startLine: 1, endLine: 1 }] });
const input = (findings = [finding()]) => {
  const r = report(loadExample('repository')); r.mode = 'mainnet'; r.sources = [structuredClone(source)];
  r.agents = [{ id: 'repository/child', title: 'Researcher', depth: 1, status: 'succeeded', startedAt: r.startedAt, children: [], output: { summary: 'Untrusted summary', findings, limitations: [] } }];
  return r;
};
const signal = () => new AbortController().signal;
describe('source-grounded master answers', () => {
  it('rejects invented setup commands, false URL differences, and unsupported quoted prices before model review', async () => {
    const r = input([finding('Run npm start to launch this package.'), finding('The URLs https://example.com/a and https://example.com/a are different.'), finding('The observed price is $99.')]);
    const complete = vi.fn(); await reviewFindings({ complete }, r, signal());
    expect(complete).not.toHaveBeenCalled();
    expect(r.evidenceReview!.findings.every(f => f.assessment?.verdict === 'unsupported')).toBe(true);
    expect(masterEvidence(r, true).findings).toEqual([]);
    expect(policyIssue('The proposed budget allocation is $99.', sourceSpans(finding().citations, [source]))).toBeUndefined();
  });
  it('rejects unavailable, zero-line, fractional and shortened source evidence', () => {
    for (const startLine of [0, -1, 0.5, Number.NaN]) expect(() => sourceSpans([{ sourceId: source.id, startLine, endLine: 1 }], [source])).toThrow('unsupported_source');
    expect(() => sourceSpans(finding().citations, [{ ...source, status: 404 }])).toThrow();
    expect(() => sourceSpans(finding().citations, [{ ...source, error: 'unavailable' }])).toThrow();
    expect(() => sourceSpans(finding().citations, [{ ...source, textSha256: digest('original full view') }])).toThrow();
  });
  it('fails closed on missing, duplicated and malformed review verdicts', async () => {
    expect(() => parseReviews('{"reviews":[]}', ['1'])).toThrow('review_invalid');
    expect(() => parseReviews('{"reviews":[{"id":"1","verdict":"supported","reason":"ok"},{"id":"1","verdict":"supported","reason":"ok"}]}', ['1', '2'])).toThrow();
    const r = input(); const complete = vi.fn().mockResolvedValue('{}');
    await reviewFindings({ complete }, r, signal());
    expect(complete).toHaveBeenCalledTimes(1); expect(r.evidenceReview!.findings[0]!.assessment?.verdict).toBe('uncertain');
    expect(masterEvidence(r, true).findings).toEqual([]);
  });
  it('does not hide cancellation or budget exhaustion behind an uncertain verdict', async () => {
    await expect(reviewFindings({ complete: async () => { throw new DemoError('budget_exhausted'); } }, input(), signal())).rejects.toThrow('budget_exhausted');
    const control = new AbortController();
    await expect(reviewFindings({ complete: async () => { control.abort(new DemoError('cancelled')); throw new Error(); } }, input(), control.signal)).rejects.toThrow('cancelled');
  });
  it('keeps only approved findings and records hashes, spans, and review call IDs', async () => {
    const r = input([finding(), finding('The package has no tests.')]);
    const complete = vi.fn(async () => {
      r.calls.push({ id: 'review-call', agentId: 'repository/master', purpose: 'review', requestedModel: 'katara/cortex@1', startedAt: r.startedAt, status: 'succeeded', authorizationIds: [] });
      return JSON.stringify({ reviews: [{ id: '1', verdict: 'supported', reason: 'Test script is present.' }, { id: '2', verdict: 'unsupported', reason: 'Test script contradicts this claim.' }] });
    });
    await reviewFindings({ complete }, r, signal());
    expect(masterEvidence(r, true).findings.map(f => f.claim)).toEqual([finding().claim]);
    const a = r.evidenceReview!.findings[0]!.assessment!;
    expect(a).toMatchObject({ callId: 'review-call', method: 'model', claimHash: digest(finding().claim) });
    expect(a.support[0]).toMatchObject({ sourceHash: source.sha256, spanHash: digest(source.text.split('\n')[0]!), startLine: 1, endLine: 1 });
    expect(complete.mock.calls[0]).toBeDefined();
  });
  it('replaces a contradicted master section and keeps its rejected draft for inspection', async () => {
    const r = input();
    await reviewFindings({ complete: async () => JSON.stringify({ reviews: [{ id: '1', verdict: 'supported', reason: 'The script exists.' }] }) }, r, signal());
    const findings = masterEvidence(r, true).findings;
    const draft = { summary: 'No test command was established.', completion: 'complete' as const, synopsis: [{ heading: 'Tests', body: 'No test command was established.', citations: finding().citations }], findings, limitations: [] };
    const complete = vi.fn().mockResolvedValue(JSON.stringify({ reviews: [{ id: 'summary', verdict: 'unsupported', reason: 'The test script was established.' }, { id: 'section-1', verdict: 'unsupported', reason: 'The test script was established.' }] }));
    const result = await reviewSynopsis({ complete }, r, draft, signal());
    expect(result.synopsis![0]!.body).toBe(finding().claim);
    expect(result.summary).not.toContain('No test command'); expect(result.completion).toBe('partial');
    expect(r.masterDraft).toEqual(draft); expect(result.review?.status).toBe('partial');
    expect(complete.mock.calls[0]![0].prompt).toContain('The package has a test script.');
  });
  it('bounds review batches and leaves excess findings uncertain', async () => {
    const r = input(Array.from({ length: 50 }, (_, i) => finding(`Observation ${i}`)));
    const complete = vi.fn(async request => JSON.stringify(request.fixtureOutput));
    await reviewFindings({ complete }, r, signal());
    expect(complete).toHaveBeenCalledTimes(4);
    expect(r.evidenceReview!.findings.filter(f => f.assessment?.verdict === 'supported')).toHaveLength(48);
    expect(r.evidenceReview!.findings.slice(48).every(f => f.assessment?.verdict === 'uncertain')).toBe(true);
  });
});
