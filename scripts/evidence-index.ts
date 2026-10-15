/** @module Build local result navigation without relabeling modes or changing original report JSON. */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatUnits } from 'viem';
import { assertExportable } from '../src/evidence.js';
import { document, escapeHtml as h, renderReport, totals } from '../src/report.js';
import { digest } from '../src/sources.js';
import { exampleIds } from '../src/examples.js';
import type { RunReport, SynopsisRevision } from '../src/types.js';

/** Public export directory inside the checkout; this is not a hosting destination. */
export const evidenceRoot = new URL('../evidence/', import.meta.url);
/** Accept generated run-directory names without allowing path separators or traversal. */
export const validRunId = (id: string): boolean => /^\d{8}T[\da-zTZ-]+$/i.test(id);
/**
 * Validate exported report/revision identity, select the latest reviewed answer and regenerate HTML plus accounting indexes. All writes remain local.
 */
export function writeEvidenceIndex(): void {
  const reports: { report: RunReport; bytes: string }[] = [];
  for (const dir of readdirSync(evidenceRoot, { withFileTypes: true }).filter(d => d.isDirectory() && validRunId(d.name))) {
    for (const file of readdirSync(new URL(`${dir.name}/`, evidenceRoot)).filter(f => f.endsWith('.json'))) {
      const bytes = readFileSync(new URL(join(dir.name, file), evidenceRoot), 'utf8');
      const report = JSON.parse(bytes) as RunReport;
      if (report.id !== dir.name || !exampleIds.includes(report.example)) throw new Error('Invalid evidence identity');
      assertExportable(report); reports.push({ report, bytes });
    }
  }
  const revisions: SynopsisRevision[] = [];
  const revisionRoot = new URL('synopses/', evidenceRoot);
  if (existsSync(revisionRoot)) for (const dir of readdirSync(revisionRoot, { withFileTypes: true }).filter(d => d.isDirectory() && validRunId(d.name))) {
    for (const file of readdirSync(new URL(`${dir.name}/`, revisionRoot)).filter(f => f.endsWith('.json'))) {
      const revision = JSON.parse(readFileSync(new URL(`${dir.name}/${file}`, revisionRoot), 'utf8')) as SynopsisRevision;
      const base = reports.find(r => r.report.id === revision.sourceRunId && r.report.example === revision.example);
      if (!base || revision.id !== dir.name || revision.mode !== base.report.mode || digest(base.bytes) !== revision.sourceReportHash) throw new Error('Synopsis input does not match recorded evidence');
      if (revision.status === 'succeeded') assertExportable({ ...base.report, result: revision.output, evidenceReview: revision.evidenceReview, calls: revision.calls, payments: revision.payments });
      revisions.push(revision);
    }
  }
  const rows: string[] = [];
  const newest = new Map<string, RunReport>();
  for (const { report: base } of reports.sort((a, b) => b.report.startedAt.localeCompare(a.report.startedAt))) {
    const revision = revisions.filter(r => r.sourceRunId === base.id && r.example === base.example && r.status === 'succeeded' && r.output).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    const report = revision ? { ...base, result: revision.output, calls: [...base.calls, ...revision.calls], payments: [...base.payments, ...revision.payments] } : base;
    const sum = totals(report);
    writeFileSync(new URL(`${base.id}/${base.example}.html`, evidenceRoot), renderReport(base, revision).replace('<main>', `<main><p><a href="../results.html">All demo results</a> · <a href="../index.html">Recorded runs</a> · <a href="${base.example}.json">Run JSON</a>${revision ? ` · <a href="../synopses/${revision.id}/${revision.example}.json">Revision JSON</a>` : ''}</p>`));
    rows.push(`<tr><td><a href="${base.id}/${base.example}.html">${h(base.title)}</a></td><td>${h(base.mode)} · ${h(base.status)}<br>${h(base.startedAt)}</td><td>${base.agents.length}/${base.plannedAgents}</td><td>${report.calls.length}</td><td>${formatUnits(sum.spent, 6)} confirmed<br>${formatUnits(sum.pending, 6)} pending</td></tr>`);
    const previous = newest.get(base.example);
    if (report.result && (!previous || (previous.mode === 'fixture' && report.mode === 'mainnet'))) newest.set(base.example, report);
  }
  const payments = [...new Map([...reports.flatMap(r => r.report.payments), ...revisions.flatMap(r => r.payments)].map(p => [p.id, p])).values()];
  const sums = totals({ payments } as RunReport);
  const accounting = `${formatUnits(sums.spent, 6)} USDC confirmed; ${formatUnits(sums.pending, 6)} USDC reserved in pending authorizations across exported records.`;
  writeFileSync(new URL('index.json', evidenceRoot), JSON.stringify({ reports: reports.map(r => ({ id: r.report.id, example: r.report.example, mode: r.report.mode, status: r.report.status })), revisions: revisions.map(r => ({ id: r.id, example: r.example, sourceRunId: r.sourceRunId, mode: r.mode, status: r.status })), confirmedUnits: String(sums.spent), pendingUnits: String(sums.pending) }, null, 2) + '\n');
  writeFileSync(new URL('index.html', evidenceRoot), document('Recorded runs', `<p><a href="../docs/index.html">Demo guide</a> · <a href="results.html">Read the master answers</a></p><h1>Recorded runs</h1><div class="banner">Fixture records contain synthetic data and no payments. Mainnet records identify native USDC payments on Avalanche C-Chain. Agent execution, source review, answer coverage, and settlement are separate results.</div><p>${accounting} <a href="index.json">Accounting JSON</a></p><div class="scroll"><table><thead><tr><th>Result</th><th>Mode / status / time</th><th>Executed / planned agents</th><th>Calls</th><th>USDC</th></tr></thead><tbody>${rows.join('') || '<tr><td colspan="5">No exported runs.</td></tr>'}</tbody></table></div>`));
  const cards = exampleIds.map(id => {
    const r = newest.get(id); if (!r) return '';
    return `<section class="card"><h2><a href="${r.id}/${r.example}.html">${h(r.title)}</a></h2><p class="pill">${r.mode === 'fixture' ? 'Synthetic offline example' : 'Recorded mainnet research'}</p><p>${h(r.result!.summary)}</p><p>${r.result!.completion === 'partial' ? 'Some requested details remain unverified.' : 'Read the answer and its source review.'}</p><a href="${r.id}/${r.example}.html">Read the full master answer</a></section>`;
  }).join('');
  const hasLive = reports.some(r => r.report.mode === 'mainnet');
  writeFileSync(new URL('results.html', evidenceRoot), document('Read the demo results', `<p><a href="../docs/index.html">Demo guide</a> · <a href="index.html">All recorded runs</a></p><h1>Read the master answers</h1><div class="banner">${hasLive ? 'Each result identifies its mode and observation date. Review the evidence before acting on a generated answer.' : 'These samples are synthetic offline fixtures. They demonstrate the answer layout and agent orchestration. Mainnet acceptance has not been recorded.'}</div><p>Every result opens with the master synopsis. The evidence section below it contains child findings, source reviews, the original master draft, and payment records.</p><div class="cards">${cards || '<p>No results exported yet.</p>'}</div>`));
}
