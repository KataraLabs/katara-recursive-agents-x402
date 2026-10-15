/** @module Export completed, reviewed local reports and refresh result navigation without making network requests. */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { publicReport } from '../src/report.js';
import { assertExportable } from '../src/evidence.js';
import { exampleIds } from '../src/examples.js';
import { evidenceRoot, validRunId, writeEvidenceIndex } from './evidence-index.js';
import type { RunReport } from '../src/types.js';

mkdirSync(evidenceRoot, { recursive: true });
for (const id of process.argv.slice(2)) {
  if (!validRunId(id)) throw new Error('Invalid run ID');
  const local = new URL(`../.katara/runs/${id}/`, import.meta.url);
  const reports = readdirSync(local).filter(f => f.endsWith('.json')).map(file => JSON.parse(readFileSync(new URL(file, local), 'utf8')) as RunReport);
  if (!reports.length) throw new Error('No reports found');
  for (const report of reports) {
    if (!exampleIds.includes(report.example) || report.id !== id) throw new Error('Invalid evidence identity');
    assertExportable(report);
  }
  const destination = new URL(`${id}/`, evidenceRoot); mkdirSync(destination, { recursive: true });
  for (const report of reports) writeFileSync(new URL(`${report.example}.json`, destination), JSON.stringify(publicReport(report), null, 2) + '\n');
}
writeEvidenceIndex();
console.log('Updated local evidence and readable results.');
