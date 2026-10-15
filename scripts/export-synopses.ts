/** @module Export completed revisions only when their source-report hashes and current ledger accounting agree. */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Ledger } from '../src/ledger.js';
import { paymentLedgerPath } from '../src/config.js';
import { digest } from '../src/sources.js';
import { publicSynopsis } from '../src/report.js';
import { assertExportable } from '../src/evidence.js';
import { exampleIds } from '../src/examples.js';
import { evidenceRoot, validRunId, writeEvidenceIndex } from './evidence-index.js';
import type { RunReport, SynopsisRevision } from '../src/types.js';

for (const id of process.argv.slice(2)) {
  if (!validRunId(id)) throw new Error('Invalid revision ID');
  const local = new URL(`../.katara/synopses/${id}/`, import.meta.url);
  for (const file of readdirSync(local).filter(f => f.endsWith('.json'))) {
    const r = JSON.parse(readFileSync(new URL(file, local), 'utf8')) as SynopsisRevision;
    if (r.id !== id || !exampleIds.includes(r.example) || !validRunId(r.sourceRunId) || r.status === 'running' || !r.finishedAt) throw new Error('Revision must be complete');
    const bytes = readFileSync(new URL(`${r.sourceRunId}/${r.example}.json`, evidenceRoot), 'utf8');
    const base = JSON.parse(bytes) as RunReport;
    if (r.sourceReportHash !== digest(bytes) || r.mode !== base.mode) throw new Error('Original evidence changed');
    const first = r.payments[0];
    if (first) {
      const file = paymentLedgerPath(resolve('.katara'), first.from, first.asset, first.to, Number(first.network.split(':')[1]));
      if (!existsSync(file)) throw new Error('Payment ledger is required for revision export');
      r.payments = new Ledger(file).list(id).filter(a => a.agentId.startsWith(`${r.example}/`));
    }
    assertExportable({ ...base, result: r.output, evidenceReview: r.evidenceReview, calls: r.calls, payments: r.payments });
    const destination = new URL(`synopses/${id}/`, evidenceRoot); mkdirSync(destination, { recursive: true });
    writeFileSync(new URL(`${r.example}.json`, destination), JSON.stringify(publicSynopsis(r), null, 2) + '\n');
  }
}
writeEvidenceIndex();
console.log('Exported reviewed synopsis revisions; original run JSON retained.');
