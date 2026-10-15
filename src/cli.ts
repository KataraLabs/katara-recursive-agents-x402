#!/usr/bin/env node
/** @module Executable and importable CLI with human output or a single versioned JSON response. */
import { parseArgs } from 'node:util';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { formatUnits } from 'viem';
import { loadConfig, ledgerPath, type Config } from './config.js';
import { agentCount, exampleIds, loadExample } from './examples.js';
import { acquireWalletLock, atomicJson, Ledger } from './ledger.js';
import { AvalancheChain, rpcError } from './chain.js';
import { FixtureInference, PaidInference, gatewayError, readRefusal } from './inference.js';
import { runFaucet } from './faucet.js';
import { SourceCollector } from './sources.js';
import { Runtime } from './runtime.js';
import { totals, writeReport } from './report.js';
import { DemoError, errorCode, type CallEvidence, type RunReport } from './types.js';

import type { CliCommand, CliResponse, CliResult, ExampleSummary, ReportSummary } from './cli-types.js';

const HELP = `Katara recursive agent demos

npm run demo -- list
npm run demo -- plan <example|all>
npm run demo -- sources <example|all>
npm run faucet            (Test only: claim test USDC and approve Permit2)
npm run demo -- doctor
npm run demo -- run <example|all> --offline
npm run demo -- run <example|all> --budget <usdc> [--command "public task"]
npm run demo -- inspect [run-id]
npm run demo -- reconcile

Add --json for one versioned JSON response. Use npm run --silent demo for clean stdout.

Examples: repository, documentation, comparison, trip, cryptocurrency
run uses paid Katara Cortex calls unless --offline is present, paid per request over
x402 from the wallet: test USDC on Avalanche Fuji with KATARA_MODE=test, or USDC on
Avalanche C-Chain (the default, live). npm run faucet funds the wallet on Test.
The budget covers the entire invocation, including all five examples with 'all'.
An alternate public repository can be selected with --repo owner/name;
the configured file paths must also exist in that repository.
No command starts a local stack, pushes code, or publishes reports.`;

/**
 * Expand all to the registered scenarios and reject unknown names before starting work.
 */
function selected(name: string | undefined): string[] {
  if (name === 'all') return exampleIds;
  if (!name || !exampleIds.includes(name as any)) throw new DemoError('unknown_example', 'Choose an example from the list or use all.');
  return [name];
}
/**
 * Read public gateway metadata and require the configured network's chain, settlement contract and Katara Cortex model.
 * No payment is sent and no key is used.
 */
async function gatewayCheck(config: Config): Promise<void> {
  const read = async (path: string) => {
    const r = await fetch(`${config.gateway}${path}`, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!r.ok) { const refusal = await readRefusal(r); throw new DemoError('gateway_unavailable', gatewayError(refusal).message, refusal); }
    return r.json();
  };
  const [info, models] = await Promise.all([read('/v1/provider/info'), read('/v1/models')]);
  const { network } = config;
  if (String(info.chain_id) !== String(network.chainId) || String(info.settlement).toLowerCase() !== config.settlement.toLowerCase() || !models.data?.some((m: any) => m.id === config.model)) throw new DemoError('gateway_configuration_mismatch');
}
/**
 * Record the current Git revision and dirty state; unversioned copies remain explicitly labeled.
 */
function softwareCommit(): string {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return head + (dirty ? '+uncommitted' : '');
  } catch { return 'unversioned checkout'; }
}
/**
 * Open the ledger scoped to the configured chain, token, settlement contract and buyer.
 */
function ledgerFor(config: Config): Ledger { return new Ledger(ledgerPath(config)); }

/** Output sinks are injectable so tests can verify stdout without changing global console state. */
export interface CliIO { stdout(text: string): void; stderr(text: string): void }

/** Runtime configuration overrides used by embedders and offline tests; never serialized in output. */
export interface CliOptions { stateDir?: string; env?: Record<string, string | undefined> }

/** Summarize one completed or in-progress report without exposing private source snapshots. */
function summarize(report: RunReport, folder: string): ReportSummary {
  if (!['mainnet', 'test', 'fixture'].includes(report.mode)) throw new DemoError('unsupported_evidence_mode');
  const total = totals(report);
  return { example: report.example, title: report.title, mode: report.mode, status: report.status, agents: report.agents.length, plannedAgents: report.plannedAgents, calls: report.calls.length, simulatedCalls: report.calls.filter(c => c.simulated).length, confirmedUnits: String(total.spent), pendingUnits: String(total.pending), htmlPath: join(folder, `${report.example}.html`), jsonPath: join(folder, `${report.example}.json`) };
}

/** Derive counts from the scenario rather than maintaining separate agent-count metadata. */
function exampleSummary(id: string): ExampleSummary {
  const e = loadExample(id);
  return { id: e.id, title: e.title, command: e.command, description: e.description, specialists: e.specialists.length, researchers: e.specialists.flatMap(s => s.researchers).length, spawnedAgents: agentCount(e) - 1, totalAgents: agentCount(e) };
}

/** Execute a command; the caller owns formatting and the process exit status. */
async function execute(argv: string[], log: (text: string) => void, options: CliOptions): Promise<{ result: CliResult; error?: string }> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    json: { type: 'boolean', default: false }, offline: { type: 'boolean', default: false }, help: { type: 'boolean' }, budget: { type: 'string' }, command: { type: 'string' }, repo: { type: 'string' },
  } });
  const [command = 'help', target] = positionals;
  if (values.help || command === 'help') { log(HELP); return { result: { command: 'help', text: HELP } }; }
  if (command === 'list' || command === 'plan') {
    for (const id of command === 'list' ? exampleIds : selected(target)) {
      const e = loadExample(id); log(`${id}: ${e.title} | ${agentCount(e) - 1} spawned, ${agentCount(e)} total agents`);
      if (command === 'plan') { log(`  ${e.command}`); for (const s of e.specialists) log(`  master -> ${s.id} -> ${s.researchers.map(r => r.id).join(', ')}`); }
    }
    return { result: command === 'list' ? { command, examples: exampleIds.map(exampleSummary) } : { command, examples: selected(target).map(id => ({ ...exampleSummary(id), assignments: loadExample(id).specialists })) } };
  }
  if (!['sources', 'inspect', 'run', 'doctor', 'reconcile', 'faucet'].includes(command)) throw new DemoError('unknown_command', HELP);
  const offline = values.offline || command === 'sources' || command === 'inspect';
  if (command === 'run' && !offline && !values.budget) throw new DemoError('budget_required', 'Set --budget explicitly for this USDC invocation.');
  const config = loadConfig({ budget: values.budget, fixture: offline, ...options });
  if (command === 'faucet') {
    const release = acquireWalletLock(config.stateDir, config.wallet!.address);
    try { return { result: { command, ...(await runFaucet(config, log)) } }; } catch (error) { throw rpcError(error, config); } finally { release(); }
  }
  if (command === 'sources') {
    const results: Extract<CliResult, { command: 'sources' }>['examples'] = [];
    for (const id of selected(target)) {
      const collector = new SourceCollector(loadExample(id), false, undefined, AbortSignal.timeout(240_000), values.repo);
      const sources = await collector.all();
      log(`${id}: ${sources.filter(s => !s.error).length}/${sources.length} sources retrieved`);
      for (const s of sources) if (s.error) log(`  ${s.id}: ${s.error}`);
      atomicJson(join(config.stateDir, 'source-checks', `${id}.json`), sources.map(s => ({ ...s, text: s.text.split(/\s+/).slice(0, 25).join(' ') })));
      results.push({ example: loadExample(id).id, retrieved: sources.filter(s => !s.error).length, total: sources.length, sources: sources.map(s => ({ id: s.id, url: s.url, status: s.status, ...(s.error ? { error: s.error } : {}) })) });
    }
    return { result: { command, examples: results }, ...(results.some(r => r.retrieved !== r.total) ? { error: 'sources_partial' } : {}) };
  }
  if (command === 'inspect') {
    const root = join(config.stateDir, 'runs');
    if (!existsSync(root)) throw new DemoError('run_not_found');
    const ids = readdirSync(root).filter(x => /^[\da-zTZ-]+$/i.test(x)).sort();
    const id = target ?? ids.at(-1);
    if (!id || !ids.includes(id)) throw new DemoError('run_not_found');
    const reports: ReportSummary[] = [];
    for (const file of readdirSync(join(root, id)).filter(f => f.endsWith('.json'))) {
      const report = JSON.parse(readFileSync(join(root, id, file), 'utf8')) as RunReport;
      reports.push(summarize(report, join(root, id)));
      const total = totals(report);
      log(`${report.example}: ${report.status}, ${report.agents.length} agents, ${formatUnits(total.spent, 6)} USDC confirmed, ${formatUnits(total.pending, 6)} pending`);
      log(join(root, id, file.replace(/\.json$/, '.html')));
    }
    return { result: { command, runId: id, reports } };
  }
  if (values.offline && command !== 'run') throw new DemoError('offline_option_invalid');
  const ids = command === 'run' ? selected(target) : [];
  if (values.command && (!values.command.trim() || values.command.length > 2000)) throw new DemoError('invalid_command');
  if (values.repo && (ids.length !== 1 || ids[0] !== 'repository')) throw new DemoError('repo_option_invalid');
  const release = offline ? () => {} : acquireWalletLock(config.stateDir, config.wallet!.address);
  try {
    const stop = new AbortController();
    const chain = offline ? undefined : new AvalancheChain(config, { signal: stop.signal });
    const ledger = offline ? undefined : ledgerFor(config);
    if (!offline) {
      const checked = await chain!.check();
      if (command !== 'reconcile') await gatewayCheck(config);
      const token = config.network.mode === 'test' ? 'test USDC' : 'USDC';
      log(`${config.network.name} wallet ${checked.address}: ${formatUnits(BigInt(checked.balance), 6)} ${token}, Permit2 allowance ${BigInt(checked.permit2Allowance) >= 2n ** 255n ? 'unlimited' : formatUnits(BigInt(checked.permit2Allowance), 6)}`);
      if (command === 'doctor') {
        log('Gateway, Katara Cortex, chain, token signing domain, Permit2, and settlement configuration verified. This does not establish paid provider capacity.');
        if (BigInt(checked.permit2Allowance) === 0n) log(config.network.mode === 'test' ? 'Without a Permit2 approval, payments use exact. npm run faucet approves Permit2 so they can use upto.' : 'Without a Permit2 approval, Katara can sponsor one with your first upto payment; otherwise payments use exact.');
        return { result: { command, mode: config.network.mode, address: checked.address, balanceUnits: checked.balance, permit2AllowanceUnits: checked.permit2Allowance, block: checked.block, chainId: config.network.chainId, network: config.network.network, asset: config.asset, settlement: config.settlement, gateway: config.gateway, model: config.model, configurationVerified: true, paidCapacityVerified: false } };
      }
      await chain!.reconcile(ledger!);
      if (command === 'reconcile') {
        refreshReports(config, ledger!);
        log(`${ledger!.list().filter(a => a.state === 'pending').length} authorizations remain pending.`);
        return { result: { command, pendingAuthorizations: ledger!.list().filter(a => a.state === 'pending').length, confirmedUnits: String(ledger!.exposure() - ledger!.pending()), pendingUnits: String(ledger!.pending()) } };
      }
      if (ledger!.pending() > 0n) throw new DemoError('previous_payments_pending', 'Run reconcile after earlier payments settle or expire before starting another batch.');
      if (BigInt(checked.balance) === 0n) throw new DemoError('wallet_unfunded', config.network.mode === 'test' ? 'Run npm run faucet to claim test USDC for this wallet.' : 'Fund this wallet with native USDC on Avalanche C-Chain before a paid run.');
    }
    const runId = new Date().toISOString().replace(/[-:.]/g, '') + '-' + randomUUID().slice(0, 8);
    const folder = join(config.stateDir, 'runs', runId);
    const reports: ReportSummary[] = [];
    ledger?.begin(runId, config.budget);
    const interrupt = () => stop.abort(new DemoError('cancelled'));
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
    try {
      for (const id of ids) {
        if (stop.signal.aborted) break;
        const example = loadExample(id);
        const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(config.deadlineSeconds * 1000)]);
        const report: RunReport = { version: 1, id: runId, example: example.id, title: example.title, command: values.command ?? example.command, mode: offline ? 'fixture' : config.network.label, startedAt: new Date().toISOString(), status: 'running', softwareCommit: softwareCommit(), gateway: offline ? 'none (offline fixture)' : config.gateway, network: offline ? 'none (offline fixture)' : config.network.network, model: offline ? 'fixture (no inference)' : config.model, budgetUnits: offline ? '0' : String(config.budget), budgetScope: ids.length > 1 ? 'all five examples in this invocation' : 'this example', plannedAgents: agentCount(example), agents: [], calls: [], sources: [], payments: [] };
        const save = () => { report.payments = ledger?.list(runId).filter(a => a.agentId.startsWith(`${id}/`)) ?? []; writeReport(folder, report); };
        const record = (e: CallEvidence) => {
          const n = report.calls.findIndex(c => c.id === e.id);
          if (n < 0) report.calls.push(structuredClone(e)); else report.calls[n] = structuredClone(e);
          if (e.status !== 'running') log(`  ${e.agentId} ${e.purpose}: ${e.status}${e.simulated ? ' (simulated)' : ''}${e.error ? ` (${e.error}${e.gateway ? `: Katara answered ${[e.gateway.code, e.gateway.param && `param ${e.gateway.param}`, e.gateway.message].filter(Boolean).join(', ')}` : ''})` : ''}`);
          save();
        };
        const inference = offline ? new FixtureInference(record) : new PaidInference(config, ledger!, chain!, runId, record);
        const collector = new SourceCollector(example, offline, undefined, signal, values.repo);
        log(`${example.title}: ${report.plannedAgents} agents, ${offline ? 'offline fixture' : `paid on ${config.network.name}`}`);
        await new Runtime(inference, collector, report, config.concurrency, signal, save).run(example);
        if (chain) {
          try { await chain.reconcile(ledger!); }
          catch { log('  Settlement evidence is not yet available; reservations remain pending.'); }
        }
        save();
        log(`${report.status}: ${join(folder, `${id}.html`)}`);
        reports.push(summarize(report, folder));
        if (ledger && (ledger.exposure(runId) >= config.budget || report.agents.some(a => a.error === 'budget_exhausted'))) { log('Invocation budget cannot cover further work; no more examples will start.'); break; }
      }
    } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
    if (ledger) { refreshReports(config, ledger); log(`Batch exposure: ${formatUnits(ledger.exposure(runId), 6)} / ${formatUnits(config.budget, 6)} USDC. Use reconcile to refresh pending payments.`); }
    return { result: { command: 'run', runId, mode: offline ? 'fixture' : config.network.label, budgetUnits: offline ? '0' : String(config.budget), exposureUnits: String(ledger?.exposure(runId) ?? 0n), reports }, ...(stop.signal.aborted ? { error: 'cancelled' } : reports.some(r => r.status !== 'succeeded') || reports.length !== ids.length ? { error: 'run_partial' } : {}) };
  } finally { release(); }
}
/**
 * Refresh local payment views from the ledger while preserving full private support snapshots and exported evidence.
 */
function refreshReports(config: Config, ledger: Ledger): void {
  const root = join(config.stateDir, 'runs'); if (!existsSync(root)) return;
  for (const id of readdirSync(root).filter(x => /^[\da-zTZ-]+$/i.test(x))) {
    for (const file of readdirSync(join(root, id)).filter(f => f.endsWith('.json'))) {
      const report = JSON.parse(readFileSync(join(root, id, file), 'utf8')) as RunReport;
      if (report.mode !== config.network.label) continue;
      const snapshot = join(root, id, 'support', file);
      if (!existsSync(snapshot)) continue;
      const full = JSON.parse(readFileSync(snapshot, 'utf8')) as RunReport;
      full.payments = ledger.list(id).filter(a => a.agentId.startsWith(`${report.example}/`));
      writeReport(join(root, id), full);
    }
  }
}
/**
 * Run the CLI without a process-level side effect when imported.
 * @param argv Arguments after the executable name; --json selects a single JSON envelope.
 * @param io JSON mode writes only the envelope to stdout, including errors. Human errors use stderr.
 * @param options Explicit environment/state overrides for isolated use; omitted values use the local checkout.
 * @returns The same envelope written in JSON mode. The executable exits 1 when ok is false.
 */
export async function main(argv = process.argv.slice(2), io: CliIO = { stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text) }, options: CliOptions = {}): Promise<CliResponse> {
  const json = argv.includes('--json');
  const known: string[] = ['help', 'list', 'plan', 'sources', 'doctor', 'inspect', 'run', 'reconcile', 'faucet'];
  const first = argv.find(a => !a.startsWith('-')) ?? 'help';
  const command = (known.includes(first) ? first : 'unknown') as CliCommand | 'unknown';
  let response: CliResponse;
  try {
    const { result, error } = await execute(argv, text => { if (!json) io.stdout(text + '\n'); }, options);
    response = error ? { schemaVersion: 1, ok: false, command: result.command, error: { code: error, message: 'The command completed with incomplete results; inspect its records.' }, result } : { schemaVersion: 1, ok: true, result };
  } catch (error) {
    const argumentError = error instanceof Error && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS_');
    const code = argumentError ? 'invalid_arguments' : errorCode(error);
    response = { schemaVersion: 1, ok: false, command, error: { code, message: error instanceof DemoError ? error.message : argumentError ? 'Arguments were not accepted; use help for supported commands.' : 'The request failed; no raw exception details are included.', ...(error instanceof DemoError && error.gateway ? { gateway: error.gateway } : {}) } };
  }
  if (json) io.stdout(JSON.stringify(response) + '\n');
  else if (!response.ok) io.stderr(`${response.error.code}: ${response.error.message}\n`);
  return response;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(response => { process.exitCode = response.ok ? 0 : 1; });
}
