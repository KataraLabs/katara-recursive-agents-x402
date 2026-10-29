import { describe, expect, it, vi } from 'vitest';
import { digest } from '../src/sources.js';
import { reviewFindings, reviewSynopsis, policyIssue, sourceSpans, parseReviews, replacementFindings } from '../src/review.js';
import { renderReport } from '../src/report.js';
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
      r.calls.push({ id: 'review-call', agentId: 'repository/master', purpose: 'review', requestedModel: 'katara/cortex', startedAt: r.startedAt, status: 'succeeded', authorizationIds: [] });
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

// Shortened from the replaced sections of a Live run on 2026-10-15.
describe('replacing a rejected section', () => {
  const at = (sourceId: string, startLine: number, endLine: number) => ({ sourceId, startLine, endLine });
  const reviewed = (claim: string, citations: ReturnType<typeof at>[], verdict: 'supported' | 'uncertain' = 'supported'): Finding => ({ claim, citations, assessment: { verdict, reason: 'checked', method: 'model', checkedAt: '2026-10-15', claimHash: digest(claim), support: [] } });
  it('trip: drops unrelated place findings and says what is missing', () => {
    const cited = [at('fares', 81, 90), at('common', 2, 7), at('faneuil', 39, 40)];
    const findings = [
      reviewed('Boston Common, founded 1634, is described as America\'s oldest park, at 139 Tremont Street.', [at('common', 2, 7)]),
      reviewed('Faneuil Hall has free admission on all floors and a south-side ramp and elevator.', [at('faneuil', 39, 40)]),
      reviewed('A 1-Day Pass costs $11.00 and gives unlimited travel for 24 hours.', [at('fares', 81, 90)]),
    ];
    expect(replacementFindings('Budget allocation', cited, findings)).toEqual([]);
  });
  it('documentation: keeps one link-check finding, not three wordings of it', () => {
    const cited = [at('start-api', 27, 28), at('start-chat', 26, 27), at('networks', 50, 51)];
    const findings = [
      reviewed('Observed link evidence is limited: only two URLs were checked, both HTTP 200, so coverage is not exhaustive.', [at('start-api', 27, 28)]),
      reviewed('Observed link checks sampled two URLs, the docs root and the API start page, both returning status 200; the page notes this is not an exhaustive crawl.', [at('start-api', 27, 28)]),
      reviewed('Observed link checks in both sources report only 200 statuses for the docs home and chat pages; no broken links are reported in these bounded samples.', [at('start-chat', 26, 27)]),
    ];
    expect(replacementFindings('Audit coverage and next steps', cited, findings).map(f => f.claim)).toEqual([findings[0]!.claim]);
  });
  it('comparison: removes a repeated plan line, by wording and by claim hash', () => {
    const cited = [at('neon-pricing', 4, 12), at('neon-pricing', 17, 24)];
    const plan = reviewed('Neon pricing lists the Free plan at $0 with 100 projects and 1 GB storage per project.', [at('neon-pricing', 4, 12)]);
    const findings = [
      plan, structuredClone(plan),
      reviewed('Neon Free plan pricing: $0, 100 projects, 1 GB storage per project, no credit card.', [at('neon-pricing', 17, 24)]),
      reviewed('Neon Launch pricing is usage-based at $0.106 per CU-hour.', [at('neon-pricing', 17, 24)]),
    ];
    expect(replacementFindings('Neon pricing', cited, findings).map(f => f.claim)).toEqual([plan.claim, findings[3]!.claim]);
    expect(replacementFindings('Decision summary', cited, findings)).toEqual([]);
  });
  it('never uses unreviewed, uncertain or altered findings', () => {
    const cited = [at('neon-pricing', 4, 12)];
    const altered = reviewed('Neon pricing lists a Free plan.', cited); altered.claim = 'Neon pricing lists a free unlimited plan.';
    const findings = [{ claim: 'Neon pricing is free.', citations: cited }, reviewed('Neon pricing is unclear.', cited, 'uncertain'), altered];
    expect(replacementFindings('Neon pricing', cited, findings)).toEqual([]);
  });
  it('keeps the heading, marks the section replaced and shows the reason in the report', async () => {
    const r = input();
    await reviewFindings({ complete: async () => JSON.stringify({ reviews: [{ id: '1', verdict: 'supported', reason: 'The script exists.' }] }) }, r, signal());
    const findings = masterEvidence(r, true).findings;
    const draft = { summary: 'A plan.', completion: 'complete' as const, synopsis: [{ heading: 'Budget allocation', body: 'Spend most of the money on lunch.', citations: finding().citations }], findings, limitations: [] };
    const complete = vi.fn().mockResolvedValue(JSON.stringify({ reviews: [{ id: 'summary', verdict: 'supported', reason: 'ok' }, { id: 'section-1', verdict: 'unsupported', reason: 'Budget allocation lacks source support' }] }));
    const result = await reviewSynopsis({ complete }, r, draft, signal());
    expect(result.synopsis![0]).toMatchObject({ heading: 'Budget allocation', body: 'Not supported by the collected sources. Review: Budget allocation lacks source support.', citations: [], replaced: { verdict: 'unsupported', reason: 'Budget allocation lacks source support' } });
    r.result = result;
    const html = renderReport(r);
    expect(html).toContain('Replaced after review (unsupported: Budget allocation lacks source support)');
    expect(html.slice(0, html.indexOf('evidence-panel'))).not.toContain('Spend most of the money on lunch.');
  });
});
