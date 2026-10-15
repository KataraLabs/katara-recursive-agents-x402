/** @module Create bounded master-answer revisions while retaining immutable public inputs and private source snapshots. */
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, money, ledgerPath } from '../src/config.js';
import { Ledger, acquireWalletLock, atomicJson } from '../src/ledger.js';
import { AvalancheChain } from '../src/chain.js';
import { PaidInference, FixtureInference } from '../src/inference.js';
import { createReviewedSynopsis } from '../src/synopsis.js';
import { verifySupportSnapshot } from '../src/evidence.js';
import type { Inference } from '../src/inference.js';
import { exampleIds } from '../src/examples.js';
import { digest } from '../src/sources.js';
import { DemoError, errorCode, type RunReport, type SynopsisRevision, type CallEvidence } from '../src/types.js';

/**
 * Require matching input snapshots and explicit live spending caps, then record reviewed revisions and reconcile their payments.
 */
async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { budget: { type: 'string' }, 'total-cap': { type: 'string' }, offline: { type: 'boolean', default: false } } });
  const [sourceRunId, target = 'all'] = positionals;
  if (!sourceRunId || !/^[\da-zTZ-]+$/i.test(sourceRunId)) throw new DemoError('run_not_found');
  const chosen = target === 'all' ? exampleIds : target.split(',');
  const ids = exampleIds.filter(id => chosen.includes(id));
  if (!ids.length || ids.length !== new Set(chosen).size) throw new DemoError('unknown_example');
  if (!values.offline && (!values.budget || !values['total-cap'])) throw new DemoError('budget_required', 'Supply --budget for this revision and --total-cap for cumulative wallet spending.');
  const inputs = ids.map(example => {
    const bytes = readFileSync(join('evidence', sourceRunId, `${example}.json`), 'utf8');
    const published = JSON.parse(bytes) as RunReport;
    const report = JSON.parse(readFileSync(join('.katara', 'runs', sourceRunId, 'support', `${example}.json`), 'utf8')) as RunReport;
    verifySupportSnapshot(published, report);
    if (report.id !== sourceRunId || report.example !== example || !report.finishedAt || report.status === 'running') throw new DemoError('run_incomplete');
    if (report.mode !== (values.offline ? 'fixture' : 'mainnet')) throw new DemoError('revision_mode_mismatch');
    return { report, hash: digest(bytes) };
  });
  const config = loadConfig({ budget: values.budget ?? '0.10', fixture: values.offline });
  const release = values.offline ? () => {} : acquireWalletLock(config.stateDir, config.wallet!.address);
  const stop = new AbortController();
  const interrupt = () => stop.abort(new DemoError('cancelled'));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const chain = values.offline ? undefined : new AvalancheChain(config, { signal: stop.signal });
    const ledger = values.offline ? undefined : new Ledger(ledgerPath(config));
    if (chain && ledger) {
      await chain.check(); await chain.reconcile(ledger);
      if (ledger.pending()) console.log('Previous pending authorizations remain reserved in the cumulative cap.');
      const remaining = money(values['total-cap']!) - ledger.exposure();
      if (remaining <= 0n) throw new DemoError('budget_exhausted');
      if (config.budget > remaining) config.budget = remaining;
      console.log(`Synopsis budget: ${config.budget} base units; existing cumulative spend: ${ledger.exposure()} base units.`);
    }
    const id = new Date().toISOString().replace(/[-:.]/g, '') + '-' + randomUUID().slice(0, 8);
    const implementationFingerprint = Object.fromEntries(['src/synopsis.ts', 'src/review.ts', 'src/evidence.ts', 'src/inference.ts', 'src/ledger.ts', 'src/chain.ts', 'src/config.ts', 'src/types.ts', 'scripts/build-synopses.ts', 'package-lock.json'].map(file => [file, digest(readFileSync(file, 'utf8'))]));
    ledger?.begin(id, config.budget);
    for (const { report, hash } of inputs) {
      if (stop.signal.aborted || (ledger && ledger.exposure(id) >= config.budget)) break;
      const revision: SynopsisRevision = { version: 1, id, sourceRunId, sourceReportHash: hash, implementationFingerprint, example: report.example, mode: values.offline ? 'fixture' : 'mainnet', startedAt: new Date().toISOString(), status: 'running', calls: [], payments: [], validationIssues: [] };
      const save = () => {
        revision.payments = ledger?.list(id).filter(a => a.agentId.startsWith(`${report.example}/`)) ?? [];
        atomicJson(join(config.stateDir, 'synopses', id, `${report.example}.json`), revision);
      };
      const record = (call: CallEvidence) => {
        const n = revision.calls.findIndex(c => c.id === call.id);
        if (n < 0) revision.calls.push(structuredClone(call)); else revision.calls[n] = structuredClone(call);
        report.calls = revision.calls;
        if (call.status !== 'running') console.log(`${report.example}: ${call.purpose} ${call.status}${call.error ? ` (${call.error})` : ''}`);
        save();
      };
      const inference = values.offline ? new FixtureInference(record) : new PaidInference(config, ledger!, chain!, id, record);
      let steps = 0;
      const bounded: Inference = { complete: (request, signal) => {
        if (++steps > 8) throw new DemoError('agent_step_limit');
        return inference.complete(request, signal);
      } };
      try {
        revision.output = await createReviewedSynopsis(bounded, report, AbortSignal.any([stop.signal, AbortSignal.timeout(240_000)]), (attempt, detail) => { revision.validationIssues.push({ attempt, detail }); save(); }, text => { revision.draftText = text; save(); });
        revision.status = 'succeeded';
      } catch (error) { revision.status = 'failed'; revision.error = errorCode(error); process.exitCode = 1; }
      revision.evidenceReview = report.evidenceReview;
      revision.masterDraft = report.masterDraft;
      revision.finishedAt = new Date().toISOString(); save();
      if (chain && ledger) { try { await chain.reconcile(ledger); } catch { console.log('Settlement is pending; run reconciliation before exporting.'); } }
      save();
      console.log(`${report.example}: synopsis ${revision.status}`);
    }
    console.log(`Synopsis revision: ${id}`);
    if (ledger) console.log(`Cumulative exposure: ${ledger.exposure()} base units; revision exposure: ${ledger.exposure(id)}.`);
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); release(); }
}
main().catch(error => { console.error(errorCode(error)); process.exitCode = 1; });
