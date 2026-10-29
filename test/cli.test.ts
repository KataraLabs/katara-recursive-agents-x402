import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { main, type CliOptions } from '../src/cli.js';
import { MAINNET, PERMIT2, TEST } from '../src/config.js';
import { AvalancheChain } from '../src/chain.js';
import { FixtureInference, PaidInference } from '../src/inference.js';
import { runFaucet, type FaucetChain } from '../src/faucet.js';
import { SourceCollector } from '../src/sources.js';
import { exampleIds, loadExample } from '../src/examples.js';
import { setup, SETTLEMENT } from './helpers.js';
import { validateContract } from './contracts.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function invoke(args: string[], options: CliOptions = {}) {
  const stdout: string[] = []; const stderr: string[] = [];
  const response = await main([...args, '--json'], { stdout: text => stdout.push(text), stderr: text => stderr.push(text) }, { env: {}, ...options });
  expect(stdout).toHaveLength(1);
  expect(JSON.parse(stdout[0]!)).toEqual(response);
  expect(stderr).toEqual([]);
  validateContract('cli-response', response);
  return response;
}

describe('machine-readable CLI', () => {
  it('lists and plans all registered trees without configuration or network access', async () => {
    const network = vi.fn(() => { throw new Error('unexpected network'); }); vi.stubGlobal('fetch', network);
    const listed = await invoke(['list']); const planned = await invoke(['plan', 'all']);
    expect(listed.ok && listed.result.command === 'list' && listed.result.examples.map(e => e.id)).toEqual(exampleIds);
    if (!planned.ok || planned.result.command !== 'plan') throw new Error('Missing plan');
    expect(planned.result.examples.reduce((n, e) => n + e.totalAgents, 0)).toBe(59);
    for (const e of planned.result.examples) expect(e.spawnedAgents + 1).toBe(e.totalAgents);
    expect(network).not.toHaveBeenCalled();
  });

  it('returns stable argument errors without echoing arbitrary inputs', async () => {
    const marker = 'PRIVATE_ARGUMENT_VALUE';
    const invalid = await invoke(['list', `--${marker}`]);
    expect(invalid.ok).toBe(false);
    expect(!invalid.ok && invalid.error.code).toBe('invalid_arguments');
    expect(JSON.stringify(invalid)).not.toContain(marker);
    const unknown = await invoke([marker]);
    expect(!unknown.ok && unknown.error.code).toBe('unknown_command');
    expect(JSON.stringify(unknown)).not.toContain(marker);
    const budget = await invoke(['run', 'all']);
    expect(!budget.ok && budget.error.code).toBe('budget_required');
    const doctor = await invoke(['doctor']);
    expect(!doctor.ok && doctor.error.code).toBe('wallet_missing');
  });

  it('runs and inspects five complete offline examples with no signing or network', async () => {
    const { dir, cleanup } = setup();
    const paid = vi.spyOn(PaidInference.prototype, 'complete');
    const network = vi.fn(() => { throw new Error('unexpected network'); }); vi.stubGlobal('fetch', network);
    try {
      const run = await invoke(['run', 'all', '--offline'], { stateDir: dir });
      if (!run.ok || run.result.command !== 'run') throw new Error('Offline run failed');
      expect(run.result.mode).toBe('fixture'); expect(run.result.exposureUnits).toBe('0');
      expect(run.result.reports).toHaveLength(5);
      expect(run.result.reports.reduce((n, r) => n + r.agents, 0)).toBe(59);
      expect(run.result.reports.reduce((n, r) => n + r.calls, 0)).toBe(91);
      for (const summary of run.result.reports) {
        const record = JSON.parse(readFileSync(summary.jsonPath, 'utf8'));
        validateContract('run-report', record);
        expect(record.result.synopsis.map((section: { body: string }) => section.body).join('\n').length).toBeGreaterThan(100);
        expect(record.payments).toEqual([]);
      }
      const inspected = await invoke(['inspect', run.result.runId], { stateDir: dir });
      if (!inspected.ok || inspected.result.command !== 'inspect') throw new Error('Missing inspection');
      expect([...inspected.result.reports].sort((a, b) => a.example.localeCompare(b.example))).toEqual([...run.result.reports].sort((a, b) => a.example.localeCompare(b.example)));
      expect(network).not.toHaveBeenCalled(); expect(paid).not.toHaveBeenCalled();
    } finally { cleanup(); }
  }, 30_000);

  it('keeps useful reports and returns failure when a researcher exhausts its repair', async () => {
    const { dir, cleanup } = setup();
    const bad = loadExample('documentation').specialists[0]!.researchers[0]!.id;
    const complete = FixtureInference.prototype.complete;
    vi.spyOn(FixtureInference.prototype, 'complete').mockImplementation(function (this: FixtureInference, q, signal) {
      return q.agentId.endsWith(`/${bad}`) ? Promise.resolve('malformed output') : complete.call(this, q, signal);
    });
    try {
      const response = await invoke(['run', 'documentation', '--offline'], { stateDir: dir });
      expect(response.ok).toBe(false);
      if (response.ok || response.result?.command !== 'run') throw new Error('Partial result missing');
      expect(response.error.code).toBe('run_partial');
      expect(response.result.reports[0]!.status).toBe('partial');
      const report = JSON.parse(readFileSync(response.result.reports[0]!.jsonPath, 'utf8'));
      validateContract('run-report', report);
      expect(report.result.findings.length).toBeGreaterThan(0);
    } finally { cleanup(); }
  });

  it('reports failed source retrieval explicitly without exposing source bodies', async () => {
    const { dir, cleanup } = setup();
    const sources = await new SourceCollector(loadExample('documentation'), true).all();
    sources[0]!.error = 'source_unavailable'; sources[0]!.status = 503;
    vi.spyOn(SourceCollector.prototype, 'all').mockResolvedValue(sources);
    try {
      const response = await invoke(['sources', 'documentation'], { stateDir: dir });
      expect(!response.ok && response.error.code).toBe('sources_partial');
      if (response.ok || response.result?.command !== 'sources') throw new Error('Missing source result');
      expect(response.result.examples[0]!.retrieved).toBe(sources.length - 1);
      expect(response.result.examples[0]!.sources[0]).not.toHaveProperty('text');
    } finally { cleanup(); }
  });

  it('exposes only public doctor metadata and never claims paid capacity', async () => {
    const { dir, cleanup } = setup(); const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    vi.spyOn(AvalancheChain.prototype, 'check').mockResolvedValue({ address, balance: '5000000', permit2Allowance: '0', block: '100' });
    const paid = vi.spyOn(PaidInference.prototype, 'complete');
    const reconcile = vi.spyOn(AvalancheChain.prototype, 'reconcile');
    // The gateway reports the chain id as a string and the settlement contract checksummed.
    const network = vi.fn(async (url: string) => Response.json(url.endsWith('/v1/models') ? { data: [{ id: MAINNET.model }] } : { chain_id: String(MAINNET.chainId), settlement: MAINNET.settlement }));
    vi.stubGlobal('fetch', network);
    try {
      const response = await invoke(['doctor'], { stateDir: dir, env: { KATARA_BUYER_KEY: key } });
      expect(response.ok).toBe(true);
      if (!response.ok || response.result.command !== 'doctor') throw new Error('Missing doctor');
      expect(response.result).toMatchObject({ address, settlement: MAINNET.settlement, balanceUnits: '5000000', configurationVerified: true, paidCapacityVerified: false });
      expect(JSON.stringify(response)).not.toContain(key);
      expect(network.mock.calls.map(([url]) => url).sort()).toEqual([`${MAINNET.gateway}/v1/models`, `${MAINNET.gateway}/v1/provider/info`]);
      expect(paid).not.toHaveBeenCalled(); expect(reconcile).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });

  it('stops doctor when the gateway names another settlement contract or chain', async () => {
    const key = generatePrivateKey();
    vi.spyOn(AvalancheChain.prototype, 'check').mockResolvedValue({ address: privateKeyToAccount(key).address, balance: '5000000', permit2Allowance: '0', block: '100' });
    for (const info of [{ chain_id: '43114', settlement: SETTLEMENT }, { chain_id: '43113', settlement: MAINNET.settlement }]) {
      const { dir, cleanup } = setup();
      vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/v1/models') ? { data: [{ id: MAINNET.model }] } : info)));
      try {
        const response = await invoke(['doctor'], { stateDir: dir, env: { KATARA_BUYER_KEY: key } });
        expect(!response.ok && response.error.code).toBe('gateway_configuration_mismatch');
      } finally { cleanup(); }
    }
  });

  it('sets executable exit codes and keeps JSON stdout parseable', () => {
    for (const [args, status] of [[['list', '--json'], 0], [['list', '--invalid-option', '--json'], 1]] as const) {
      const processResult = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { encoding: 'utf8' });
      expect(processResult.status).toBe(status); expect(processResult.stderr).toBe('');
      const response = JSON.parse(processResult.stdout);
      validateContract('cli-response', response); expect(response.ok).toBe(status === 0);
    }
  });
});


describe('Test mode in the CLI', () => {
  it('checks the Test gateway and chain in doctor with the same wallet', async () => {
    const { dir, cleanup } = setup(); const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    vi.spyOn(AvalancheChain.prototype, 'check').mockResolvedValue({ address, balance: '5000000', permit2Allowance: '0', block: '100' });
    const network = vi.fn(async (url: string) => Response.json(url.endsWith('/v1/models') ? { data: [{ id: 'katara/cortex' }] } : { chain_id: '43113', settlement: TEST.settlement }));
    vi.stubGlobal('fetch', network);
    try {
      const response = await invoke(['doctor'], { stateDir: dir, env: { KATARA_BUYER_KEY: key, KATARA_MODE: 'test' } });
      expect(response.ok && response.result).toMatchObject({ command: 'doctor', mode: 'test', address, chainId: 43113, network: 'eip155:43113', asset: TEST.asset, settlement: TEST.settlement, gateway: 'https://api.katara.com/test', permit2AllowanceUnits: '0' });
      expect(network.mock.calls.map(([url]) => url).sort()).toEqual(['https://api.katara.com/test/v1/models', 'https://api.katara.com/test/v1/provider/info']);
    } finally { cleanup(); }
  });
});

describe('faucet', () => {
  type Sent = [string, string];
  function fakeChain(state: { gas: bigint; canClaim: boolean; allowance: bigint; chainId?: number; token?: string }) {
    const sent: Sent[] = [];
    const chain: FaucetChain = {
      chainId: async () => state.chainId ?? 43113,
      code: async () => '0x6000',
      read: async (address, fn) => ({ token: state.token ?? TEST.asset, canClaim: state.canClaim, nextClaimAt: 1_800_000_000n, allowance: state.allowance, balanceOf: state.canClaim ? 0n : 5_000_000n } as Record<string, unknown>)[fn],
      gas: async () => state.gas,
      cost: async () => 1_000n,
      send: async (address, _abi, fn) => {
        sent.push([address, fn]);
        if (fn === 'claim') state.canClaim = false;
        if (fn === 'approve') state.allowance = 2n ** 256n - 1n;
        return `0x${'ab'.repeat(32)}`;
      },
    };
    return { chain, sent };
  }
  const testConfig = (dir: string) => { const s = setup(TEST); s.config.settlement = TEST.settlement; s.config.stateDir = dir; return s; };
  it('claims test USDC and approves Permit2 when the wallet has gas', async () => {
    const s = testConfig('/private/tmp/katara-faucet-test'); try {
      const { chain, sent } = fakeChain({ gas: 10n ** 16n, canClaim: true, allowance: 0n });
      const result = await runFaucet(s.config, () => {}, chain);
      expect(sent).toEqual([[TEST.faucet, 'claim'], [TEST.asset, 'approve']]);
      expect(result).toMatchObject({ claimed: true, approved: true, permit2AllowanceUnits: String(2n ** 256n - 1n) });
    } finally { s.cleanup(); }
  });
  it('changes nothing without Fuji AVAX and says where to get it', async () => {
    const s = testConfig('/private/tmp/katara-faucet-test'); try {
      const { chain, sent } = fakeChain({ gas: 0n, canClaim: true, allowance: 0n });
      const error = await runFaucet(s.config, () => {}, chain).catch(e => e);
      expect(error.code).toBe('gas_required');
      expect(error.message).toContain(s.config.wallet!.address); expect(error.message).toContain('https://core.app/tools/testnet-faucet/');
      expect(sent).toEqual([]);
    } finally { s.cleanup(); }
  });
  it('sends nothing when the wallet already claimed and approved', async () => {
    const s = testConfig('/private/tmp/katara-faucet-test'); try {
      const { chain, sent } = fakeChain({ gas: 10n ** 16n, canClaim: false, allowance: 1n });
      await expect(runFaucet(s.config, () => {}, chain)).resolves.toMatchObject({ claimed: false, approved: false, nextClaimAt: '1800000000' });
      expect(sent).toEqual([]);
    } finally { s.cleanup(); }
  });
  it('refuses Live mode, another chain and another faucet token before sending', async () => {
    const live = setup(); const s = testConfig('/private/tmp/katara-faucet-test'); try {
      const { chain, sent } = fakeChain({ gas: 10n ** 16n, canClaim: true, allowance: 0n });
      await expect(runFaucet(live.config, () => {}, chain)).rejects.toThrow('KATARA_MODE=test');
      await expect(runFaucet(s.config, () => {}, fakeChain({ gas: 1n, canClaim: true, allowance: 0n, chainId: 43114 }).chain)).rejects.toThrow('chain_configuration_mismatch');
      await expect(runFaucet(s.config, () => {}, fakeChain({ gas: 1n, canClaim: true, allowance: 0n, token: MAINNET.asset }).chain)).rejects.toThrow('chain_configuration_mismatch');
      expect(sent).toEqual([]);
    } finally { live.cleanup(); s.cleanup(); }
  });
  it('refuses the faucet command in Live mode through the CLI', async () => {
    const { dir, cleanup } = setup(); try {
      const response = await invoke(['faucet'], { stateDir: dir, env: { KATARA_BUYER_KEY: generatePrivateKey() } });
      expect(!response.ok && response.error.code).toBe('faucet_test_only');
    } finally { cleanup(); }
  });
});

describe('simulated answers in a Test run', () => {
  it('uses fixture output for simulated replies, records the payments and says so in the report', async () => {
    const { dir, cleanup } = setup(); const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    vi.spyOn(AvalancheChain.prototype, 'check').mockResolvedValue({ address, balance: '5000000', permit2Allowance: '0', block: '100' });
    vi.spyOn(AvalancheChain.prototype, 'reconcile').mockResolvedValue();
    vi.spyOn(AvalancheChain.prototype, 'balance').mockResolvedValue(5_000_000n);
    vi.spyOn(AvalancheChain.prototype, 'blockNumber').mockResolvedValue(100n);
    vi.spyOn(AvalancheChain.prototype, 'permit2Allowance').mockResolvedValue(0n);
    // Researchers fetch through get(); fixture mode keeps the run off the network.
    const get = SourceCollector.prototype.get;
    vi.spyOn(SourceCollector.prototype, 'get').mockImplementation(function (this: any, id: string) { this.fixture = true; return get.call(this, id); });
    const quote = { x402Version: 2, accepts: [{ scheme: 'exact', network: TEST.network, asset: TEST.asset, amount: '50000', payTo: TEST.settlement, maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2', model: 'katara/cortex', served: 'katara/simulated@1', managed: true } }] };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: 'katara/cortex' }] });
      if (url.endsWith('/v1/provider/info')) return Response.json({ chain_id: '43113', settlement: TEST.settlement });
      expect(url).toBe('https://api.katara.com/test/v1/chat/completions');
      if (!(init!.headers as Record<string, string>)['PAYMENT-SIGNATURE']) return new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(quote)).toString('base64') } });
      return Response.json({ model: 'katara/cortex', choices: [{ message: { content: 'Simulated reply. No model ran.' }, finish_reason: 'stop' }], katara: { simulated: true, served: { model: 'katara/simulated@1' } } });
    }));
    try {
      const response = await invoke(['run', 'cryptocurrency', '--budget', '5.00'], { stateDir: dir, env: { KATARA_BUYER_KEY: key, KATARA_MODE: 'test' } });
      expect(response.ok).toBe(true);
      if (!response.ok || response.result.command !== 'run') throw new Error('Missing run');
      const summary = response.result.reports[0]!;
      expect(summary).toMatchObject({ mode: 'test', status: 'succeeded' });
      expect(summary.simulatedCalls).toBe(summary.calls);
      const report = JSON.parse(readFileSync(summary.jsonPath, 'utf8'));
      validateContract('run-report', report);
      expect(report.calls.every((c: any) => c.simulated === true && c.authorizationIds.length === 1)).toBe(true);
      expect(report.payments).toHaveLength(summary.calls);
      expect(report.payments.every((p: any) => p.network === TEST.network && p.to === TEST.settlement && p.state === 'pending')).toBe(true);
      const html = readFileSync(summary.htmlPath, 'utf8');
      expect(html).toContain(`SIMULATED ANSWERS: ${summary.calls} of ${summary.calls} paid calls`);
      expect(html).toContain('simulated (Test network had no free provider)');
    } finally { cleanup(); }
  }, 20_000);
});

describe('gateway answers in CLI output', () => {
  it('puts the gateway code and message in the JSON error and the human line', async () => {
    const { dir, cleanup } = setup(); const key = generatePrivateKey();
    vi.spyOn(AvalancheChain.prototype, 'check').mockResolvedValue({ address: privateKeyToAccount(key).address, balance: '5000000', permit2Allowance: '0', block: '100' });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/v1/models') ? Response.json({ error: { message: 'Maintenance until 10:00 UTC.', code: 'service_unavailable' } }, { status: 503 }) : Response.json({ chain_id: '43114', settlement: MAINNET.settlement })));
    try {
      const response = await invoke(['doctor'], { stateDir: dir, env: { KATARA_BUYER_KEY: key } });
      expect(!response.ok && response.error).toMatchObject({ code: 'gateway_unavailable', message: 'Katara answered 503 service_unavailable: Maintenance until 10:00 UTC.', gateway: { status: 503, code: 'service_unavailable' } });
      const stderr: string[] = [];
      await main(['doctor'], { stdout: () => {}, stderr: text => stderr.push(text) }, { stateDir: dir, env: { KATARA_BUYER_KEY: key } });
      expect(stderr.join('')).toBe('gateway_unavailable: Katara answered 503 service_unavailable: Maintenance until 10:00 UTC.\n');
    } finally { cleanup(); }
  });
});
