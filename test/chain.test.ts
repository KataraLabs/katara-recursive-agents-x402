import { describe, expect, it, vi } from 'vitest';
import { encodeEventTopics, encodeAbiParameters, parseAbiParameters, toHex, type TransactionReceipt } from 'viem';
import { join } from 'node:path';
import { AvalancheChain, LOG_REACH, receiptCharge, TOKEN_ABI, SETTLEMENT_ABI } from '../src/chain.js';
import { Ledger } from '../src/ledger.js';
import { authorization, setup } from './helpers.js';
import { DemoError, type Authorization } from '../src/types.js';

const ticket = `0x${'ab'.repeat(32)}` as const;
const tx = `0x${'cd'.repeat(32)}` as const;
function receipt(a: Authorization, actual = 8000n): TransactionReceipt {
  const transfer = (from: string, to: string, value: bigint) => ({ address: a.asset, topics: encodeEventTopics({ abi: TOKEN_ABI, eventName: 'Transfer', args: { from: from as any, to: to as any } }), data: encodeAbiParameters(parseAbiParameters('uint256'), [value]) });
  return { status: 'success', blockNumber: 101n, transactionHash: tx, logs: [
    { address: a.asset, topics: encodeEventTopics({ abi: TOKEN_ABI, eventName: 'AuthorizationUsed', args: { authorizer: a.from as any, nonce: a.nonce as any } }), data: '0x' },
    transfer(a.from, a.to, BigInt(a.value)), transfer(a.to, a.from, BigInt(a.value) - actual),
    { address: a.to, topics: encodeEventTopics({ abi: SETTLEMENT_ABI, eventName: 'Settled', args: { ticketHash: ticket, buyer: a.from as any, provider: a.to as any } }), data: encodeAbiParameters(parseAbiParameters('uint256,uint256,uint8'), [actual, 10n, 0]) },
  ] } as unknown as TransactionReceipt;
}
describe('finalized settlement evidence', () => {
  it('counts the net charge after a maximum authorization is refunded', () => {
    const s = setup(); try { const a = authorization(s.config); expect(receiptCharge(a, receipt(a))).toEqual({ actual: 8000n, ticketHash: ticket }); } finally { s.cleanup(); }
  });
  it('rejects a receipt for another nonce, a reverted receipt, missing refunds, and ambiguous settlements', () => {
    const s = setup(); try {
      const a = authorization(s.config); const good = receipt(a);
      expect(receiptCharge({ ...a, nonce: ticket }, good)).toBeUndefined();
      expect(receiptCharge(a, { ...good, status: 'reverted' })).toBeUndefined();
      expect(receiptCharge(a, { ...good, logs: good.logs.filter((_, i) => i !== 2) })).toBeUndefined();
      expect(receiptCharge(a, { ...good, logs: [...good.logs, good.logs[3]!] })).toBeUndefined();
      expect(receiptCharge(a, { ...good, logs: good.logs.map(l => ({ ...l, address: a.from as any })) })).toBeUndefined();
      const prepaid = structuredClone(good); prepaid.logs[3]!.data = encodeAbiParameters(parseAbiParameters('uint256,uint256,uint8'), [8000n, 10n, 1]);
      expect(receiptCharge(a, prepaid)).toBeUndefined();
    } finally { s.cleanup(); }
  });
  it('keeps an authorization pending until a matching receipt is finalized', async () => {
    const s = setup(); try {
      const ledger = new Ledger(join(s.dir, 'ledger.json')); ledger.begin('run', s.config.budget);
      const a = authorization(s.config); ledger.reserve(a, 100_000n);
      const chain = new AvalancheChain(s.config);
      vi.spyOn(chain.client, 'getBlock').mockResolvedValue({ number: 100n, timestamp: 1n } as any);
      vi.spyOn(chain.client, 'readContract').mockResolvedValue(true as any);
      vi.spyOn(chain.client, 'getLogs').mockResolvedValue([{ transactionHash: tx }] as any);
      vi.spyOn(chain.client, 'getTransactionReceipt').mockResolvedValue(receipt(a));
      await chain.reconcile(ledger); expect(ledger.list()[0]!.state).toBe('pending');
      vi.mocked(chain.client.getBlock).mockResolvedValue({ number: 101n, timestamp: 2n } as any);
      await chain.reconcile(ledger); expect(ledger.list()[0]).toMatchObject({ state: 'confirmed', actual: '8000', transaction: tx, ticketHash: ticket });
      expect(chain.client.readContract).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 101n }));
    } finally { s.cleanup(); }
  });
});

describe('upto reconciliation', () => {
  // A Permit2 nonce in word 1, bit 5: the bitmap read must use nonce >> 8 and test bit nonce & 255.
  const nonce = (1n << 8n) + 5n;
  function uptoSetup(validBefore = 50n, ticketHash: string | null = ticket) {
    const s = setup();
    const ledger = new Ledger(join(s.dir, 'ledger.json')); ledger.begin('run', s.config.budget);
    const a = authorization(s.config, { scheme: 'upto', nonce: toHex(nonce, { size: 32 }), value: '50000', validBefore: String(validBefore), ...(ticketHash ? { ticketHash } : {}) });
    ledger.reserve(a, 100_000n);
    const chain = new AvalancheChain(s.config);
    return { s, ledger, a, chain };
  }
  const settled = (mode: number, actualAmount: bigint) => ({ args: { ticketHash: ticket, buyer: '0x', provider: '0x', actualAmount, fee: 1n, mode }, transactionHash: tx, blockNumber: 99n });
  it('confirms the charge from the Permit2 Settled event once the nonce is used', async () => {
    const { s, ledger, chain } = uptoSetup(); try {
      vi.spyOn(chain.client, 'getBlock').mockResolvedValue({ number: 101n, timestamp: 10n } as any);
      const read = vi.spyOn(chain.client, 'readContract').mockResolvedValue(1n << 5n as any);
      const logs = vi.spyOn(chain.client, 'getLogs').mockResolvedValue([settled(0, 40_000n), settled(2, 12_000n)] as any);
      await chain.reconcile(ledger);
      expect(ledger.list()[0]).toMatchObject({ state: 'confirmed', actual: '12000', transaction: tx, ticketHash: ticket });
      expect(read).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'nonceBitmap', args: [s.config.wallet!.address, 1n], blockNumber: 101n }));
      expect(logs).toHaveBeenCalledWith(expect.objectContaining({ address: s.config.settlement, args: { ticketHash: ticket, buyer: s.config.wallet!.address } }));
    } finally { s.cleanup(); }
  });
  it('keeps the full maximum reserved while the charge is pulled but not yet attributed', async () => {
    const { s, ledger, chain } = uptoSetup(); try {
      vi.spyOn(chain.client, 'getBlock').mockResolvedValue({ number: 101n, timestamp: 1_000n } as any);
      vi.spyOn(chain.client, 'readContract').mockResolvedValue(1n << 5n as any);
      vi.spyOn(chain.client, 'getLogs').mockResolvedValue([] as any);
      await chain.reconcile(ledger);
      expect(ledger.list()[0]!.state).toBe('pending'); expect(ledger.pending()).toBe(50_000n);
    } finally { s.cleanup(); }
  });
  it('keeps an upto authorization without a ticket pending after its nonce is used', async () => {
    const { s, ledger, chain } = uptoSetup(50n, null); try {
      vi.spyOn(chain.client, 'getBlock').mockResolvedValue({ number: 101n, timestamp: 1_000n } as any);
      vi.spyOn(chain.client, 'readContract').mockResolvedValue(1n << 5n as any);
      const logs = vi.spyOn(chain.client, 'getLogs').mockResolvedValue([] as any);
      await chain.reconcile(ledger);
      expect(ledger.list()[0]!.state).toBe('pending'); expect(logs).not.toHaveBeenCalled();
    } finally { s.cleanup(); }
  });
  it('releases an unused upto authorization only after its deadline in finalized time', async () => {
    const { s, ledger, chain } = uptoSetup(50n); try {
      // Another bit of the same word is set; this nonce's bit is not.
      vi.spyOn(chain.client, 'readContract').mockResolvedValue(1n << 4n as any);
      const block = vi.spyOn(chain.client, 'getBlock').mockResolvedValue({ number: 101n, timestamp: 50n } as any);
      await chain.reconcile(ledger); expect(ledger.list()[0]!.state).toBe('pending');
      block.mockResolvedValue({ number: 102n, timestamp: 51n } as any);
      await chain.reconcile(ledger); expect(ledger.list()[0]!.state).toBe('expired'); expect(ledger.exposure()).toBe(0n);
    } finally { s.cleanup(); }
  });
});

describe('live preflight', () => {
  it('verifies the native USDC domain and settlement token before allowing live work', async () => {
    const { domainSeparator } = await import('viem');
    const { MAINNET, PERMIT2 } = await import('../src/config.js');
    const s = setup(); try {
      const chain = new AvalancheChain(s.config);
      const domain = domainSeparator({ domain: { name: 'USD Coin', version: '2', chainId: MAINNET.chainId, verifyingContract: MAINNET.asset } });
      let wrong: string | undefined;
      vi.spyOn(chain.client, 'getChainId').mockImplementation(async () => wrong === 'chain' ? 1 : MAINNET.chainId);
      vi.spyOn(chain.client, 'getCode').mockImplementation(async ({ address }: any) => wrong === 'code' && address === s.config.settlement || wrong === 'permit2' && address === PERMIT2 ? '0x' : '0x6000');
      vi.spyOn(chain.client, 'getBlockNumber').mockResolvedValue(100n);
      vi.spyOn(chain.client, 'readContract').mockImplementation(async (q: any) => ({ decimals: wrong === 'decimals' ? 18 : 6, name: wrong === 'name' ? 'Other' : 'USD Coin', DOMAIN_SEPARATOR: wrong === 'domain' ? ticket : domain, token: wrong === 'token' ? s.config.settlement : MAINNET.asset, balanceOf: 100_000n, allowance: 0n }[q.functionName as string]) as any);
      await expect(chain.check()).resolves.toMatchObject({ address: s.config.wallet!.address, balance: '100000' });
      for (const field of ['chain', 'code', 'permit2', 'decimals', 'name', 'domain', 'token']) { wrong = field; await expect(chain.check()).rejects.toThrow('chain_configuration_mismatch'); }
    } finally { s.cleanup(); }
  });
  it('verifies the Fuji test token through its EIP-5267 domain in Test mode', async () => {
    const { TEST, MAINNET } = await import('../src/config.js');
    const s = setup(TEST); try {
      s.config.settlement = TEST.settlement;
      const chain = new AvalancheChain(s.config);
      expect(chain.client.chain?.id).toBe(43113);
      let wrong: string | undefined;
      vi.spyOn(chain.client, 'getChainId').mockResolvedValue(TEST.chainId);
      vi.spyOn(chain.client, 'getCode').mockResolvedValue('0x6000');
      vi.spyOn(chain.client, 'getBlockNumber').mockResolvedValue(100n);
      const read = vi.spyOn(chain.client, 'readContract').mockImplementation(async (q: any) => ({
        decimals: 6, name: 'USD Coin', token: TEST.asset, balanceOf: 100_000n, allowance: 2n ** 255n,
        eip712Domain: ['0x0f', 'USD Coin', wrong === 'version' ? '1' : '2', wrong === 'chain' ? BigInt(MAINNET.chainId) : 43113n, wrong === 'contract' ? MAINNET.asset : TEST.asset, `0x${'00'.repeat(32)}`, []],
      }[q.functionName as string]) as any);
      await expect(chain.check()).resolves.toMatchObject({ balance: '100000', permit2Allowance: String(2n ** 255n) });
      expect(read.mock.calls.map(([q]: any) => q.functionName)).not.toContain('DOMAIN_SEPARATOR');
      for (const field of ['version', 'chain', 'contract']) { wrong = field; await expect(chain.check()).rejects.toThrow('chain_configuration_mismatch'); }
    } finally { s.cleanup(); }
  });
});

describe('RPC rate limits', () => {
  const quick = { attempts: 3, baseMs: 1, maxMs: 5 };
  const rpc = (result: unknown) => async (_input: unknown, init?: RequestInit) => { const req = JSON.parse(String(init!.body)); return Response.json({ jsonrpc: '2.0', id: req.id, result }); };
  const limited = () => new Response('error code: 1015', { status: 429, headers: { 'Retry-After': '0' } });
  it('waits and retries a 429 or 5xx, then returns the answer', async () => {
    const answers = [limited(), new Response('bad gateway', { status: 502 })];
    const ok = rpc('0x10');
    const fetcher = vi.fn(async (input: any, init?: RequestInit) => answers.shift() ?? ok(input, init));
    const s = setup(); try {
      const chain = new AvalancheChain(s.config, { retry: quick, fetcher: fetcher as any });
      await expect(chain.blockNumber()).resolves.toBe(16n);
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally { s.cleanup(); }
  });
  it('stops after the last attempt with the status and the AVALANCHE_RPC_URL hint, never the URL', async () => {
    const s = setup(); try {
      s.config.rpc = 'https://rpc.example/v2/secret-key';
      const fetcher = vi.fn(async () => limited());
      const chain = new AvalancheChain(s.config, { retry: quick, fetcher: fetcher as any });
      const error = await chain.blockNumber().catch(e => e);
      expect(error).toBeInstanceOf(DemoError);
      expect(error.code).toBe('rpc_http_429');
      expect(error.message).toContain('rate limited'); expect(error.message).toContain('AVALANCHE_RPC_URL');
      expect(error.message).not.toContain('secret-key');
      expect(fetcher).toHaveBeenCalledTimes(3);
      await expect(chain.reconcile(new Ledger(join(s.dir, 'l.json')))).resolves.toBeUndefined();
    } finally { s.cleanup(); }
  });
  it('reuses balance and block reads briefly but always reads the permit nonce', async () => {
    const s = setup(); try {
      const fetcher = vi.fn(rpc(`0x${'0'.repeat(63)}7`));
      const chain = new AvalancheChain(s.config, { retry: quick, fetcher: fetcher as any });
      await chain.balance(); await chain.balance(); await chain.blockNumber(); await chain.blockNumber();
      expect(fetcher).toHaveBeenCalledTimes(2);
      await chain.permitNonce(); await chain.permitNonce();
      expect(fetcher).toHaveBeenCalledTimes(4);
    } finally { s.cleanup(); }
  });
  it('stops waiting when the run is cancelled', async () => {
    const s = setup(); try {
      const stop = new AbortController();
      const chain = new AvalancheChain(s.config, { signal: stop.signal, retry: { attempts: 5, baseMs: 60_000, maxMs: 60_000 }, fetcher: (async () => new Response('', { status: 429 })) as any });
      const pending = chain.blockNumber();
      setTimeout(() => stop.abort(new DemoError('cancelled')), 10);
      const started = Date.now();
      await expect(pending).rejects.toBeDefined();
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally { s.cleanup(); }
  });
});

describe('long RPC bans', () => {
  it('does not wait out a Retry-After longer than the cap and says how long the RPC asked for', async () => {
    const s = setup(); try {
      const fetcher = vi.fn(async () => new Response('error code: 1015', { status: 429, headers: { 'Retry-After': '2277' } }));
      const chain = new AvalancheChain(s.config, { retry: { attempts: 5, baseMs: 1, maxMs: 10_000 }, fetcher: fetcher as any });
      const error = await chain.blockNumber().catch(e => e);
      expect(error.code).toBe('rpc_http_429');
      expect(error.message).toContain('asked to wait 38 minutes'); expect(error.message).toContain('AVALANCHE_RPC_URL');
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { s.cleanup(); }
  });
});

describe('eth_getLogs range limits', () => {
  const nonce = (1n << 8n) + 5n;
  // Answers eth_getLogs like Avalanche's public C-Chain RPC: more than `limit` blocks is refused with -32602.
  function logsRpc(limit: bigint, settledAt?: bigint, message = `block range too large: total block range in this request exceeds the maximum of ${limit} blocks`) {
    const ranges: [bigint, bigint][] = [];
    const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const req = JSON.parse(String(init!.body));
      const { fromBlock, toBlock, address } = req.params[0];
      const from = BigInt(fromBlock); const to = BigInt(toBlock); ranges.push([from, to]);
      if (to - from + 1n > limit) return Response.json({ jsonrpc: '2.0', id: req.id, error: { code: -32602, message } });
      const hit = settledAt !== undefined && from <= settledAt && settledAt <= to;
      const log = () => ({ address, blockNumber: toHex(settledAt!), blockHash: `0x${'ee'.repeat(32)}`, transactionHash: tx, transactionIndex: '0x0', logIndex: '0x0', removed: false,
        topics: req.params[0].topics.map((t: unknown, i: number) => i === 3 ? `0x${'00'.repeat(12)}${'11'.repeat(20)}` : t),
        data: encodeAbiParameters(parseAbiParameters('uint256,uint256,uint8'), [12_000n, 1n, 2]) });
      return Response.json({ jsonrpc: '2.0', id: req.id, result: hit ? [log()] : [] });
    });
    return { fetcher, ranges };
  }
  function uptoChain(fetcher: typeof fetch, finalized: bigint) {
    const s = setup();
    const ledger = new Ledger(join(s.dir, 'ledger.json')); ledger.begin('run', s.config.budget);
    ledger.reserve(authorization(s.config, { scheme: 'upto', nonce: toHex(nonce, { size: 32 }), value: '50000', ticketHash: ticket }), 100_000n);
    const chain = new AvalancheChain(s.config, { fetcher });
    vi.spyOn(chain.client, 'getBlock').mockResolvedValue({ number: finalized, timestamp: 1n } as any);
    vi.spyOn(chain.client, 'readContract').mockResolvedValue(1n << 5n as any);
    return { s, ledger, chain };
  }
  it('drops to the limit the RPC states, keeps that width, and finds the settlement', async () => {
    const { fetcher, ranges } = logsRpc(100n, 950n);
    const { s, ledger, chain } = uptoChain(fetcher as any, 5_000n); try {
      await chain.reconcile(ledger);
      expect(ledger.list()[0]).toMatchObject({ state: 'confirmed', actual: '12000', transaction: tx });
      expect(ranges.map(([f, t]) => t - f + 1n)).toEqual([2000n, ...Array(9).fill(100n)]);
      expect(ranges.at(-1)).toEqual([900n, 999n]);
    } finally { s.cleanup(); }
  });
  it('halves the page width while the RPC refuses a range without stating its limit', async () => {
    const { fetcher, ranges } = logsRpc(100n, 950n, 'query exceeds max block range');
    const { s, ledger, chain } = uptoChain(fetcher as any, 5_000n); try {
      await chain.reconcile(ledger);
      expect(ledger.list()[0]!.state).toBe('confirmed');
      // 2000, 1000, 500, 250 and 125 are refused; 62-block pages from block 100 reach 950 on the fourteenth.
      expect(ranges.slice(0, 6).map(([f, t]) => t - f + 1n)).toEqual([2000n, 1000n, 500n, 250n, 125n, 62n]);
      expect(ranges.slice(5).every(([f, t]) => t - f + 1n === 62n)).toBe(true);
      expect(ranges.length).toBe(5 + 14);
    } finally { s.cleanup(); }
  });
  it('covers the same block reach at any page width and stops at the finalized block', async () => {
    const wide = logsRpc(10_000n);
    const a = uptoChain(wide.fetcher as any, 10_000_000n); try {
      await a.chain.reconcile(a.ledger);
      expect(a.ledger.list()[0]!.state).toBe('pending');
      expect(wide.ranges).toHaveLength(Number(LOG_REACH / 2000n));
      expect(wide.ranges.at(-1)![1]).toBe(100n + LOG_REACH - 1n);
    } finally { a.s.cleanup(); }
    const near = logsRpc(100n);
    const b = uptoChain(near.fetcher as any, 1_000n); try {
      await b.chain.reconcile(b.ledger);
      expect(near.ranges.at(-1)![1]).toBe(1_000n);
    } finally { b.s.cleanup(); }
  });
  it('reports another RPC refusal by its JSON-RPC code instead of request_failed', async () => {
    const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const req = JSON.parse(String(init!.body));
      return Response.json({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'header not found' } });
    });
    const { s, ledger, chain } = uptoChain(fetcher as any, 5_000n); try {
      const error = await chain.reconcile(ledger).catch(e => e);
      expect(error).toBeInstanceOf(DemoError);
      expect(error.code).toBe('rpc_error_32000');
      expect(error.message).toContain('-32000'); expect(error.message).toContain('header not found'); expect(error.message).toContain('AVALANCHE_RPC_URL');
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { s.cleanup(); }
  });
});
