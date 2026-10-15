/** @module Escaped human-readable answers, public excerpts and private source-support snapshots. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatUnits } from 'viem';
import { explorerTx } from './config.js';
import { atomicJson } from './ledger.js';
import type { RunReport, Source, SynopsisRevision, Citation } from './types.js';

/**
 * Expand prose product references to Katara Cortex while preserving recognized API identifiers and URLs.
 */
export function brandText(text: string): string {
  return text.replace(/(?<![\w/@.-])Cortex(?![\w@/]|\.[A-Za-z])/g, (word, offset: number) => /\bKatara[\s*_`]+$/.test(text.slice(0, offset)) ? word : 'Katara Cortex');
}

/**
 * Apply display naming to nested string values without renaming object keys.
 */
function brandValues(value: unknown): any {
  if (typeof value === 'string') return brandText(value);
  if (Array.isArray(value)) return value.map(brandValues);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, brandValues(item)]));
  return value;
}

/** Escape untrusted values for HTML text and quoted attributes; normalize display punctuation. */
export const escapeHtml = (v: unknown): string => String(v ?? '').replace(/\s*\u2014\s*/g, ', ').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
/**
 * Render a small escaped prose subset: paragraphs, lists, inline code and emphasis. Raw HTML never executes.
 */
export function renderProse(text: string): string {
  const inline = (value: string) => escapeHtml(value).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  return text.trim().split(/\n\s*\n/).map(block => {
    const lines = block.split('\n');
    if (lines.every(line => /^\s*[-*]\s+/.test(line))) return `<ul>${lines.map(line => `<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
    if (lines.every(line => /^\s*\d+[.)]\s+/.test(line))) return `<ol>${lines.map(line => `<li>${inline(line.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`;
    return `<p>${lines.map(inline).join('<br>')}</p>`;
  }).join('');
}
/** Shared report styling; color scheme follows the reader's system preference. */
export const css = `:root{color-scheme:light dark;--bg:#f6f7f5;--panel:#fff;--ink:#111713;--muted:#5e6761;--line:#dde3dd;--accent:#082b24;--warn:#775716}@media(prefers-color-scheme:dark){:root{--bg:#051b15;--panel:#082b24;--ink:#eef3ef;--muted:#b0beb4;--line:#365247;--accent:#b7e6cb;--warn:#edd18f}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 Geist,system-ui,sans-serif}main{max-width:1200px;margin:auto;padding:36px 24px 80px}h1{font-size:clamp(28px,4vw,44px);line-height:1.14;letter-spacing:-.035em}h2{margin-top:40px;border-top:1px solid var(--line);padding-top:22px;font-size:23px}h3{font-size:17px}a{color:var(--accent);text-underline-offset:3px}code,pre{font-family:'Geist Mono',ui-monospace,monospace;font-size:.85em;overflow-wrap:anywhere}pre{white-space:pre-wrap;padding:18px;background:var(--panel);border:1px solid var(--line);border-radius:6px}.muted{color:var(--muted)}.banner{border:1px solid var(--warn);border-left-width:5px;border-radius:6px;padding:14px 18px;color:var(--warn)}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}.card{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:18px}.card b{display:block;font-size:26px}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}td,th{padding:12px;border:1px solid var(--line);text-align:left;vertical-align:top}th{background:var(--panel)}ul{padding-left:24px}li{margin-bottom:8px}.tree{list-style:none;padding:0}.tree li{border-left:2px solid var(--line);padding:9px 12px;margin:8px 0;background:var(--panel);overflow-wrap:anywhere}details{border:1px solid var(--line);border-radius:6px;margin:12px 0;padding:14px}summary{cursor:pointer;font-weight:600}.pill{display:inline-block;padding:2px 8px;border:1px solid var(--line);border-radius:999px;font-size:12px}a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:4px}@media(max-width:600px){main{padding:20px 12px 48px}td,th{min-width:120px;padding:8px}}`;
/**
 * Wrap report content in the shared responsive HTML layout. Callers must escape untrusted body values.
 */
export function document(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)}</title><style>${css}.synopsis{max-width:800px;margin:28px auto 44px}.synopsis .lead{font-size:21px;line-height:1.65}.synopsis h2{font-size:25px}.synopsis p{margin:14px 0}.synopsis .citations{font-size:12px;color:var(--muted)}.report-title{max-width:850px}.evidence-panel>summary{font-size:18px;padding:8px}.result-status{font-size:14px;color:var(--muted)}</style></head><body><main>${body}</main></body></html>`;
}
/**
 * Build safe HTTPS citation links; repository citations retain the recorded commit and original line range.
 */
function sourceUrl(source: Source, from?: number, to?: number): string {
  if (!/^https:\/\//.test(source.url)) return '';
  try {
    const url = new URL(source.url);
    if (url.username || url.password) return '';
    if (source.commit && from && to) url.hash = `L${from}-L${to}`;
    return url.href;
  } catch { return ''; }
}
/**
 * Sum confirmed net USDC charges and pending authorization maxima separately. Values are returned in base units.
 */
export function totals(report: RunReport): { spent: bigint; pending: bigint } {
  return report.payments.reduce((sum, p) => ({ spent: sum.spent + (p.state === 'confirmed' ? BigInt(p.actual!) : 0n), pending: sum.pending + (p.state === 'pending' ? BigInt(p.value) : 0n) }), { spent: 0n, pending: 0n });
}
/**
 * Place the master answer before collapsed evidence, with optional revision provenance and combined accounting.
 * @param report Original run; it is not mutated.
 * @param revision Optional successful revision displayed above the retained original output.
 * @returns Standalone HTML with escaped findings, source links, reviews and payment records.
 */
export function renderReport(report: RunReport, revision?: SynopsisRevision): string {
  const h = escapeHtml; const amount = (v: bigint) => h(formatUnits(v, 6));
  const simulated = report.calls.filter(c => c.simulated).length;
  // Calls refused before payment never reach a provider, so only paid calls can be simulated.
  const paid = report.calls.filter(c => c.authorizationIds.length > 0).length;
  const original = report;
  if (revision?.status === 'succeeded' && revision.output) report = { ...report, result: revision.output, calls: [...report.calls, ...revision.calls], payments: [...report.payments, ...revision.payments], evidenceReview: revision.evidenceReview, masterDraft: revision.masterDraft };
  else revision = undefined;
  const { spent, pending } = totals(report);
  const sources = new Map(report.sources.map(s => [s.id, s]));
  const references = (citations: Citation[]) => citations.map(c => {
    const s = sources.get(c.sourceId); const url = s ? sourceUrl(s, c.startLine, c.endLine) : '';
    return `<a href="${h(url || `#source-${c.sourceId}`)}" rel="noreferrer">${h(s?.title ?? c.sourceId)} · lines ${c.startLine}–${c.endLine}</a>`;
  }).join(' · ');
  const renderOutput = (output: RunReport['result']) => output ? `<p>${h(output.summary)}</p><ul>${output.findings.map(f => `<li>${h(f.claim)} ${f.assessment ? `<span class="pill">${h(f.assessment.verdict)}</span> <small>${h(f.assessment.reason)}</small>` : ''} <small>${f.citations.map(c => {
    const s = sources.get(c.sourceId); const url = s ? sourceUrl(s, c.startLine, c.endLine) : '';
    const label = `${c.sourceId}:${c.startLine}-${c.endLine}`;
    return url ? `<a href="${h(url)}" rel="noreferrer">${h(label)}</a>` : `<a href="#source-${h(c.sourceId)}">${h(label)}</a>`;
  }).join(', ')}</small></li>`).join('')}</ul>${output.limitations.length ? `<p class="muted">Limitations: ${output.limitations.map(h).join(' · ')}</p>` : ''}` : '<p>No result was produced.</p>';
  const nodes = (parentId?: string): string => `<ul class="tree">${report.agents.filter(a => a.parentId === parentId).map(a => `<li><b>${h(a.title)}</b> <span class="pill">${h(a.status)}</span><br><small>${h(a.id)} · depth ${a.depth} · ${h(a.startedAt)}${a.error ? ` · ${h(a.error)}` : ''}</small>${nodes(a.id)}</li>`).join('')}</ul>`;
  const result = report.result;
  const synopsis = result?.synopsis?.length ? `<article class="synopsis" aria-label="Master agent synopsis"><div class="lead">${renderProse(result.summary)}</div>${result.synopsis.map(s => `<section><h2>${h(s.heading)}</h2>${renderProse(s.body)}${s.unverifiedEvidence?.length ? `<p class="banner">This section contains references to missing evidence. Treat its statements as unverified.</p>` : ''}${s.citations.length ? `<p class="citations">Evidence: ${references(s.citations)}</p>` : ''}</section>`).join('')}${result.limitations.length ? `<section><h2>What remains unverified</h2><ul>${result.limitations.map(s => `<li>${h(s)}</li>`).join('')}</ul></section>` : ''}</article>` : `<article class="synopsis"><h2>Original short master summary</h2>${renderOutput(result)}</article>`;
  return document(report.title, `<p class="muted">KATARA / MASTER AGENT SYNOPSIS</p><h1 class="report-title">${h(report.title)}</h1>
    ${report.mode === 'fixture' ? '<div class="banner">OFFLINE FIXTURE: synthetic content, not a researched answer. No model calls or payments occurred.</div>' : ''}
    ${simulated ? `<div class="banner">SIMULATED ANSWERS: ${simulated} of ${paid} paid calls were answered by the Test network's simulated reply because no provider was free. Those agents used built-in fixture output, so this answer is not researched. The payments are real Test payments.</div>` : ''}
    <p class="result-status">${revision?.reviewNotes?.length ? 'Draft answer with unresolved review findings.' : result?.completion === 'partial' ? 'Partial answer: the evidence review kept out details the sources do not support. See What remains unverified, and the section review in the evidence below.' : result?.synopsis ? 'Master synthesis of the collected research.' : 'Recorded brief summary; no detailed synopsis was generated in this run.'} ${revision?.reviewNotes?.length ? ' <a href="#review">Read the review notes</a>.' : ''} Research recorded ${h(report.startedAt.slice(0, 10))}.${revision ? ` Synopsis revised ${h(revision.finishedAt)} using the recorded child findings.` : ''}</p>
    ${synopsis}
    ${revision?.reviewNotes?.length ? `<aside class="banner" id="review"><h2>Review of this draft</h2><ul>${revision.reviewNotes.map(note => `<li>${h(note)}</li>`).join('')}</ul></aside>` : ''}
    <details class="evidence-panel" id="evidence"><summary>Research evidence, agent work, and payments · ${report.agents.length} agents · ${report.calls.length} calls · ${amount(spent)} USDC confirmed</summary>
    <div class="banner">${report.mode === 'fixture' ? 'OFFLINE FIXTURE: synthetic sources and agent outputs. No model calls or payments occurred.' : report.mode === 'test' ? 'TEST NETWORK RUN: inference uses Katara Cortex; payments use test USDC, which has no value, through x402 on Avalanche Fuji.' : 'LIVE MAINNET RUN: inference uses Katara Cortex; payments use native USDC through x402 on Avalanche C-Chain.'} Status: ${h(report.status)}.${report.error ? ` ${h(report.error)}.` : ''}</div>
    <p>${h(report.command)}</p><p class="muted">Run ${h(report.id)} · ${h(report.startedAt)} · software ${h(report.softwareCommit)}</p>
    <div class="cards"><div class="card"><b>${report.agents.length} / ${report.plannedAgents}</b>agents executed / planned</div><div class="card"><b>${report.calls.length}</b>${report.mode === 'fixture' ? 'fixture calls' : 'inference attempts'}</div><div class="card"><b>${amount(spent)}</b>${report.mode === 'test' ? 'confirmed test USDC charged' : 'confirmed USDC charged'}</div><div class="card"><b>${amount(pending)}</b>USDC still reserved</div></div>
    <p class="muted">Budget cap ${amount(BigInt(report.budgetUnits))} USDC applies across ${h(report.budgetScope)}. This report shows only this example's payments. Pending authorizations can still settle. HTTP acceptance is not chain confirmation.</p>
    <h2>Command and answer coverage</h2><p>Execution status describes orchestration. It does not establish factual correctness or complete coverage of the command. Citations identify the child findings used in the synopsis; source review checks the cited text before a finding enters the synopsis. This review can still miss errors and does not prove factual correctness.</p>
    ${revision ? `<p>The synopsis is a separate paid revision of the recorded research. The call and payment tables include both the original run and this revision. Original run JSON and its source fingerprint are unchanged.</p><details><summary>Original master output, superseded by the synopsis above</summary>${renderOutput(original.result)}</details>` : ''}
    ${report.evidenceReview ? `<h2>Source review</h2><p>${report.evidenceReview.findings.filter(f => f.assessment?.verdict === 'supported').length} of ${report.evidenceReview.findings.length} child findings passed the source review. Rejected or uncertain findings are excluded from the answer. JSON evidence records verdicts, reasons, claim hashes, source-span hashes, and review call IDs.</p>` : ''}
    ${report.masterDraft ? `<details><summary>Original master draft and section review</summary><p>This draft is retained for inspection. Withheld sections are replaced in the answer above.</p>${renderProse(report.masterDraft.summary)}${report.masterDraft.synopsis?.map(s => `<h3>${h(s.heading)}</h3>${renderProse(s.body)}`).join('') ?? ''}<ul>${report.result?.review?.sections.map(s => `<li>${h(s.id)}: ${h(s.assessment.verdict)} · ${h(s.assessment.reason)}</li>`).join('') ?? ''}</ul></details>` : ''}
    <h2>Findings used by the master</h2>${renderOutput(report.result)}
    <h2>Executed agent tree</h2>${nodes()}
    <h2>Child findings</h2>${report.agents.filter(a => a.depth > 0).map(a => `<details><summary>${h(a.title)} · ${h(a.status)}</summary>${a.assignment ? `<p><b>Assignment:</b> ${h(a.assignment)}</p>` : ''}${renderOutput(a.output)}${a.validationIssues?.length ? `<p class="muted">Validation history: ${a.validationIssues.map(v => h(`${v.purpose}, attempt ${v.attempt}: ${v.detail}`)).join('; ')}</p>` : ''}</details>`).join('')}
    <h2>Inference evidence</h2><div class="scroll"><table><thead><tr><th>Agent / purpose</th><th>Requested / served model</th><th>Status / usage</th><th>Call / request ID</th></tr></thead><tbody>${report.calls.map(c => `<tr><td>${h(c.agentId)}<br>${h(c.purpose)}</td><td>${h(c.requestedModel)}<br>${h(c.servedModel ?? 'not reported')}<br>${h(c.provider ?? '')}</td><td>${h(c.status)}${c.simulated ? '<br>simulated (Test network had no free provider)' : ''}${c.error ? `<br>${h(c.error)}` : ''}${c.gateway ? `<br>Katara answered ${h([c.gateway.status, c.gateway.code, c.gateway.param && `param ${c.gateway.param}`].filter(Boolean).join(' '))}${c.gateway.message ? `: ${h(c.gateway.message)}` : ''}` : ''}${c.quoteWaits ? `<br>waited ${c.quoteWaits}× for the quote limit` : ''}<br>${h(JSON.stringify(c.usage ?? {}))}</td><td><code>${h(c.id)}</code><br><code>${h(c.requestId ?? '')}</code></td></tr>`).join('')}</tbody></table></div>
    <h2>Payment evidence</h2><p>Each authorization maps to an inference call above. Confirmed entries require the token authorization, settlement event, net buyer debit, and finalized block to agree.</p><div class="scroll"><table><thead><tr><th>Agent / call</th><th>Maximum / actual USDC</th><th>State</th><th>Avalanche transaction</th></tr></thead><tbody>${report.payments.map(p => `<tr><td>${h(p.agentId)}<br><code>${h(p.callId)}</code></td><td>${amount(BigInt(p.value))} / ${p.actual === undefined ? 'pending' : amount(BigInt(p.actual))}</td><td>${h(p.state)}</td><td>${p.transaction && explorerTx(p.network, p.transaction) ? `<a href="${h(explorerTx(p.network, p.transaction)!)}" rel="noreferrer"><code>${h(p.transaction)}</code></a>` : p.transaction ? `<code>${h(p.transaction)}</code>` : 'No confirmed transaction'}</td></tr>`).join('') || '<tr><td colspan="4">No payment authorizations in this report.</td></tr>'}</tbody></table></div>
    <h2>Sources</h2>${report.presentationNotes?.length ? `<p class="muted">${report.presentationNotes.map(h).join(' ')}</p>` : ''}<p>Hashes identify retrieved response bytes. Excerpts are capped for the public report; line citations refer to the source view inspected by the agents, or original file lines for repository sources. Unavailable sources cannot support factual findings.</p>${report.sources.map(s => `<details id="source-${h(s.id)}"><summary>${h(s.title)} · HTTP ${s.status}${s.error ? ` · ${h(s.error)}` : ''}</summary><p>${sourceUrl(s) ? `<a href="${h(sourceUrl(s))}" rel="noreferrer">${h(s.url)}</a>` : h(s.url)}</p><p>Retrieved ${h(s.retrievedAt)}${s.commit ? ` · commit ${h(s.commit)}` : ''}<br>SHA-256 <code>${h(s.sha256)}</code></p><pre>${h(s.text)}</pre>${s.links ? `<pre>${h(JSON.stringify(s.links, null, 2))}</pre>` : ''}</details>`).join('')}</details>`);
}
/**
 * Copy a typed report, normalize product prose and cap each source excerpt at 25 words.
 * @remarks This is a presentation transform, not a sanitizer for arbitrary objects or secret fields.
 */
export function publicReport(report: RunReport): RunReport {
  const copy = brandValues(report) as RunReport;
  copy.presentationNotes = ['Product references use the full name Katara Cortex. Payment identifiers and source hashes retain their recorded values.'];
  copy.sources = copy.sources.map(s => ({ ...s, text: s.text.split(/\s+/).slice(0, 25).join(' ') }));
  return copy;
}
/**
 * Copy revision metadata for export and omit its raw private draftText field.
 */
export function publicSynopsis(revision: SynopsisRevision): SynopsisRevision {
  const copy = brandValues(revision) as SynopsisRevision;
  delete copy.draftText;
  return copy;
}
/**
 * Write owner-only local HTML/JSON plus a full private source-support snapshot. This does not publish any file.
 */
export function writeReport(folder: string, report: RunReport): void {
  atomicJson(join(folder, 'support', `${report.example}.json`), report);
  const copy = publicReport(report);
  atomicJson(join(folder, `${report.example}.json`), copy);
  writeFileSync(join(folder, `${report.example}.html`), renderReport(copy), { mode: 0o600 });
}
