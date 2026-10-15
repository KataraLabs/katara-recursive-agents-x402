import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { toHex, verifyTypedData } from 'viem';
import { UptoEvmScheme } from '@x402/evm/upto/client';
import { MAX_QUOTE_WAITS, PaidInference, QuotePacer, pacerFor, readRefusal, retryAfterMs, selectQuotes, AUTH_TYPES, PERMIT_TYPES, UPTO_TYPES, type CompletionRequest } from '../src/inference.js';
import { SETTLEMENT, chainStub } from './helpers.js';
import { MAINNET, PERMIT2, TEST, UPTO_PROXY, type Network } from '../src/config.js';
import { Ledger } from '../src/ledger.js';
import { setup } from './helpers.js';
import type { CallEvidence } from '../src/types.js';

const task: CompletionRequest = { agentId: 'master', purpose: 'research', system: 'system text is not persisted', prompt: 'prompt text is not persisted', fixtureOutput: {} };
function challenge() { return { x402Version: 2, accepts: [{ scheme: 'exact', network: MAINNET.network, asset: MAINNET.asset, payTo: SETTLEMENT, amount: '10000', maxTimeoutSeconds: 300, extra: { name: 'USD Coin', version: '2', model: MAINNET.model } }] }; }
const response402 = (data = challenge()) => new Response(JSON.stringify(data), { status: 402, headers: { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(data)).toString('base64') } });
const success = () => new Response(JSON.stringify({ model: MAINNET.model, choices: [{ message: { content: '{"summary":"result"}' }, finish_reason: 'stop' }], system_fingerprint: 'cortex:katara/example@1', usage: { total_tokens: 5 } }), { status: 200 });

describe('manual x402 payment boundary', () => {
  it.each(['network', 'asset', 'payTo', 'scheme', 'amount'])('refuses a bad %s before signing', async field => {
    const s = setup(); try {
      const c = challenge(); (c.accepts[0] as any)[field] = field === 'amount' ? '-1' : 'unexpected';
      const sign = vi.spyOn(s.config.wallet!, 'signTypedData');
      const ledger = new Ledger(join(s.dir, 'ledger.json')); ledger.begin('run', s.config.budget);
      const fetcher = vi.fn(async () => response402(c));
      const client = new PaidInference(s.config, ledger, chainStub(0n, 100_000n), 'run', () => {}, fetcher as any);
      await expect(client.complete(task, new AbortController().signal)).rejects.toThrow();
      expect(sign).not.toHaveBeenCalled(); expect(ledger.list()).toHaveLength(0); expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { s.cleanup(); }
  });
  it.each([
    { extra: { name: 'Wrong', version: '2', model: MAINNET.model } },
    { extra: { name: 'USD Coin', version: '2', model: 'another-model' } },
    { extra: { name: 'USD Coin', version: '2', model: MAINNET.model, assetTransferMethod: 'permit2' } },
    { maxTimeoutSeconds: 100_000 }, { amount: '1e5' },
  ])('rejects changed domain, model, scheme extensions, or lifetime', change => {
    const s = setup(); try { const c = challenge(); Object.assign(c.accepts[0]!, change); expect(() => selectQuotes(c, s.config)).toThrow(); } finally { s.cleanup(); }
  });
  it('persists the reservation before signing, signs valid EIP-3009, and retries identical bytes', async () => {
    const s = setup(); try {
      const ledger = new Ledger(join(s.dir, 'ledger.json')); ledger.begin('run', s.config.budget);
      const originalSign = s.config.wallet!.signTypedData.bind(s.config.wallet);
      vi.spyOn(s.config.wallet!, 'signTypedData').mockImplementation(async (args: any) => {
        expect(new Ledger(ledger.file).pending()).toBe(10_000n);
        return originalSign(args);
      });
      const requests: RequestInit[] = [];
      const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
        requests.push(init);
        if (requests.length === 1) return response402();
        const encoded = (init.headers as Record<string, string>)['PAYMENT-SIGNATURE']!;
        const payment = JSON.parse(Buffer.from(encoded, 'base64').toString());
        const a = payment.payload.authorization;
        expect(await verifyTypedData({ address: s.config.wallet!.address, domain: { name: 'USD Coin', version: '2', chainId: MAINNET.chainId, verifyingContract: MAINNET.asset }, types: AUTH_TYPES, primaryType: 'TransferWithAuthorization', message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) }, signature: payment.payload.signature })).toBe(true);
        expect(payment.accepted.network).toBe(MAINNET.network);
        return success();
      });
      const evidence: CallEvidence[] = [];
      const client = new PaidInference(s.config, ledger, chainStub(0n, 100_000n), 'run', e => evidence.push(structuredClone(e)), fetcher as any);
      await client.complete(task, new AbortController().signal);
      expect(requests[0]!.body).toBe(requests[1]!.body);
      expect(requests.every(r => r.redirect === 'error')).toBe(true);
      expect(ledger.pending()).toBe(10_000n);
      const saved = readFileSync(ledger.file, 'utf8') + JSON.stringify(evidence);
      expect(saved).not.toContain(task.prompt); expect(saved).not.toContain(task.system); expect(saved).not.toContain('signature');
      expect(evidence.at(-1)?.status).toBe('succeeded');
    } finally { s.cleanup(); }
  });
  it('holds multiple uncertain authorizations through bounded fresh-402 retries', async () => {
    const s = setup(); try {
      const ledger = new Ledger(join(s.dir, 'ledger.json')); ledger.begin('run', s.config.budget);
      const fetcher = vi.fn(async () => response402());
      const client = new PaidInference(s.config, ledger, chainStub(0n, 100_000n), 'run', () => {}, fetcher as any);
      await expect(client.complete(task, new AbortController().signal)).rejects.toMatchObject({ code: 'payment_retry_limit' });
      expect(fetcher).toHaveBeenCalledTimes(4); expect(ledger.pending()).toBe(30_000n);
    } finally { s.cleanup(); }
  });
  it('keeps a signed authorization after a transport timeout and supports crash reload', async () => {
    const s = setup(); try {
      const ledger = new Ledger(join(s.dir, 'ledger.json')); ledger.begin('run', s.config.budget);
      let calls = 0;
      const client = new PaidInference(s.config, ledger, chainStub(0n, 100_000n), 'run', () => {}, (async () => { if (++calls === 1) return response402(); throw new Error('transport timeout'); }) as any);
      await expect(client.complete(task, new AbortController().signal)).rejects.toThrow('transport timeout');
      expect(new Ledger(ledger.file).pending()).toBe(10_000n);
    } finally { s.cleanup(); }
  });
  it('refuses free successes and does not turn a malformed paid completion into free work', async () => {
    const s = setup(); try {
      const ledger = new Ledger(join(s.dir, 'ledger.json')); ledger.begin('run', s.config.budget);
      const chain = chainStub(0n, 100_000n);
      await expect(new PaidInference(s.config, ledger, chain, 'run', () => {}, (async () => success()) as any).complete(task, new AbortController().signal)).rejects.toThrow('unpaid_response_refused');
      let calls = 0;
      await expect(new PaidInference(s.config, ledger, chain, 'run', () => {}, (async () => ++calls === 1 ? response402() : new Response(JSON.stringify({ model: MAINNET.model, choices: [] }))) as any).complete(task, new AbortController().signal)).rejects.toThrow('completion_invalid');
      expect(ledger.pending()).toBe(10_000n);
    } finally { s.cleanup(); }
  });
});

// Shapes captured from unpaid quotes on 2026-10-15. Live lists upto first, marks vendor-served Katara Cortex
// quotes managed and offers EIP-2612 gas sponsoring. Test quotes the same entries on Fuji without sponsoring.
function liveChallenge(network: Network = MAINNET) {
  const ticket = `0x${'89002295'.repeat(8)}`;
  const common = { network: network.network as string, asset: network.asset as string, amount: '50000', payTo: network.settlement as string, maxTimeoutSeconds: 300 };
  const meta = { managed: true, model: 'katara/cortex@1', name: 'USD Coin', provider: '0x65B03c447b51369FC3E9c7268268eE7c0Fd7d34C', served: 'katara/deepseek-chat@1', ticketHash: ticket, version: '2' };
  return {
    x402Version: 2, error: 'payment required',
    accepts: [
      { scheme: 'upto', ...common, extra: { assetTransferMethod: 'permit2', facilitatorAddress: '0x88CcDE2C5032c4e0539362207C35043e890B9338', ...meta } as Record<string, unknown> },
      { scheme: 'exact', ...common, extra: { ...meta, nonce: ticket } as Record<string, unknown> },
    ],
    ...(network === MAINNET ? { extensions: { eip2612GasSponsoring: { info: { description: 'The facilitator accepts an EIP-2612 permit to the canonical Permit2 contract and submits it with the settlement, paying its gas.', version: '1' }, schema: { type: 'object' } } } as Record<string, unknown> } : {}),
  };
}
function liveSetup(network: Network = MAINNET) {
  const s = setup(network); s.config.settlement = network.settlement; s.config.budget = 1_000_000n; return s;
}
type Paid = { scheme: string; payload: any; extensions?: any };
/** Run one paid call; `answer` decides each paid response. Returns the decoded payments in order. */
async function payOnce(network: Network, allowance: bigint, answer: (payment: Paid, n: number) => Response, challengeFor = liveChallenge) {
  const s = liveSetup(network);
  const ledger = new Ledger(join(s.dir, 'ledger.json')); ledger.begin('run', s.config.budget);
  const payments: Paid[] = [];
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const encoded = (init.headers as Record<string, string>)['PAYMENT-SIGNATURE'];
    if (!encoded) return response402(challengeFor(network) as any);
    const p = JSON.parse(Buffer.from(encoded, 'base64').toString());
    payments.push({ scheme: p.accepted.scheme, payload: p.payload, extensions: p.extensions });
    return answer(payments.at(-1)!, payments.length);
  });
  const client = new PaidInference(s.config, ledger, chainStub(allowance), 'run', () => {}, fetcher as any);
  const outcome = await client.complete(task, new AbortController().signal).then(() => 'ok', (e: any) => e.code ?? e.message);
  return { s, ledger, payments, outcome, fetcher };
}
const uptoMessage = (a: any) => ({ permitted: { token: a.permitted.token, amount: BigInt(a.permitted.amount) }, spender: a.spender, nonce: BigInt(a.nonce), deadline: BigInt(a.deadline), witness: { to: a.witness.to, facilitator: a.witness.facilitator, validAfter: BigInt(a.witness.validAfter) } });
const refused412 = () => Response.json({ error: { message: 'approve Permit2', code: 'permit2_allowance_required' } }, { status: 412 });

describe('quote selection on real challenge shapes', () => {
  it('keeps both Live entries and notes the sponsored approval', () => {
    const s = liveSetup(); try {
      const q = selectQuotes(liveChallenge(), s.config);
      expect(q.upto).toMatchObject({ scheme: 'upto', payTo: MAINNET.settlement, amount: '50000' });
      expect(q.exact).toMatchObject({ scheme: 'exact', payTo: MAINNET.settlement, amount: '50000' });
      expect(q.sponsored).toBe(true); expect(Object.keys(q.extensions!)).toEqual(['eip2612GasSponsoring']);
    } finally { s.cleanup(); }
  });
  it('keeps both Test entries without sponsoring and refuses a Live challenge in Test mode', () => {
    const s = liveSetup(TEST); try {
      const q = selectQuotes(liveChallenge(TEST), s.config);
      expect(q.upto?.network).toBe('eip155:43113'); expect(q.exact?.payTo).toBe(TEST.settlement); expect(q.sponsored).toBe(false);
      expect(() => selectQuotes(liveChallenge(MAINNET), s.config)).toThrow('quote_refused');
    } finally { s.cleanup(); }
  });
  it.each<[string, (c: ReturnType<typeof liveChallenge>) => void]>([
    ['an exact transfer method', c => { c.accepts[0]!.extra.assetTransferMethod = 'eip3009'; }],
    ['no facilitator', c => { delete c.accepts[0]!.extra.facilitatorAddress; }],
    ['a malformed facilitator', c => { c.accepts[0]!.extra.facilitatorAddress = 'nobody'; }],
    ['an unknown field', c => { c.accepts[0]!.extra.spender = SETTLEMENT; }],
    ['another recipient', c => { c.accepts[0]!.payTo = SETTLEMENT; }],
  ])('drops an upto entry with %s and keeps exact', (_name, change) => {
    const s = liveSetup(); try {
      const c = liveChallenge(); change(c);
      const q = selectQuotes(c, s.config);
      expect(q.upto).toBeUndefined(); expect(q.exact?.scheme).toBe('exact'); expect(q.sponsored).toBe(false);
      c.accepts.pop();
      expect(() => selectQuotes(c, s.config)).toThrow();
    } finally { s.cleanup(); }
  });
  it.each<[string, (c: ReturnType<typeof liveChallenge>) => void, string]>([
    ['exact entry on Fuji', c => { c.accepts[1]!.network = 'eip155:43113'; }, 'quote_refused'],
    ['exact entry naming a Permit2 transfer', c => { c.accepts[1]!.extra.assetTransferMethod = 'permit2'; }, 'quote_domain_refused'],
    ['managed that is not a boolean', c => { c.accepts[1]!.extra.managed = 'yes'; }, 'quote_domain_refused'],
    ['another token domain', c => { c.accepts[1]!.extra.version = '1'; }, 'quote_domain_refused'],
    ['another requested model', c => { c.accepts[1]!.extra.model = 'katara/other@1'; }, 'quote_model_mismatch'],
  ])('refuses an exact-only challenge with %s', (_name, change, code) => {
    const s = liveSetup(); try {
      const c = liveChallenge(); change(c); c.accepts.shift();
      expect(() => selectQuotes(c, s.config)).toThrow(code);
    } finally { s.cleanup(); }
  });
  it('refuses extensions that are not an object', () => {
    const s = liveSetup(); try {
      const c: any = liveChallenge(); c.extensions = ['eip2612GasSponsoring'];
      expect(() => selectQuotes(c, s.config)).toThrow('invalid_challenge');
    } finally { s.cleanup(); }
  });
});

describe('choosing upto or exact', () => {
  it.each([MAINNET, TEST])('pays upto on $name when the Permit2 allowance covers the quote', async network => {
    const { s, ledger, payments, outcome } = await payOnce(network, 50_000n, () => success());
    try {
      expect(outcome).toBe('ok');
      expect(payments.map(p => p.scheme)).toEqual(['upto']);
      const a = payments[0]!.payload.permit2Authorization;
      expect(a).toMatchObject({ from: s.config.wallet!.address, spender: UPTO_PROXY, permitted: { amount: '50000' }, witness: { to: network.settlement, facilitator: '0x88CcDE2C5032c4e0539362207C35043e890B9338', validAfter: '0' } });
      expect(a.permitted.token.toLowerCase()).toBe(network.asset.toLowerCase());
      expect(await verifyTypedData({ address: s.config.wallet!.address, domain: { name: 'Permit2', chainId: network.chainId, verifyingContract: PERMIT2 }, types: UPTO_TYPES, primaryType: 'PermitWitnessTransferFrom', message: uptoMessage(a), signature: payments[0]!.payload.signature })).toBe(true);
      expect(payments[0]!.extensions).toBeUndefined();
      expect(ledger.list()).toEqual([expect.objectContaining({ scheme: 'upto', value: '50000', network: network.network, nonce: toHex(BigInt(a.nonce), { size: 32 }), validBefore: a.deadline, ticketHash: `0x${'89002295'.repeat(8)}`, state: 'pending' })]);
    } finally { s.cleanup(); }
  });
  it('pays upto with a sponsored EIP-2612 approval on Live when Permit2 has no allowance', async () => {
    const { s, payments, outcome } = await payOnce(MAINNET, 0n, () => success());
    try {
      expect(outcome).toBe('ok'); expect(payments.map(p => p.scheme)).toEqual(['upto']);
      const info = payments[0]!.extensions.eip2612GasSponsoring.info;
      expect(info).toMatchObject({ from: s.config.wallet!.address, spender: PERMIT2, amount: '50000', nonce: '7', deadline: payments[0]!.payload.permit2Authorization.deadline });
      expect(await verifyTypedData({ address: s.config.wallet!.address, domain: { name: 'USD Coin', version: '2', chainId: MAINNET.chainId, verifyingContract: MAINNET.asset }, types: PERMIT_TYPES, primaryType: 'Permit', message: { owner: info.from, spender: info.spender, value: BigInt(info.amount), nonce: BigInt(info.nonce), deadline: BigInt(info.deadline) }, signature: info.signature })).toBe(true);
    } finally { s.cleanup(); }
  });
  it('pays exact on Test when Permit2 has no allowance and nothing is sponsored', async () => {
    const { s, ledger, payments, outcome } = await payOnce(TEST, 0n, () => success());
    try {
      expect(outcome).toBe('ok'); expect(payments.map(p => p.scheme)).toEqual(['exact']);
      const a = payments[0]!.payload.authorization;
      expect(await verifyTypedData({ address: s.config.wallet!.address, domain: { name: 'USD Coin', version: '2', chainId: TEST.chainId, verifyingContract: TEST.asset }, types: AUTH_TYPES, primaryType: 'TransferWithAuthorization', message: { ...a, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore) }, signature: payments[0]!.payload.signature })).toBe(true);
      expect(ledger.list()).toEqual([expect.objectContaining({ scheme: 'exact', to: TEST.settlement, network: 'eip155:43113' })]);
    } finally { s.cleanup(); }
  });
  it('pays the same quote with exact after 412 permit2_allowance_required and keeps both reservations', async () => {
    const { s, ledger, payments, outcome } = await payOnce(MAINNET, 0n, (_p, n) => n === 1 ? refused412() : success());
    try {
      expect(outcome).toBe('ok'); expect(payments.map(p => p.scheme)).toEqual(['upto', 'exact']);
      expect(ledger.list().map(a => [a.scheme, a.state, a.value])).toEqual([['upto', 'pending', '50000'], ['exact', 'pending', '50000']]);
      expect(ledger.pending()).toBe(100_000n);
    } finally { s.cleanup(); }
  });
  it('falls back once and does not treat other 412 answers as a missing approval', async () => {
    const twice = await payOnce(MAINNET, 0n, () => refused412());
    try { expect(twice.outcome).toBe('permit2_allowance_required'); expect(twice.payments.map(p => p.scheme)).toEqual(['upto', 'exact']); } finally { twice.s.cleanup(); }
    const other = await payOnce(MAINNET, 0n, () => Response.json({ error: { code: 'precondition_failed' } }, { status: 412 }));
    try { expect(other.outcome).toBe('gateway_http_412'); expect(other.payments.map(p => p.scheme)).toEqual(['upto']); } finally { other.s.cleanup(); }
  });
  it('asks for a Permit2 approval when a quote offers only upto and nothing covers it', async () => {
    const onlyUpto = (n: Network = MAINNET) => { const c = liveChallenge(n); c.accepts.pop(); return c; };
    const { s, payments, outcome } = await payOnce(TEST, 0n, () => success(), onlyUpto);
    try { expect(outcome).toBe('permit2_allowance_required'); expect(payments).toHaveLength(0); } finally { s.cleanup(); }
  });
});

describe('upto signing boundary', () => {
  const good = (s: ReturnType<typeof liveSetup>, deadline = Math.floor(Date.now() / 1000) + 300) => ({
    domain: { name: 'Permit2', chainId: MAINNET.chainId, verifyingContract: PERMIT2 }, primaryType: 'PermitWitnessTransferFrom',
    message: { permitted: { token: MAINNET.asset, amount: 50000n }, spender: UPTO_PROXY, nonce: 5n, deadline: BigInt(deadline), witness: { to: MAINNET.settlement, facilitator: '0x88CcDE2C5032c4e0539362207C35043e890B9338', validAfter: 0n } },
  });
  it.each<[string, (d: any) => void, string]>([
    ['the Permit2 domain', d => { d.domain.verifyingContract = SETTLEMENT; }, 'signing_domain_refused'],
    ['the chain', d => { d.domain.chainId = TEST.chainId; }, 'signing_domain_refused'],
    ['the spender', d => { d.message.spender = SETTLEMENT; }, 'signing_payload_refused'],
    ['the token', d => { d.message.permitted.token = TEST.asset; }, 'signing_payload_refused'],
    ['the amount', d => { d.message.permitted.amount = 50001n; }, 'signing_payload_refused'],
    ['witness.to', d => { d.message.witness.to = SETTLEMENT; }, 'signing_payload_refused'],
    ['witness.facilitator', d => { d.message.witness.facilitator = SETTLEMENT; }, 'signing_payload_refused'],
    ['the deadline', d => { d.message.deadline += 3600n; }, 'signing_expiry_refused'],
    ['the message type', d => { d.primaryType = 'TransferWithAuthorization'; }, 'signing_domain_refused'],
  ])('refuses a Permit2 transfer with a changed %s and reserves nothing', async (_name, change, code) => {
    const s = liveSetup(); try {
      const ledger = new Ledger(join(s.dir, 'ledger.json')); ledger.begin('run', s.config.budget);
      const sign = vi.spyOn(s.config.wallet!, 'signTypedData');
      vi.spyOn(UptoEvmScheme.prototype, 'createPaymentPayload').mockImplementation(async function (this: any) {
        const data = good(s); change(data); await this.signer.signTypedData(data); throw new Error('signed');
      });
      const fetcher = vi.fn(async () => response402(liveChallenge() as any));
      const client = new PaidInference(s.config, ledger, chainStub(50_000n), 'run', () => {}, fetcher as any);
      await expect(client.complete(task, new AbortController().signal)).rejects.toThrow(code);
      expect(sign).not.toHaveBeenCalled(); expect(ledger.list()).toHaveLength(0); expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { vi.restoreAllMocks(); s.cleanup(); }
  });
});

describe('simulated Test replies', () => {
  // The reply Katara's Test network sends when no Fuji provider is free: fixed text, marked simulated.
  const simulatedReply = () => Response.json({ model: 'katara/cortex@1', choices: [{ message: { content: 'Simulated reply from Katara\'s Test network. No Test provider was free to answer, so no model ran and this text is fixed.' }, finish_reason: 'stop' }], katara: { simulated: true, cost_usdc: '0.05', served: { model: 'katara/simulated@1' } } });
  const simulatedChallenge = (n: Network = MAINNET) => { const c = liveChallenge(n); for (const a of c.accepts) a.extra.served = 'katara/simulated@1'; return c; };
  const fixtureTask: CompletionRequest = { ...task, fixtureOutput: { summary: 'fixture finding' } };
  it('gives a Test agent its fixture output and keeps the paid call in the ledger', async () => {
    const s = liveSetup(TEST); try {
      const ledger = new Ledger(join(s.dir, 'ledger.json')); ledger.begin('run', s.config.budget);
      const evidence: CallEvidence[] = [];
      const fetcher = vi.fn(async (_url: string, init: RequestInit) => (init.headers as Record<string, string>)['PAYMENT-SIGNATURE'] ? simulatedReply() : response402(simulatedChallenge(TEST) as any));
      const client = new PaidInference(s.config, ledger, chainStub(0n), 'run', e => evidence.push(structuredClone(e)), fetcher as any);
      expect(JSON.parse(await client.complete(fixtureTask, new AbortController().signal))).toEqual({ summary: 'fixture finding' });
      expect(evidence.at(-1)).toMatchObject({ status: 'succeeded', simulated: true, servedModel: 'katara/simulated@1', costUsdc: '0.05' });
      expect(ledger.list()).toEqual([expect.objectContaining({ state: 'pending', value: '50000', network: TEST.network, to: TEST.settlement })]);
    } finally { s.cleanup(); }
  });
  it('treats either marker as simulated on Test', async () => {
    for (const katara of [{ simulated: true }, { served: { model: 'katara/simulated@1' } }]) {
      const s = liveSetup(TEST); try {
        const ledger = new Ledger(join(s.dir, 'ledger.json')); ledger.begin('run', s.config.budget);
        const reply = () => Response.json({ model: 'katara/cortex@1', choices: [{ message: { content: 'fixed text' }, finish_reason: 'stop' }], katara });
        const fetcher = vi.fn(async (_url: string, init: RequestInit) => (init.headers as Record<string, string>)['PAYMENT-SIGNATURE'] ? reply() : response402(liveChallenge(TEST) as any));
        const client = new PaidInference(s.config, ledger, chainStub(0n), 'run', () => {}, fetcher as any);
        expect(await client.complete(fixtureTask, new AbortController().signal)).toBe('{"summary":"fixture finding"}');
      } finally { s.cleanup(); }
    }
  });
  it('refuses a simulated quote on Live before signing', async () => {
    const s = liveSetup(); try {
      expect(() => selectQuotes(simulatedChallenge(), s.config)).toThrow('simulated_reply_refused');
      const ledger = new Ledger(join(s.dir, 'ledger.json')); ledger.begin('run', s.config.budget);
      const sign = vi.spyOn(s.config.wallet!, 'signTypedData');
      const client = new PaidInference(s.config, ledger, chainStub(50_000n), 'run', () => {}, (async () => response402(simulatedChallenge() as any)) as any);
      await expect(client.complete(fixtureTask, new AbortController().signal)).rejects.toThrow('simulated_reply_refused');
      expect(sign).not.toHaveBeenCalled(); expect(ledger.list()).toHaveLength(0);
    } finally { s.cleanup(); }
  });
  it('refuses a simulated reply on Live and keeps its payment reserved', async () => {
    const { s, ledger, outcome } = await payOnce(MAINNET, 50_000n, () => simulatedReply());
    try {
      expect(outcome).toBe('simulated_reply_refused');
      expect(ledger.list()).toEqual([expect.objectContaining({ state: 'pending', scheme: 'upto' })]);
    } finally { s.cleanup(); }
  });
});

describe('quote rate limit', () => {
  const limited = (retryAfter = '2', code = 'quote_rate_limited') => Response.json({ error: { message: 'Too many unpaid quotes from this address.', type: 'rate_limit_error', code } }, { status: 429, headers: { 'Retry-After': retryAfter } });
  const instantPacer = () => ({ take: vi.fn(async () => {}), hold: vi.fn() });
  function client(s: ReturnType<typeof liveSetup>, ledger: Ledger, fetcher: unknown, pacer = instantPacer(), evidence: CallEvidence[] = []) {
    return new PaidInference(s.config, ledger, chainStub(0n), 'run', e => evidence.push(structuredClone(e)), fetcher as any, pacer as any);
  }
  it('waits for Retry-After and asks again with the same bytes before signing anything', async () => {
    const s = liveSetup(TEST); try {
      const ledger = new Ledger(join(s.dir, 'ledger.json')); ledger.begin('run', s.config.budget);
      const requests: RequestInit[] = [];
      const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
        requests.push(init);
        if ((init.headers as Record<string, string>)['PAYMENT-SIGNATURE']) return success();
        return requests.length === 1 ? limited('2') : response402(liveChallenge(TEST) as any);
      });
      const pacer = instantPacer(); const evidence: CallEvidence[] = [];
      await client(s, ledger, fetcher, pacer, evidence).complete(task, new AbortController().signal);
      expect(pacer.hold).toHaveBeenCalledWith(2_000); expect(pacer.take).toHaveBeenCalledTimes(2);
      expect(requests.map(r => !!(r.headers as Record<string, string>)['PAYMENT-SIGNATURE'])).toEqual([false, false, true]);
      expect(new Set(requests.map(r => r.body)).size).toBe(1);
      expect(evidence.at(-1)).toMatchObject({ status: 'succeeded', quoteWaits: 1 });
      expect(ledger.list()).toHaveLength(1);
    } finally { s.cleanup(); }
  });
  it('stops with quote_rate_limited after the last wait and signs nothing', async () => {
    const s = liveSetup(TEST); try {
      const ledger = new Ledger(join(s.dir, 'ledger.json')); ledger.begin('run', s.config.budget);
      const fetcher = vi.fn(async () => limited());
      const sign = vi.spyOn(s.config.wallet!, 'signTypedData');
      const error = await client(s, ledger, fetcher).complete(task, new AbortController().signal).catch(e => e);
      expect(error).toMatchObject({ code: 'quote_rate_limited', gateway: { status: 429, code: 'quote_rate_limited' } });
      expect(fetcher).toHaveBeenCalledTimes(MAX_QUOTE_WAITS + 1);
      expect(sign).not.toHaveBeenCalled(); expect(ledger.list()).toHaveLength(0);
    } finally { s.cleanup(); }
  });
  it('never resends a payment for a 429 that answers it, and keeps the reservation', async () => {
    const s = liveSetup(TEST); try {
      const ledger = new Ledger(join(s.dir, 'ledger.json')); ledger.begin('run', s.config.budget);
      const fetcher = vi.fn(async (_url: string, init: RequestInit) => (init.headers as Record<string, string>)['PAYMENT-SIGNATURE'] ? limited() : response402(liveChallenge(TEST) as any));
      const pacer = instantPacer();
      const error = await client(s, ledger, fetcher, pacer).complete(task, new AbortController().signal).catch(e => e);
      expect(error).toMatchObject({ code: 'gateway_http_429', gateway: { code: 'quote_rate_limited' } });
      expect(fetcher).toHaveBeenCalledTimes(2); expect(pacer.hold).not.toHaveBeenCalled();
      expect(ledger.list()).toEqual([expect.objectContaining({ state: 'pending' })]);
    } finally { s.cleanup(); }
  });
  it('does not wait on other 429 answers', async () => {
    const s = liveSetup(TEST); try {
      const ledger = new Ledger(join(s.dir, 'ledger.json')); ledger.begin('run', s.config.budget);
      const fetcher = vi.fn(async () => limited('2', 'too_many_requests'));
      const pacer = instantPacer();
      await expect(client(s, ledger, fetcher, pacer).complete(task, new AbortController().signal)).rejects.toMatchObject({ code: 'gateway_http_429' });
      expect(fetcher).toHaveBeenCalledTimes(1); expect(pacer.hold).not.toHaveBeenCalled();
    } finally { s.cleanup(); }
  });
  it('bounds Retry-After to one to sixty seconds', () => {
    expect(retryAfterMs('2')).toBe(2_000); expect(retryAfterMs('0')).toBe(1_000); expect(retryAfterMs('999')).toBe(60_000);
    expect(retryAfterMs(null)).toBe(5_000); expect(retryAfterMs('soon')).toBe(5_000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 0)).toBe(10_000);
  });
  it('paces one wallet to the limit per window, holds after a 429 and stops waiting on cancel', async () => {
    let now = 0;
    const pacer = new QuotePacer(2, 1_000, () => now);
    const signal = new AbortController().signal;
    await pacer.take(signal); await pacer.take(signal);
    const third = pacer.take(signal); let done = false; void third.then(() => { done = true; });
    await new Promise(r => setTimeout(r, 20)); expect(done).toBe(false);
    now = 1_001; await third; expect(done).toBe(true);
    pacer.hold(60_000);
    const stop = new AbortController();
    const held = pacer.take(stop.signal);
    stop.abort(new Error('cancelled'));
    await expect(held).rejects.toThrow('cancelled');
    expect(pacerFor('0xAbC')).toBe(pacerFor('0xabc'));
  });
});

describe('gateway error bodies', () => {
  it('keeps the code, parameter and bounded message of a refusal on the error and the call', async () => {
    const s = liveSetup(TEST); try {
      const ledger = new Ledger(join(s.dir, 'ledger.json')); ledger.begin('run', s.config.budget);
      const message = `Katara Cortex does not take temperature on this route.\u0007${'x'.repeat(400)}`;
      const evidence: CallEvidence[] = [];
      const fetcher = vi.fn(async () => Response.json({ error: { message, type: 'invalid_request_error', code: 'feature_not_supported', param: 'temperature' } }, { status: 400 }));
      const error = await new PaidInference(s.config, ledger, chainStub(0n), 'run', e => evidence.push(structuredClone(e)), fetcher as any, { take: async () => {}, hold: () => {} } as any).complete(task, new AbortController().signal).catch(e => e);
      expect(error).toMatchObject({ code: 'gateway_http_400', gateway: { status: 400, code: 'feature_not_supported', param: 'temperature' } });
      expect(error.message).toContain('Katara answered 400 feature_not_supported (param temperature): Katara Cortex does not take temperature');
      expect(error.gateway.message).toHaveLength(300); expect(error.gateway.message).not.toContain('\u0007');
      expect(evidence.at(-1)).toMatchObject({ status: 'failed', error: 'gateway_http_400', gateway: { code: 'feature_not_supported', param: 'temperature' } });
    } finally { s.cleanup(); }
  });
  it('keeps the status alone when the body is not JSON and drops codes outside the metadata set', async () => {
    expect(await readRefusal(new Response('<html>bad gateway</html>', { status: 502 }))).toEqual({ status: 502 });
    expect(await readRefusal(Response.json({ error: { code: 'has spaces <b>', param: 'temperature' } }, { status: 400 }))).toEqual({ status: 400, param: 'temperature' });
  });
});

describe('one sponsored permit at a time', () => {
  function sharedRun() {
    const s = liveSetup(MAINNET);
    const ledger = new Ledger(join(s.dir, 'ledger.json')); ledger.begin('run', s.config.budget);
    const payments: Paid[] = [];
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const encoded = (init.headers as Record<string, string>)['PAYMENT-SIGNATURE'];
      if (!encoded) return response402(liveChallenge() as any);
      const p = JSON.parse(Buffer.from(encoded, 'base64').toString());
      payments.push({ scheme: p.accepted.scheme, payload: p.payload, extensions: p.extensions });
      return success();
    });
    const nonces = vi.fn(async () => 7n);
    const chain = { ...chainStub(0n), permitNonce: nonces };
    const client = () => new PaidInference(s.config, ledger, chain, 'run', () => {}, fetcher as any, { take: async () => {}, hold: () => {} } as any);
    return { s, ledger, payments, client, nonces };
  }
  it('sponsors one of two concurrent payments and pays the other with exact', async () => {
    const { s, ledger, payments, client, nonces } = sharedRun(); try {
      await Promise.all([client().complete(task, new AbortController().signal), client().complete(task, new AbortController().signal)]);
      expect(payments.map(p => [p.scheme, !!p.extensions?.eip2612GasSponsoring]).sort()).toEqual([['exact', false], ['upto', true]]);
      expect(ledger.list().filter(a => a.sponsored)).toHaveLength(1);
      expect(nonces).toHaveBeenCalledTimes(1);
    } finally { s.cleanup(); }
  });
  it('does not sponsor again while the sponsored authorization is pending, and does after its deadline', async () => {
    const { s, ledger, payments, client, nonces } = sharedRun(); try {
      await client().complete(task, new AbortController().signal);
      await client().complete(task, new AbortController().signal);
      expect(payments.map(p => p.scheme)).toEqual(['upto', 'exact']);
      // Once the deadline has passed the old permit cannot settle, so the nonce is read again and a new permit signed.
      const data = JSON.parse(readFileSync(ledger.file, 'utf8'));
      for (const a of data.authorizations) if (a.sponsored) a.validBefore = '1';
      writeFileSync(ledger.file, JSON.stringify(data));
      const later = new PaidInference(s.config, new Ledger(ledger.file), { ...chainStub(0n), permitNonce: nonces }, 'run', () => {}, vi.fn(async (_u: string, init: RequestInit) => {
        const encoded = (init.headers as Record<string, string>)['PAYMENT-SIGNATURE'];
        if (!encoded) return response402(liveChallenge() as any);
        const p = JSON.parse(Buffer.from(encoded, 'base64').toString()); payments.push({ scheme: p.accepted.scheme, payload: p.payload, extensions: p.extensions });
        return success();
      }) as any, { take: async () => {}, hold: () => {} } as any);
      await later.complete(task, new AbortController().signal);
      expect(payments.map(p => p.scheme)).toEqual(['upto', 'exact', 'upto']);
      expect(payments[2]!.extensions?.eip2612GasSponsoring).toBeDefined();
      expect(nonces).toHaveBeenCalledTimes(2);
    } finally { s.cleanup(); }
  });
  it('frees the slot when a sponsored payment fails before it is reserved', async () => {
    const { s, ledger, payments, client } = sharedRun(); try {
      const failing = new PaidInference(s.config, ledger, { ...chainStub(0n), balance: async () => { throw new Error('rpc down'); } }, 'run', () => {}, (async () => response402(liveChallenge() as any)) as any, { take: async () => {}, hold: () => {} } as any);
      await expect(failing.complete(task, new AbortController().signal)).rejects.toThrow();
      await client().complete(task, new AbortController().signal);
      expect(payments.map(p => [p.scheme, !!p.extensions])).toEqual([['upto', true]]);
    } finally { s.cleanup(); }
  });
});
