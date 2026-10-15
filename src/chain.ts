/** @module Read-only Avalanche checks and finalized evidence used to reconcile exact and upto USDC authorizations. */
import { createPublicClient, decodeEventLog, domainSeparator, http, parseAbi, parseAbiItem, type Hex, type TransactionReceipt } from 'viem';
import { avalanche, avalancheFuji } from 'viem/chains';
import { PERMIT2, TEST, UPTO_PROXY, type Config } from './config.js';
import { pause, retryAfterMs } from './wait.js';
import { DemoError, type Authorization } from './types.js';
import { Ledger } from './ledger.js';

/** Native USDC views and events needed to validate its signing domain and net authorization charge. */
export const TOKEN_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)',
  'function name() view returns (string)', 'function DOMAIN_SEPARATOR() view returns (bytes32)', 'function authorizationState(address,bytes32) view returns (bool)',
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
  'function allowance(address owner, address spender) view returns (uint256)', 'function nonces(address owner) view returns (uint256)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
/** Permit2's unordered nonce bitmap: bit (nonce & 255) of word (nonce >> 8) is set once a signature is used. */
export const PERMIT2_ABI = parseAbi(['function nonceBitmap(address owner, uint256 wordPos) view returns (uint256)']);
/** Settlement token identity and the event required to establish an x402 charge. */
export const SETTLEMENT_ABI = parseAbi(['function token() view returns (address)', 'event Settled(bytes32 indexed ticketHash, address indexed buyer, address indexed provider, uint256 actualAmount, uint256 fee, uint8 mode)']);
const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
/** Settled.mode values from the settlement contract's enum: X402=0, Prepaid=1, Permit2=2, Allowance=3. */
const MODE_X402 = 0; const MODE_PERMIT2 = 2;

/** How hard to retry an RPC that answers 429 or 5xx. Waits follow Retry-After when sent, else double from baseMs. */
export interface RpcRetry { attempts: number; baseMs: number; maxMs: number }
/** Five attempts in all, waiting 1, 2, 4 and 8 seconds, or as Retry-After says up to 10 seconds. */
export const RPC_RETRY: RpcRetry = { attempts: 5, baseMs: 1_000, maxMs: 10_000 };
/**
 * Wrap fetch for JSON-RPC: a 429 or 5xx answer is retried after a bounded, cancellable wait, at most attempts times
 * in all, and the last answer is returned for the caller to report. A Retry-After longer than maxMs is not waited
 * out: the answer is returned at once. Each attempt has its own 20-second timeout.
 */
export function retryingFetch(retry: RpcRetry = RPC_RETRY, signal?: AbortSignal, fetcher: typeof fetch = fetch) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    for (let attempt = 1; ; attempt++) {
      const signals = [AbortSignal.timeout(20_000), init?.signal, signal].filter((s): s is AbortSignal => !!s);
      const response = await fetcher(input, { ...init, signal: AbortSignal.any(signals) });
      if (response.status !== 429 && response.status < 500) return response;
      if (attempt >= retry.attempts) return response;
      const asked = response.headers.get('retry-after') ? retryAfterMs(response.headers.get('retry-after'), Date.now(), retry.baseMs, 0, Number.MAX_SAFE_INTEGER) : undefined;
      if (asked !== undefined && asked > retry.maxMs) return response;
      const wait = asked ?? Math.min(retry.maxMs, retry.baseMs * 2 ** (attempt - 1));
      await response.body?.cancel();
      await pause(wait, AbortSignal.any([init?.signal, signal].filter((s): s is AbortSignal => !!s)));
    }
  };
}
/**
 * Turn an RPC failure into a stable error that names the HTTP status and how to use another endpoint. The RPC URL
 * itself is never included, since private endpoints often carry a key in their path.
 */
export function rpcError(error: unknown, config: Config): unknown {
  if (error instanceof DemoError) return error;
  const hint = `Wait and run again, or set KATARA_RPC_URL in .env to your own HTTPS RPC endpoint for ${config.network.name}.`;
  for (let e: any = error, depth = 0; e && depth < 8; e = e.cause, depth++) {
    if (e.name === 'HttpRequestError' && Number.isInteger(e.status)) {
      const asked = typeof e.headers?.get === 'function' && /^\d{1,7}$/.test(String(e.headers.get('retry-after') ?? '')) ? Number(e.headers.get('retry-after')) : undefined;
      const wait = asked && asked > 60 ? ` and asked to wait ${Math.ceil(asked / 60)} minutes` : '';
      return new DemoError(`rpc_http_${e.status}`, `The ${config.network.name} RPC answered HTTP ${e.status}${e.status === 429 ? ' (rate limited)' : ''}${wait}. ${hint}`);
    }
    if (e.name === 'TimeoutError' || e.name === 'HttpRequestError') return new DemoError('rpc_unavailable', `The ${config.network.name} RPC did not answer. ${hint}`);
  }
  return error;
}
/**
 * Match a successful receipt to one authorization, one x402 settlement, and the net token debit.
 * @returns The actual charge in USDC base units and ticket hash, or undefined for incomplete or ambiguous evidence.
 */
export function receiptCharge(a: Authorization, receipt: TransactionReceipt): { actual: bigint; ticketHash: string } | undefined {
  if (receipt.status !== 'success') return;
  let nonceSeen = false; let debit = 0n; let credit = 0n;
  const settled: { actual: bigint; ticketHash: string }[] = [];
  for (const log of receipt.logs) {
    if (same(log.address, a.asset)) {
      try {
        const event = decodeEventLog({ abi: TOKEN_ABI, data: log.data, topics: log.topics });
        if (event.eventName === 'AuthorizationUsed' && same(event.args.authorizer, a.from) && same(event.args.nonce, a.nonce)) nonceSeen = true;
        if (event.eventName === 'Transfer') {
          if (same(event.args.from, a.from)) debit += event.args.value;
          if (same(event.args.to, a.from)) credit += event.args.value;
        }
      } catch { /* Other token events do not establish this authorization's charge. */ }
    }
    if (same(log.address, a.to)) {
      try {
        const event = decodeEventLog({ abi: SETTLEMENT_ABI, data: log.data, topics: log.topics });
        if (event.eventName === 'Settled' && same(event.args.buyer, a.from) && event.args.mode === MODE_X402) settled.push({ actual: event.args.actualAmount, ticketHash: event.args.ticketHash });
      } catch { /* Unrelated contract events are ignored. */ }
    }
  }
  if (!nonceSeen || settled.length !== 1) return;
  const result = settled[0]!;
  if (debit !== BigInt(a.value) || credit > debit || debit - credit !== result.actual || result.actual > BigInt(a.value)) return;
  return result;
}

/**
 * Read the network's USDC, Permit2 and settlement state on Avalanche C-Chain or Fuji; this class never submits transactions.
 */
export class AvalancheChain {
  readonly client;
  /**
   * Bind the verified configuration to an HTTPS RPC with bounded request timeouts. No network request occurs here.
   */
  private cache = new Map<string, { at: number; value: Promise<bigint> }>();
  private cacheMs: number;
  /**
   * @param options signal cancels RPC retries; retry and fetcher are for tests; cacheMs is how long balance, block
   * number and Permit2 allowance reads are reused. Those three only gate reservations conservatively: pending
   * reservations are subtracted from the balance until reconciled, an older start block widens the log search, and a
   * stale allowance at worst makes the gateway answer 412, which falls back to exact.
   */
  constructor(readonly config: Config, options: { signal?: AbortSignal; retry?: RpcRetry; fetcher?: typeof fetch; cacheMs?: number } = {}) {
    this.cacheMs = options.cacheMs ?? 5_000;
    this.client = createPublicClient({ chain: config.network.chainId === TEST.chainId ? avalancheFuji : avalanche, transport: http(config.rpc, { retryCount: 0, timeout: 180_000, fetchFn: retryingFetch(options.retry, options.signal, options.fetcher) }) });
  }
  /** Run reads and translate an RPC failure into rpcError's stable code. */
  private async guard<T>(read: () => Promise<T>): Promise<T> {
    try { return await read(); } catch (error) { throw rpcError(error, this.config); }
  }
  /** Reuse a recent read; a failed read is not kept. */
  private cached(key: string, read: () => Promise<bigint>): Promise<bigint> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.cacheMs) return hit.value;
    const value = this.guard(read);
    this.cache.set(key, { at: Date.now(), value });
    value.catch(() => { if (this.cache.get(key)?.value === value) this.cache.delete(key); });
    return value;
  }
  /**
   * Verify the chain, token domain and deployed settlement token before paid work.
   * @returns Public wallet address, USDC balance and Permit2 allowance in base units, and the observation block.
   * @throws DemoError when configuration or contract evidence disagrees, or rpc_http_<status> / rpc_unavailable when the
   * RPC still fails after retries.
   */
  async check(): Promise<{ address: string; balance: string; permit2Allowance: string; block: string }> { return this.guard(() => this.checkChain()); }
  private async checkChain(): Promise<{ address: string; balance: string; permit2Allowance: string; block: string }> {
    const address = this.config.wallet?.address;
    if (!address) throw new DemoError('wallet_missing');
    const { network } = this.config;
    const [chainId, decimals, name, domainMatches, token, code, permit2, proxy, balance, block] = await Promise.all([
      this.client.getChainId(),
      this.client.readContract({ address: this.config.asset, abi: TOKEN_ABI, functionName: 'decimals' }),
      this.client.readContract({ address: this.config.asset, abi: TOKEN_ABI, functionName: 'name' }),
      this.domainMatches(),
      this.client.readContract({ address: this.config.settlement, abi: SETTLEMENT_ABI, functionName: 'token' }),
      this.client.getCode({ address: this.config.settlement }),
      this.client.getCode({ address: PERMIT2 }), this.client.getCode({ address: UPTO_PROXY }),
      this.balance(), this.client.getBlockNumber(),
    ]);
    const allowance = await this.permit2Allowance();
    const deployed = (c: string | undefined) => !!c && c !== '0x';
    if (chainId !== network.chainId || decimals !== 6 || name !== 'USD Coin' || !domainMatches || !same(token, network.asset) || !deployed(code) || !deployed(permit2) || !deployed(proxy)) throw new DemoError('chain_configuration_mismatch');
    return { address, balance: balance.toString(), permit2Allowance: allowance.toString(), block: block.toString() };
  }
  /**
   * Compare the token's own EIP-712 domain with the one the signer uses: USD Coin, version 2, this chain, this token.
   */
  private async domainMatches(): Promise<boolean> {
    const { network } = this.config;
    if (network.domainSource === 'separator') {
      const domain = await this.client.readContract({ address: this.config.asset, abi: TOKEN_ABI, functionName: 'DOMAIN_SEPARATOR' });
      return same(domain, domainSeparator({ domain: { name: 'USD Coin', version: '2', chainId: network.chainId, verifyingContract: network.asset } }));
    }
    const [, name, version, chainId, verifyingContract] = await this.client.readContract({ address: this.config.asset, abi: TOKEN_ABI, functionName: 'eip712Domain' });
    return name === 'USD Coin' && version === '2' && chainId === BigInt(network.chainId) && same(verifyingContract, network.asset);
  }
  /**
   * Read the wallet's token allowance for Permit2 in base units; upto needs it to cover the quote.
   */
  async permit2Allowance(): Promise<bigint> { return this.cached('allowance', () => this.client.readContract({ address: this.config.asset, abi: TOKEN_ABI, functionName: 'allowance', args: [this.config.wallet!.address, PERMIT2] })); }
  /**
   * Read the wallet's EIP-2612 nonce; only native USDC on Live supports permits.
   */
  async permitNonce(): Promise<bigint> { return this.guard(() => this.client.readContract({ address: this.config.asset, abi: TOKEN_ABI, functionName: 'nonces', args: [this.config.wallet!.address] })); }
  /**
   * Read the current wallet balance in USDC base units; callers subtract all outstanding reservations before signing.
   */
  async balance(): Promise<bigint> { return this.cached('balance', () => this.client.readContract({ address: this.config.asset, abi: TOKEN_ABI, functionName: 'balanceOf', args: [this.config.wallet!.address] })); }
  /**
   * Capture the starting block for later bounded authorization-log searches.
   */
  async blockNumber(): Promise<bigint> { return this.cached('block', () => this.client.getBlockNumber()); }
  /**
   * Update the ledger only from finalized chain evidence. Missing or ambiguous evidence keeps funds reserved.
   * @param ledger Wallet-scoped ledger to mutate; the caller must hold its process lock.
   * @throws DemoError if a reservation belongs to another wallet, token, network or recipient.
   */
  async reconcile(ledger: Ledger): Promise<void> { return this.guard(() => this.reconcileAll(ledger)); }
  private async reconcileAll(ledger: Ledger): Promise<void> {
    const pending = ledger.list().filter(a => a.state === 'pending');
    if (!pending.length) return;
    const finalized = await this.client.getBlock({ blockTag: 'finalized' });
    for (const a of pending) {
      if (!same(a.from, this.config.wallet!.address) || !same(a.asset, this.config.asset) || !same(a.to, this.config.settlement) || a.network !== this.config.network.network) throw new DemoError('ledger_wallet_mismatch');
      if (a.scheme === 'upto') await this.reconcileUpto(ledger, a, finalized.number, finalized.timestamp);
      else await this.reconcileExact(ledger, a, finalized.number, finalized.timestamp);
    }
  }
  /**
   * Confirm an EIP-3009 authorization from the receipt that used its nonce, or expire it once unused past its window.
   */
  private async reconcileExact(ledger: Ledger, a: Authorization, finalized: bigint, finalizedTime: bigint): Promise<void> {
    const used = await this.client.readContract({ address: this.config.asset, abi: TOKEN_ABI, functionName: 'authorizationState', args: [a.from as Hex, a.nonce as Hex], blockNumber: finalized });
    if (!used) {
      if (finalizedTime > BigInt(a.validBefore)) ledger.expire(a.id, finalizedTime, true);
      return;
    }
    let found = false;
    for (let from = BigInt(a.startBlock), pages = 0; from <= finalized && !found && pages < 100; from += 2000n, pages++) {
      const to = from + 1999n < finalized ? from + 1999n : finalized;
      const logs = await this.client.getLogs({ address: this.config.asset, event: parseAbiItem('event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)'), args: { authorizer: a.from as Hex, nonce: a.nonce as Hex }, fromBlock: from, toBlock: to, strict: true });
      for (const log of logs) {
        const receipt = await this.client.getTransactionReceipt({ hash: log.transactionHash });
        if (receipt.blockNumber > finalized) continue;
        const result = receiptCharge(a, receipt);
        if (result) { ledger.confirm(a.id, result.actual, receipt.transactionHash, receipt.blockNumber, result.ticketHash); found = true; }
      }
    }
  }
  /**
   * Confirm a Permit2 upto authorization from the Settled event for its ticket, or expire it once its nonce is unused
   * past the deadline. The proxy pulls the charge and the settlement attributes it in a later transaction, so a used
   * nonce without a finalized Settled event keeps the full maximum reserved.
   */
  private async reconcileUpto(ledger: Ledger, a: Authorization, finalized: bigint, finalizedTime: bigint): Promise<void> {
    const nonce = BigInt(a.nonce);
    const word = await this.client.readContract({ address: PERMIT2, abi: PERMIT2_ABI, functionName: 'nonceBitmap', args: [a.from as Hex, nonce >> 8n], blockNumber: finalized });
    if (((word >> (nonce & 255n)) & 1n) === 0n) {
      if (finalizedTime > BigInt(a.validBefore)) ledger.expire(a.id, finalizedTime, true);
      return;
    }
    if (!a.ticketHash) return;
    for (let from = BigInt(a.startBlock), pages = 0; from <= finalized && pages < 100; from += 2000n, pages++) {
      const to = from + 1999n < finalized ? from + 1999n : finalized;
      const logs = await this.client.getLogs({ address: this.config.settlement, event: SETTLEMENT_ABI[1], args: { ticketHash: a.ticketHash as Hex, buyer: a.from as Hex }, fromBlock: from, toBlock: to, strict: true });
      const settled = logs.filter(l => l.args.mode === MODE_PERMIT2 && l.args.actualAmount! <= BigInt(a.value));
      if (settled.length === 1) { ledger.confirm(a.id, settled[0]!.args.actualAmount!, settled[0]!.transactionHash, settled[0]!.blockNumber, a.ticketHash); return; }
      if (settled.length > 1) return;
    }
  }
}
