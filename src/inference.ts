/** @module Paid Katara Cortex completions with fixed EIP-3009 and Permit2 signing boundaries, and offline substitutes. */
import { randomUUID } from 'node:crypto';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { UptoEvmScheme } from '@x402/evm/upto/client';
import type { PaymentRequirements } from '@x402/core/types';
import { isAddress, toHex, type Hex } from 'viem';
import { PERMIT2, UPTO_PROXY, type Config } from './config.js';
import { Ledger } from './ledger.js';
import { digest } from './sources.js';
import { pause, retryAfterMs } from './wait.js';
import { DemoError, errorCode, type Authorization, type CallEvidence, type GatewayRefusal } from './types.js';

/**
 * One bounded model task. fixtureOutput is used only by FixtureInference and is never sent to the gateway.
 */
export interface CompletionRequest {
  agentId: string; purpose: CallEvidence['purpose']; system: string; prompt: string;
  fixtureOutput: unknown;
  maxTokens?: number;
}
/**
 * Completion boundary shared by paid and offline execution; implementations must honor cancellation.
 */
export interface Inference { complete(request: CompletionRequest, signal: AbortSignal): Promise<string> }
/**
 * Read-only chain capability needed to reserve spend and choose a scheme before signing.
 */
export interface PaymentChain {
  balance(): Promise<bigint>; blockNumber(): Promise<bigint>;
  /** The wallet's token allowance for Permit2, in base units. */
  permit2Allowance(): Promise<bigint>;
  /** The wallet's EIP-2612 nonce on the token; only asked for when a quote offers gas-sponsored approval. */
  permitNonce(): Promise<bigint>;
}
/** Fixed EIP-3009 fields accepted by the exact signer; arbitrary model or SDK types are never signed. */
export const AUTH_TYPES = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
] } as const;
/** Fixed Permit2 witness transfer accepted by the upto signer, as the x402 upto proxy verifies it. */
export const UPTO_TYPES = {
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'witness', type: 'Witness' },
  ],
  TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
  Witness: [{ name: 'to', type: 'address' }, { name: 'facilitator', type: 'address' }, { name: 'validAfter', type: 'uint256' }],
} as const;
/** Fixed EIP-2612 approval of Permit2, signed only for a quote that offers eip2612GasSponsoring. */
export const PERMIT_TYPES = { Permit: [
  { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
] } as const;
const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const metadata = (v: unknown): string | undefined => typeof v === 'string' && /^[a-zA-Z0-9_.:@/+-]{1,200}$/.test(v) ? v : undefined;
const uint = (v: unknown) => /^\d{1,78}$/.test(String(v));
/** The Test network's paid stand-in when no Fuji provider is free; it runs no model and its text is fixed. */
export const SIMULATED_MODEL = 'katara/simulated@1';

/** Quote fields accepted per scheme. Unknown fields are refused because they may change what is signed. */
const EXTRA: Record<'exact' | 'upto', Set<string>> = {
  exact: new Set(['name', 'version', 'nonce', 'ticketHash', 'provider', 'model', 'served', 'managed', 'assetTransferMethod']),
  upto: new Set(['name', 'version', 'ticketHash', 'provider', 'model', 'served', 'managed', 'assetTransferMethod', 'facilitatorAddress']),
};
/** The payable entries of one challenge, each already checked against the configured network. */
export interface Quotes { exact?: PaymentRequirements; upto?: PaymentRequirements; sponsored: boolean; extensions?: Record<string, unknown> }
/**
 * Keep the challenge entries this client may sign: the configured network, its USDC token and Katara's settlement
 * contract, a sane amount and lifetime, the token's EIP-712 domain, the requested model, and for upto a Permit2
 * transfer naming a facilitator. Katara lists upto first and exact second for the same maximum. An entry that fails
 * any check is dropped; a challenge with nothing left is refused. eip2612GasSponsoring is the only extension used.
 * @returns Detached quotes; the model cannot select a payment destination.
 * @throws DemoError before signing if the challenge is malformed or no entry is payable.
 */
export function selectQuotes(required: unknown, config: Config): Quotes {
  const r = required as Record<string, unknown>;
  if (!r || typeof r !== 'object' || r.x402Version !== 2 || !Array.isArray(r.accepts) || r.accepts.length > 10) throw new DemoError('invalid_challenge');
  if (r.extensions !== undefined && (!r.extensions || typeof r.extensions !== 'object' || Array.isArray(r.extensions) || Object.keys(r.extensions).length > 10)) throw new DemoError('invalid_challenge');
  const out: Quotes = { sponsored: false };
  let refusal = 'quote_refused';
  for (const q of r.accepts as PaymentRequirements[]) {
    if (!q || (q.scheme !== 'exact' && q.scheme !== 'upto') || out[q.scheme] || q.network !== config.network.network || !same(q.asset, config.asset) || !same(q.payTo, config.settlement)) continue;
    if (typeof q.amount !== 'string' || !/^[1-9]\d{0,17}$/.test(q.amount) || !Number.isSafeInteger(q.maxTimeoutSeconds) || q.maxTimeoutSeconds < 30 || q.maxTimeoutSeconds > 900) continue;
    const extra = q.extra as Record<string, unknown> | undefined;
    const method = q.scheme === 'upto' ? 'permit2' : 'eip3009';
    if (!extra || extra.name !== 'USD Coin' || extra.version !== '2' || (extra.assetTransferMethod !== undefined && extra.assetTransferMethod !== method) || (q.scheme === 'upto' && (extra.assetTransferMethod !== 'permit2' || !isAddress(String(extra.facilitatorAddress)))) || (extra.managed !== undefined && typeof extra.managed !== 'boolean') || Object.keys(extra).some(k => !EXTRA[q.scheme as 'exact' | 'upto'].has(k))) { refusal = 'quote_domain_refused'; continue; }
    if (extra.model !== config.model) { refusal = 'quote_model_mismatch'; continue; }
    // Live never pays for a simulated reply; only the Test network may serve one.
    if (extra.served === SIMULATED_MODEL && config.network.mode !== 'test') { refusal = 'simulated_reply_refused'; continue; }
    out[q.scheme] = structuredClone(q);
  }
  if (!out.exact && !out.upto) throw new DemoError(refusal);
  const ext = r.extensions as Record<string, unknown> | undefined;
  if (out.upto && ext && Object.hasOwn(ext, 'eip2612GasSponsoring')) { out.sponsored = true; out.extensions = { eip2612GasSponsoring: structuredClone(ext.eip2612GasSponsoring) }; }
  return out;
}
/**
 * Consume a response stream under a byte cap and cancel oversized bodies before parsing JSON.
 */
async function readJson(response: Response, max = 1_000_000): Promise<any> {
  const reader = response.body?.getReader();
  if (!reader) throw new DemoError('response_empty');
  let bytes = 0; const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    bytes += value.length;
    if (bytes > max) { await reader.cancel(); throw new DemoError('response_too_large'); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new DemoError('response_invalid_json'); }
}

/**
 * Read a streamed completion under the same byte cap and assemble it into the shape of a JSON reply: the content
 * deltas joined, the last finish reason, and the usage, katara and system_fingerprint fields of the closing chunks.
 * Every chunk that names a model must name the requested one.
 * @throws DemoError when Katara ends the stream with an error chunk (nothing is charged for it), when the stream
 * closes before data: [DONE], or when a chunk is not JSON.
 */
async function readEvents(response: Response, model: string, max = 1_000_000): Promise<any> {
  const reader = response.body?.getReader();
  if (!reader) throw new DemoError('response_empty');
  const decoder = new TextDecoder();
  const out: any = { model, choices: [{ message: { content: '' }, finish_reason: null }] };
  let bytes = 0; let pending = ''; let data: string[] = [];
  const take = (payload: string): boolean => {
    if (payload === '[DONE]') return true;
    let chunk: any;
    try { chunk = JSON.parse(payload); } catch { throw new DemoError('response_invalid_json'); }
    if (chunk?.error) throw new DemoError('completion_stream_failed', 'Katara ended the stream with an error; it charges nothing for a broken stream.', describeError({ status: response.status }, chunk.error));
    if (chunk?.model !== undefined && chunk.model !== model) out.model = chunk.model;
    const choice = chunk?.choices?.[0];
    if (typeof choice?.delta?.content === 'string') out.choices[0].message.content += choice.delta.content;
    if (choice?.finish_reason) out.choices[0].finish_reason = choice.finish_reason;
    if (chunk?.usage && typeof chunk.usage === 'object') out.usage = chunk.usage;
    if (chunk?.katara && typeof chunk.katara === 'object') out.katara = chunk.katara;
    if (typeof chunk?.system_fingerprint === 'string') out.system_fingerprint = chunk.system_fingerprint;
    return false;
  };
  // Server-sent events: data lines accumulate until a blank line ends the event.
  const lines = (text: string): boolean => {
    pending += text;
    let end: number;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end).replace(/\r$/, ''); pending = pending.slice(end + 1);
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      else if (line === '' && data.length) { const payload = data.join('\n'); data = []; if (take(payload)) return true; }
    }
    return false;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { if (lines(decoder.decode() + '\n\n')) return out; throw new DemoError('completion_stream_incomplete', 'The stream closed before Katara finished the reply.'); }
      bytes += value.length;
      if (bytes > max) throw new DemoError('response_too_large');
      if (lines(decoder.decode(value, { stream: true }))) return out;
    }
  } finally { reader.cancel().catch(() => {}); }
}
/**
 * Wait for one promise unless the signal aborts first; a fetch stand-in or body source that ignores the signal still stops.
 */
function raced<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}
/**
 * Give up on a request only when it goes quiet: firstMs until the response starts, then silenceMs between any two
 * pieces of the body. A slow reply that keeps sending is never cut off.
 */
class Silence {
  private readonly control = new AbortController(); private timer?: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal;
  constructor(outer: AbortSignal, firstMs: number, private silenceMs: number) {
    this.signal = AbortSignal.any([outer, this.control.signal]); this.arm(firstMs);
  }
  arm(ms = this.silenceMs): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.control.abort(new DemoError('response_silent', `Katara sent nothing for ${Math.round(ms / 1000)} s.`)), ms);
    this.timer.unref?.();
  }
  stop(): void { clearTimeout(this.timer); }
  /** The same response with a body that resets the timer on every piece and fails with response_silent when it stalls. */
  watch(response: Response): Response {
    const upstream = response.body?.getReader();
    if (!upstream) { this.stop(); return response; }
    const body = new ReadableStream<Uint8Array>({
      pull: async controller => {
        try {
          const { done, value } = await raced(upstream.read(), this.signal);
          if (done) { this.stop(); controller.close(); return; }
          this.arm(); controller.enqueue(value);
        } catch (error) {
          this.stop(); upstream.cancel().catch(() => {});
          controller.error(this.signal.aborted ? this.signal.reason : error);
        }
      },
      cancel: reason => { this.stop(); return upstream.cancel(reason); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
}
/** Longest wait for a reply to start. Katara sends nothing before the model's first token and allows a pay-per-call
 * request about 210 s for it, so the client waits a little longer than that. */
export const FIRST_BYTE_SECONDS = 240;

/**
 * Serialize the completion request shared by both payment paths; the same bytes are resent on a paid retry.
 * @throws DemoError when the body exceeds the 100 kB request cap.
 */
function requestBody(request: CompletionRequest, maxTokens: number, model: string): string {
  const body = JSON.stringify({ model, messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.prompt }], max_tokens: maxTokens, temperature: 0, stream: true, katara: { task: 'extract' } });
  if (Buffer.byteLength(body) > 100_000) throw new DemoError('prompt_too_large');
  return body;
}
/**
 * Validate a 200 completion and copy its public metadata into the call record. Bodies are never recorded.
 * @returns Nonempty model text, and whether the reply is marked as the Test network's simulated reply.
 * @throws DemoError for a different model, empty or truncated output.
 */
async function acceptCompletion(response: Response, model: string, evidence: CallEvidence): Promise<{ message: string; simulated: boolean }> {
  const out = response.headers.get('content-type')?.includes('text/event-stream') ? await readEvents(response, model) : await readJson(response);
  const message = out.choices?.[0]?.message?.content;
  if (out.model !== model || typeof message !== 'string' || !message.trim()) throw new DemoError('completion_invalid');
  if (out.choices?.[0]?.finish_reason === 'length') throw new DemoError('completion_truncated');
  evidence.requestId = metadata(response.headers.get('x-katara-request-id'));
  evidence.servedModel = metadata(out.katara?.served?.model) ?? metadata(typeof out.system_fingerprint === 'string' ? out.system_fingerprint.replace(/^cortex:/, '') : undefined);
  evidence.provider = metadata(out.katara?.served?.provider) ?? metadata(out.katara?.provider);
  if (typeof out.katara?.cost_usdc === 'string' && /^\d{1,12}(\.\d{1,6})?$/.test(out.katara.cost_usdc)) evidence.costUsdc = out.katara.cost_usdc;
  if (out.usage && typeof out.usage === 'object') {
    evidence.usage = {};
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const) if (Number.isSafeInteger(out.usage[key]) && out.usage[key] >= 0) evidence.usage[key] = out.usage[key];
  }
  return { message, simulated: out.katara?.simulated === true || out.katara?.served?.model === SIMULATED_MODEL };
}

/**
 * Reserve every authorization durably before signing and retry identical request bytes under the invocation cap.
 * Upto (Permit2) is preferred when the wallet's Permit2 allowance covers the quote or the quote offers a sponsored
 * approval; otherwise exact (EIP-3009) is paid. A 412 permit2_allowance_required answer to an upto payment is paid
 * again with exact on the same quote. Every signed maximum stays reserved until chain evidence settles or expires it.
 * On Test, a reply marked simulated (no Fuji provider was free) is still a paid call; the agent receives the call's
 * fixture output instead of the fixed text. Live refuses simulated quotes and replies.
 */
export class PaidInference implements Inference {
  /**
   * Bind a run and its locked ledger to transport and metadata recording; construction makes no request.
   */
  constructor(private config: Config, private ledger: Ledger, private chain: PaymentChain, private runId: string, private record: (e: CallEvidence) => void, private fetcher: typeof fetch = fetch, private pacer: QuotePacer = pacerFor(config.wallet!.address)) {}
  /**
   * Request a quote, choose a scheme, reserve the maximum, sign the fixed authorization and validate the completion.
   * @param request Task prompt and output-token limit; bodies and signatures are not recorded.
   * @param signal Cancellation never releases a possibly signed reservation.
   * @returns Nonempty model text after model identity and truncation checks.
   * @throws On refused quotes, exhausted budget, transport errors or invalid completions; payment exposure remains recorded.
   */
  async complete(request: CompletionRequest, signal: AbortSignal): Promise<string> {
    const evidence: CallEvidence = { id: randomUUID(), agentId: request.agentId, purpose: request.purpose, requestedModel: this.config.model, startedAt: new Date().toISOString(), status: 'running', authorizationIds: [] };
    this.record(evidence);
    try {
      const maxTokens = request.maxTokens ?? this.config.maxTokens;
      if (!Number.isSafeInteger(maxTokens) || maxTokens < 128 || maxTokens > 2048) throw new DemoError('invalid_limits');
      const body = requestBody(request, maxTokens, this.config.model);
      const endpoint = `${this.config.gateway}/v1/chat/completions`;
      // Each request has its own silence timer, so waiting for the quote limit never shortens a request.
      const send = async (payment?: string) => {
        const silence = new Silence(signal, Math.max(FIRST_BYTE_SECONDS, this.config.silenceSeconds) * 1000, this.config.silenceSeconds * 1000);
        try {
          const response = await raced(this.fetcher(endpoint, { method: 'POST', redirect: 'error', signal: silence.signal, headers: { 'content-type': 'application/json', ...(payment ? { 'PAYMENT-SIGNATURE': payment } : {}) }, body }), silence.signal);
          silence.arm(); return silence.watch(response);
        } catch (error) { silence.stop(); throw silence.signal.aborted ? silence.signal.reason : error; }
      };
      // Only the unpaid request is ever repeated for the quote limit; a payment is never resent for a 429.
      const requestQuote = async () => {
        for (let waits = 0; ; waits++) {
          await this.pacer.take(signal);
          const first = await send();
          if (first.status !== 429) return first;
          const limited = await readRefusal(first);
          if (limited.code !== 'quote_rate_limited') throw gatewayError(limited);
          if (waits >= MAX_QUOTE_WAITS) throw new DemoError('quote_rate_limited', `Katara's quote limit for this wallet did not clear after ${waits} waits; run again in a minute.`, limited);
          this.pacer.hold(retryAfterMs(first.headers.get('retry-after')));
          evidence.quoteWaits = waits + 1; this.record(evidence);
        }
      };
      let response = await requestQuote(); let signed = false;
      let quotes: Quotes | undefined; let paidWith: 'exact' | 'upto' | undefined; let fellBack = false;
      let refusal: GatewayRefusal | undefined;
      const pay = async (scheme: 'exact' | 'upto', quote: PaymentRequirements, sponsor: boolean) => {
        if (BigInt(quote.amount) + this.ledger.exposure(this.runId) > this.config.budget) throw new DemoError('budget_exhausted');
        const payload = scheme === 'exact' ? await this.signExact(quote, body, request.agentId, evidence, signal) : await this.signUpto(quote, sponsor ? quotes!.extensions : undefined, body, request.agentId, evidence, signal);
        signal.throwIfAborted();
        paidWith = scheme; signed = true;
        response = await send(Buffer.from(JSON.stringify({ ...payload, accepted: quote })).toString('base64'));
      };
      for (let round = 0; round < 3; round++) {
        signal.throwIfAborted();
        if (response.status === 402) {
          const header = response.headers.get('PAYMENT-REQUIRED');
          let required: unknown;
          if (header) {
            if (header.length > 32_000) throw new DemoError('invalid_challenge');
            try { required = JSON.parse(Buffer.from(header, 'base64').toString('utf8')); } catch { throw new DemoError('invalid_challenge'); }
            await response.body?.cancel();
          } else required = await readJson(response, 24_000);
          quotes = selectQuotes(required, this.config); fellBack = false;
          const covered = quotes.upto ? (await this.chain.permit2Allowance()) >= BigInt(quotes.upto.amount) : false;
          // No await between the check and the claim, so concurrent calls cannot both take the sponsorship.
          const sponsor = !!quotes.upto && !covered && quotes.sponsored && this.claimSponsorship();
          try {
            if (quotes.upto && (covered || sponsor)) await pay('upto', quotes.upto, sponsor);
            else if (quotes.exact) await pay('exact', quotes.exact, false);
            else throw new DemoError('permit2_allowance_required', 'This quote can only be paid with upto. Approve Permit2 for the token (npm run faucet does this on Test), then run again.');
          } finally { if (sponsor) sponsoring.delete(this.walletKey); }
        } else if (response.status === 412 && paidWith === 'upto' && quotes?.exact && !fellBack) {
          refusal = await readRefusal(response);
          if (refusal.code !== 'permit2_allowance_required') break;
          // The quote stays valid; the unused upto signature stays reserved until its deadline passes.
          refusal = undefined; fellBack = true; await pay('exact', quotes.exact, false);
        } else break;
      }
      if (response.status !== 200) {
        refusal ??= await readRefusal(response);
        if (response.status === 402 && signed) throw new DemoError('payment_retry_limit', 'Katara asked for payment again after three signed rounds.', refusal);
        if (refusal.code === 'permit2_allowance_required') throw new DemoError(refusal.code, 'Approve Permit2 for the token (npm run faucet does this on Test), then run again.', refusal);
        throw gatewayError(refusal);
      }
      if (!signed) { await response.body?.cancel(); throw new DemoError('unpaid_response_refused'); }
      const { message, simulated } = await acceptCompletion(response, this.config.model, evidence);
      if (simulated) {
        // The marker is model metadata and untrusted: on Live it is refused, on Test it only selects the fixture.
        if (this.config.network.mode !== 'test') throw new DemoError('simulated_reply_refused', 'Live replies must come from a model; this one was marked simulated.');
        evidence.simulated = true; evidence.status = 'succeeded';
        return JSON.stringify(request.fixtureOutput);
      }
      evidence.status = 'succeeded'; return message;
    } catch (error) {
      evidence.status = 'failed'; evidence.error = errorCode(error);
      if (error instanceof DemoError && error.gateway) evidence.gateway = error.gateway;
      throw error;
    }
    finally { evidence.finishedAt = new Date().toISOString(); this.record(evidence); }
  }
  private get walletKey(): string { return `${this.config.network.chainId}:${this.config.wallet!.address.toLowerCase()}`; }
  /**
   * Take this wallet's single sponsored-permit slot. A sponsored permit uses the token's next EIP-2612 nonce, which
   * only advances when a permit settles, so two unsettled permits would share a nonce and all but one would revert.
   * The slot is free when no call in this process is signing one and the ledger holds no pending sponsored
   * authorization before its deadline; otherwise the caller pays with exact.
   */
  private claimSponsorship(): boolean {
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (sponsoring.has(this.walletKey) || this.ledger.list().some(a => a.state === 'pending' && a.sponsored && BigInt(a.validBefore) >= now)) return false;
    sponsoring.add(this.walletKey);
    return true;
  }
  /**
   * Check and persist a reservation, recording its id on the call, before any signature exists.
   */
  private async reserve(fields: Pick<Authorization, 'scheme' | 'nonce' | 'value' | 'validBefore' | 'ticketHash' | 'sponsored'>, body: string, agentId: string, evidence: CallEvidence, signal: AbortSignal): Promise<void> {
    const [balance, block] = await Promise.all([this.chain.balance(), this.chain.blockNumber()]);
    signal.throwIfAborted();
    const id = randomUUID();
    this.ledger.reserve({ id, runId: this.runId, callId: evidence.id, agentId, requestHash: digest(body), from: this.config.wallet!.address, to: this.config.settlement, asset: this.config.asset, network: this.config.network.network, validAfter: '0', startBlock: String(block), state: 'pending', ...fields }, balance);
    evidence.authorizationIds.push(id); this.record(evidence);
  }
  /**
   * Sign an EIP-3009 transfer of exactly the quoted amount to the settlement contract.
   */
  private async signExact(quote: PaymentRequirements, body: string, agentId: string, evidence: CallEvidence, signal: AbortSignal) {
    const { chainId } = this.config.network;
    const scheme = new ExactEvmScheme({
      address: this.config.wallet!.address,
      signTypedData: async data => {
        signal.throwIfAborted();
        if (data.primaryType !== 'TransferWithAuthorization' || !same(data.domain.verifyingContract, this.config.asset) || Number(data.domain.chainId) !== chainId || data.domain.name !== 'USD Coin' || data.domain.version !== '2') throw new DemoError('signing_domain_refused');
        const m = data.message;
        if (!same(m.from, this.config.wallet!.address) || !same(m.to, this.config.settlement) || String(m.value) !== quote.amount || String(m.validAfter) !== '0' || !/^0x[\da-fA-F]{64}$/.test(String(m.nonce)) || !uint(m.validBefore)) throw new DemoError('signing_payload_refused');
        const until = BigInt(String(m.validBefore));
        expiryWithin(until, quote.maxTimeoutSeconds);
        await this.reserve({ scheme: 'exact', nonce: String(m.nonce), value: quote.amount, validBefore: String(until) }, body, agentId, evidence, signal);
        // Sign only the fixed authorization schema, never arbitrary SDK or model types.
        return this.config.wallet!.signTypedData({ domain: { name: 'USD Coin', version: '2', chainId, verifyingContract: this.config.asset }, types: AUTH_TYPES, primaryType: 'TransferWithAuthorization', message: { from: this.config.wallet!.address, to: this.config.settlement, value: BigInt(quote.amount), validAfter: 0n, validBefore: until, nonce: String(m.nonce) as Hex } });
      },
    });
    return scheme.createPaymentPayload(2, quote);
  }
  /**
   * Sign a Permit2 witness transfer of at most the quoted amount through the x402 upto proxy, and, when the quote
   * offers eip2612GasSponsoring and Permit2 lacks allowance, an EIP-2612 permit for exactly that amount.
   */
  private async signUpto(quote: PaymentRequirements, extensions: Record<string, unknown> | undefined, body: string, agentId: string, evidence: CallEvidence, signal: AbortSignal) {
    const { chainId } = this.config.network;
    const wallet = this.config.wallet!;
    let deadline: bigint | undefined;
    const signer = {
      address: wallet.address,
      // The SDK reads only the allowance and the permit nonce, and only for a sponsored approval.
      readContract: async (args: { functionName: string; args?: readonly unknown[] }) => {
        if (args.functionName === 'allowance' && same(args.args?.[0], wallet.address) && same(args.args?.[1], PERMIT2)) return this.chain.permit2Allowance();
        // Never cached: a permit must use the nonce the token holds now.
        if (args.functionName === 'nonces' && same(args.args?.[0], wallet.address)) return this.chain.permitNonce();
        throw new DemoError('chain_read_refused');
      },
      signTypedData: async (data: { domain: Record<string, unknown>; primaryType: string; message: Record<string, any> }) => {
        signal.throwIfAborted();
        const m = data.message;
        if (data.primaryType === 'PermitWitnessTransferFrom') {
          if (deadline !== undefined || data.domain.name !== 'Permit2' || data.domain.version !== undefined || Number(data.domain.chainId) !== chainId || !same(data.domain.verifyingContract, PERMIT2)) throw new DemoError('signing_domain_refused');
          if (!same(m.permitted?.token, this.config.asset) || String(m.permitted?.amount) !== quote.amount || !same(m.spender, UPTO_PROXY) || !same(m.witness?.to, this.config.settlement) || !same(m.witness?.facilitator, String(quote.extra.facilitatorAddress)) || String(m.witness?.validAfter) !== '0' || !uint(m.nonce) || !uint(m.deadline)) throw new DemoError('signing_payload_refused');
          deadline = BigInt(String(m.deadline));
          expiryWithin(deadline, quote.maxTimeoutSeconds);
          const nonce = BigInt(String(m.nonce));
          await this.reserve({ scheme: 'upto', nonce: toHex(nonce, { size: 32 }), value: quote.amount, validBefore: String(deadline), ticketHash: /^0x[\da-fA-F]{64}$/.test(String(quote.extra.ticketHash)) ? String(quote.extra.ticketHash) : undefined, ...(extensions ? { sponsored: true as const } : {}) }, body, agentId, evidence, signal);
          return wallet.signTypedData({ domain: { name: 'Permit2', chainId, verifyingContract: PERMIT2 }, types: UPTO_TYPES, primaryType: 'PermitWitnessTransferFrom', message: { permitted: { token: this.config.asset, amount: BigInt(quote.amount) }, spender: UPTO_PROXY, nonce, deadline, witness: { to: this.config.settlement, facilitator: String(quote.extra.facilitatorAddress) as Hex, validAfter: 0n } } });
        }
        if (data.primaryType === 'Permit' && extensions && deadline !== undefined) {
          if (data.domain.name !== 'USD Coin' || data.domain.version !== '2' || Number(data.domain.chainId) !== chainId || !same(data.domain.verifyingContract, this.config.asset)) throw new DemoError('signing_domain_refused');
          if (!same(m.owner, wallet.address) || !same(m.spender, PERMIT2) || String(m.value) !== quote.amount || !uint(m.nonce) || String(m.deadline) !== String(deadline)) throw new DemoError('signing_payload_refused');
          return wallet.signTypedData({ domain: { name: 'USD Coin', version: '2', chainId, verifyingContract: this.config.asset }, types: PERMIT_TYPES, primaryType: 'Permit', message: { owner: wallet.address, spender: PERMIT2, value: BigInt(quote.amount), nonce: BigInt(String(m.nonce)), deadline } });
        }
        throw new DemoError('signing_domain_refused');
      },
    };
    const result = await new UptoEvmScheme(signer as any).createPaymentPayload(2, quote, extensions ? { extensions } as any : undefined);
    if (deadline === undefined) throw new DemoError('signing_payload_refused');
    return result;
  }
}
/**
 * Refuse an authorization that is already expired or outlives the quote's lifetime (with five seconds of clock slack).
 */
function expiryWithin(until: bigint, maxTimeoutSeconds: number): void {
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (until <= now || until > now + BigInt(maxTimeoutSeconds) + 5n) throw new DemoError('signing_expiry_refused');
}
/**
 * Read a gateway's error answer: its code and parameter in the metadata character set, and at most 300 characters
 * of message with control characters removed. The text is untrusted and is shown, never acted on.
 */
export async function readRefusal(response: Response): Promise<GatewayRefusal> {
  const refusal: GatewayRefusal = { status: response.status };
  try {
    describeError(refusal, (await readJson(response, 24_000))?.error);
  } catch { /* the status still names the failure */ }
  return refusal;
}
function describeError(refusal: GatewayRefusal, error: any): GatewayRefusal {
  const code = metadata(error?.code); const param = metadata(error?.param);
  const message = typeof error?.message === 'string' ? error.message.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, 300) : '';
  if (code) refusal.code = code;
  if (param) refusal.param = param;
  if (message) refusal.message = message;
  return refusal;
}
/**
 * The stable error for a gateway refusal; its message repeats the gateway's code, parameter and text.
 */
export function gatewayError(refusal: GatewayRefusal): DemoError {
  const detail = `${refusal.code ? ` ${refusal.code}` : ''}${refusal.param ? ` (param ${refusal.param})` : ''}${refusal.message ? `: ${refusal.message}` : ''}`;
  return new DemoError(`gateway_http_${refusal.status}`, `Katara answered ${refusal.status}${detail}`, refusal);
}
/** Waits allowed for one call's first quote before the run stops with quote_rate_limited. */
export const MAX_QUOTE_WAITS = 8;
export { retryAfterMs } from './wait.js';
/**
 * Spaces one wallet's unpaid quote requests. Katara lets an address hold ten open quotes and ask for thirty a minute;
 * staying under thirty in any sixty-second window keeps a run inside that in normal use. After a 429, every call
 * through this pacer waits until the gateway's Retry-After has passed.
 */
export class QuotePacer {
  private sent: number[] = [];
  private blockedUntil = 0;
  /**
   * @param limit Quote requests allowed in one window.
   * @param windowMs Window length in milliseconds.
   */
  constructor(private limit = 30, private windowMs = 60_000, private now = () => Date.now()) {}
  /**
   * Wait until one more quote request fits, then count it. Cancellation rejects without counting.
   */
  async take(signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      const t = this.now();
      this.sent = this.sent.filter(x => x > t - this.windowMs);
      if (t < this.blockedUntil) { await pause(this.blockedUntil - t, signal); continue; }
      if (this.sent.length < this.limit) { this.sent.push(t); return; }
      await pause(this.sent[0]! + this.windowMs - t, signal);
    }
  }
  /**
   * Hold every caller for ms milliseconds, as the gateway asked.
   */
  hold(ms: number): void { this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms); }
}
const pacers = new Map<string, QuotePacer>();
/** Wallets (chain id and address) with a sponsored permit being signed in this process. */
const sponsoring = new Set<string>();
/** The pacer shared by every call this process makes for one wallet. */
export function pacerFor(address: string): QuotePacer {
  const key = address.toLowerCase();
  if (!pacers.has(key)) pacers.set(key, new QuotePacer());
  return pacers.get(key)!;
}

/**
 * Return caller-supplied synthetic output without networking, keys, signatures or ledger mutations.
 */
export class FixtureInference implements Inference {
  /**
   * Record fixture call metadata through the same callback shape used for live runs.
   */
  constructor(private record: (e: CallEvidence) => void) {}
  /**
   * Serialize the synthetic output and record one fixture call; cancellation is checked first.
   */
  async complete(request: CompletionRequest, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const now = new Date().toISOString();
    this.record({ id: randomUUID(), agentId: request.agentId, purpose: request.purpose, requestedModel: 'fixture (no inference)', startedAt: now, finishedAt: now, status: 'succeeded', authorizationIds: [] });
    return JSON.stringify(request.fixtureOutput);
  }
}
