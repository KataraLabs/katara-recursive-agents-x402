import { describe, expect, it, vi } from 'vitest';
import { createMasterSynopsis, masterEvidence, parseSynopsis, synopsisHeadings } from '../src/synopsis.js';
import { digest } from '../src/sources.js';
import { renderReport } from '../src/report.js';
import { loadExample } from '../src/examples.js';
import { report } from './helpers.js';
import type { Finding, SynopsisRevision } from '../src/types.js';

const finding: Finding = { claim: 'A recorded observation', citations: [{ sourceId: 'source', startLine: 2, endLine: 3 }], assessment: { verdict: 'supported', reason: 'Recorded support', method: 'fixture', claimHash: digest('A recorded observation'), checkedAt: new Date().toISOString(), support: [] } };
const payload = () => ({ summary: 'A proposed day plan with gaps clearly identified.', completion: 'partial', sections: synopsisHeadings.trip.map(heading => ({ heading, body: 'This proposed part of the visit is based on the recorded observation. The available evidence does not confirm an opening time or a ticket price, so the visitor should check those details before relying on this arrangement. The proposal is not a reservation.', evidence: [1] })), limitations: ['Opening hours remain unverified.'] });
const input = () => {
  const r = report(loadExample('trip'));
  r.agents = [{ id: 'trip/child', depth: 1, title: 'Child', startedAt: r.startedAt, status: 'succeeded', children: [], output: { summary: 'UNSUPPORTED CHILD SUMMARY MUST NOT ENTER PROMPT', findings: [finding], limitations: ['Opening hours remain unverified.'] } }];
  return r;
};

describe('master synopsis', () => {
  it('requires a substantive answer covering every scenario section with valid evidence references', () => {
    const p = payload(); const out = parseSynopsis(JSON.stringify(p), 'trip', [finding]);
    expect(out.synopsis).toHaveLength(4); expect(out.synopsis![0]!.citations).toEqual(finding.citations);
    expect(out.completion).toBe('partial'); expect(out.findings).toEqual([finding]);
    for (const bad of [0, '1', 1.5]) {
      const changed: any = payload(); changed.sections[0].evidence = [bad];
      expect(() => parseSynopsis(JSON.stringify(changed), 'trip', [finding])).toThrow('Evidence numbers');
    }
    p.sections.pop(); expect(() => parseSynopsis(JSON.stringify(p), 'trip', [finding])).toThrow('requested sections');
    const brief = payload(); brief.sections.forEach(s => s.body = 'Too short.');
    expect(() => parseSynopsis(JSON.stringify(brief), 'trip', [finding])).toThrow('at least 150 words');
  });
  it('rejects missing evidence instead of displaying its unsupported claims', () => {
    const p = payload(); p.sections[0]!.evidence = [1, 99];
    expect(() => parseSynopsis(JSON.stringify(p), 'trip', [finding])).toThrow('Cite only supplied finding numbers');
  });
  it('requires missing evidence to be named and preserves singular limitation normalization', () => {
    const p: any = payload(); p.limitation = p.limitations[0]; delete p.limitations;
    expect(parseSynopsis(JSON.stringify(p), 'trip', [finding]).limitations).toEqual([p.limitation]);
    delete p.limitation;
    expect(() => parseSynopsis(JSON.stringify(p), 'trip', [finding])).toThrow('partial answer');
  });
  it('accepts natural prose with evidence markers and rejects template placeholder answers', () => {
    const p = payload();
    const prose = p.summary + '\n\n' + p.sections.map(s => `## ${s.heading}\n\n${s.body} [1]`).join('\n\n') + '\n\n## Remaining gaps\n- Opening hours remain unverified.\nCoverage: partial';
    const out = parseSynopsis(prose, 'trip', [finding]);
    expect(out.synopsis).toHaveLength(4); expect(out.synopsis![0]!.citations).toEqual(finding.citations);
    expect(out.synopsis![0]!.body).not.toContain('[1]'); expect(out.limitations).toEqual(p.limitations);
    const withoutOpening = prose.slice(prose.indexOf('## Proposed day plan'));
    expect(parseSynopsis(withoutOpening, 'trip', [finding]).summary).toContain('This proposed part');
    p.summary = 'a direct opening answer';
    expect(() => parseSynopsis(JSON.stringify(p), 'trip', [finding])).toThrow('template placeholder');
  });
  it('uses child findings rather than their unsupported summaries, and bounds paid repairs', async () => {
    const r = input();
    expect(masterEvidence(r).findings).toEqual([finding]);
    const complete = vi.fn().mockResolvedValueOnce('{}').mockResolvedValueOnce(JSON.stringify(payload()));
    const invalid = vi.fn();
    await createMasterSynopsis({ complete }, r, new AbortController().signal, invalid);
    expect(complete).toHaveBeenCalledTimes(2); expect(invalid).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]![0].maxTokens).toBe(2048);
    expect(complete.mock.calls[0]![0].prompt).not.toContain('UNSUPPORTED CHILD SUMMARY');
    expect(complete.mock.calls[1]![0].purpose).toBe('repair');
    complete.mockReset().mockResolvedValue('{}');
    await expect(createMasterSynopsis({ complete }, r, new AbortController().signal)).rejects.toThrow();
    expect(complete).toHaveBeenCalledTimes(2);
  });
  it('renders the synopsis before collapsed evidence and preserves the historical report', () => {
    const r = input(); r.result = { summary: 'Original short answer', findings: [finding], limitations: [] };
    const output = parseSynopsis(JSON.stringify(payload()), 'trip', [finding]);
    output.synopsis![0]!.body += '\n\n<script>alert(1)</script>';
    const revision: SynopsisRevision = { version: 1, id: 'revision', sourceRunId: r.id, sourceReportHash: 'hash', implementationFingerprint: {}, example: 'trip', startedAt: r.startedAt, mode: 'mainnet', status: 'succeeded', output, calls: [], payments: [], validationIssues: [] };
    const before = JSON.stringify(r); const html = renderReport(r, revision);
    expect(html.indexOf('Proposed day plan')).toBeLessThan(html.indexOf('class="evidence-panel"'));
    expect(html).toContain('<details class="evidence-panel"'); expect(html).not.toContain('<details open');
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>');
    expect(html).toContain('Original short answer'); expect(html).toContain('Partial answer: the evidence review kept out details');
    expect(JSON.stringify(r)).toBe(before);
  });
});
