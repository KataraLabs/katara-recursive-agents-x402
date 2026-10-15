import { describe, expect, it } from 'vitest';
import { Runtime } from '../src/runtime.js';
import { SourceCollector } from '../src/sources.js';
import { FixtureInference } from '../src/inference.js';
import { loadExample } from '../src/examples.js';
import { assertExportable, verifySupportSnapshot } from '../src/evidence.js';
import { publicReport } from '../src/report.js';
import { report } from './helpers.js';

async function result() {
  const e = loadExample('documentation'); const r = report(e);
  await new Runtime(new FixtureInference(c => r.calls.push(c)), new SourceCollector(e, true), r, 1, new AbortController().signal, () => {}).run(e);
  return r;
}
describe('public evidence provenance', () => {
  it('exports labeled fixtures and checks private snapshot hashes without relying on truncated public excerpts', async () => {
    const full = await result(); const published = publicReport(full);
    expect(() => assertExportable(published)).not.toThrow();
    expect(() => verifySupportSnapshot(published, full)).not.toThrow();
    full.sources[0]!.text += '\nchanged';
    expect(() => verifySupportSnapshot(published, full)).toThrow('support_snapshot_mismatch');
  });
  it('refuses to relabel old or synthetic records as mainnet evidence', async () => {
    const r = await result();
    expect(() => assertExportable({ ...r, mode: 'development' as any })).toThrow('unsupported_evidence_mode');
    expect(() => assertExportable({ ...r, mode: 'mainnet' })).toThrow('mainnet_evidence_mismatch');
    expect(() => assertExportable({ ...r, payments: [{ value: '1' } as any] })).toThrow('fixture_evidence_mismatch');
  });
  it('blocks unreviewed answers and claims changed after review', async () => {
    const r = await result(); const withoutReview = structuredClone(r); delete withoutReview.result!.review;
    expect(() => assertExportable(withoutReview)).toThrow('unreviewed_result');
    r.result!.findings[0]!.claim = 'Changed after review';
    expect(() => assertExportable(r)).toThrow('unreviewed_result');
  });
});
