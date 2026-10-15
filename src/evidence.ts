/** @module Publication and source-snapshot checks that preserve recorded research and payment identity. */
import { MAINNET } from './config.js';
import { digest } from './sources.js';
import { DemoError, type RunReport } from './types.js';

/**
 * Refuse incomplete, mislabeled or unreviewed reports before public export.
 * @throws DemoError for mode, model, token or reviewed-claim hash mismatches. This is not a substitute for on-chain reconciliation.
 */
export function assertExportable(report: RunReport): void {
  if (!report.finishedAt || report.status === 'running') throw new DemoError('run_incomplete');
  if (report.mode === 'fixture') {
    if (report.payments.length || report.sources.some(s => !s.fixture) || report.calls.some(c => c.requestedModel !== 'fixture (no inference)')) throw new DemoError('fixture_evidence_mismatch');
  } else if (report.mode === 'mainnet') {
    if (report.network !== MAINNET.network || report.gateway !== MAINNET.gateway || report.model !== MAINNET.model || report.sources.some(s => s.fixture) || report.calls.some(c => c.requestedModel !== MAINNET.model) || report.payments.some(p => p.network !== MAINNET.network || p.asset.toLowerCase() !== MAINNET.asset.toLowerCase())) throw new DemoError('mainnet_evidence_mismatch');
  } else throw new DemoError('unsupported_evidence_mode');
  if (report.result && (!report.result.review || !report.evidenceReview || report.result.findings.some(f => f.assessment?.verdict !== 'supported' || f.assessment.claimHash !== digest(f.claim)))) throw new DemoError('unreviewed_result');
}

/**
 * Require a matching private source view before revising an exported answer.
 * @param published The immutable public input report; its source text may be truncated.
 * @param snapshot The local full source view whose hashes must match.
 * @throws DemoError when the records or source hashes differ.
 */
export function verifySupportSnapshot(published: RunReport, snapshot: RunReport): void {
  assertExportable(published);
  assertExportable(snapshot);
  if (published.id !== snapshot.id || published.example !== snapshot.example || published.mode !== snapshot.mode || published.sources.length !== snapshot.sources.length) throw new DemoError('support_snapshot_mismatch');
  for (const source of published.sources) {
    const full = snapshot.sources.find(s => s.id === source.id);
    if (!full || full.sha256 !== source.sha256 || !source.textSha256 || digest(full.text) !== source.textSha256 || full.textSha256 !== source.textSha256) throw new DemoError('support_snapshot_mismatch');
  }
}
