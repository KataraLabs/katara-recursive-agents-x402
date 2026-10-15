/** @module Durable wallet locking and budget accounting in integer USDC base units. */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DemoError, type Authorization } from './types.js';

/**
 * Write private JSON through an exclusive temporary file, sync it, rename it and sync the containing directory.
 * @param file Destination path; missing directories use owner-only permissions.
 * @param value JSON-serializable state. Wallet keys and signatures must not be passed here as report data.
 */
export function atomicJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temp, file);
  const directory = openSync(dirname(file), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

/**
 * Exclude concurrent processes using the same wallet state; reclaim a lock only when its PID no longer exists.
 * @returns A release function to call in finally.
 * @throws DemoError for a live owner, invalid lock or unwritable lock file.
 */
export function acquireWalletLock(stateDir: string, address: string): () => void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = join(stateDir, `wallet-${address.toLowerCase()}.lock`);
  if (existsSync(file)) {
    let pid: number;
    try { pid = JSON.parse(readFileSync(file, 'utf8')).pid; }
    catch { throw new DemoError('wallet_lock_invalid'); }
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new DemoError('wallet_lock_invalid');
    try { process.kill(pid, 0); throw new DemoError('wallet_in_use', 'Another process is using this wallet state.'); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
      unlinkSync(file);
    }
  }
  try { writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 }); }
  catch { throw new DemoError('wallet_in_use'); }
  return () => { unlinkSync(file); };
}

/**
 * Private on-disk accounting state. A run budget is immutable once begun.
 */
interface LedgerData { version: 1; budgets: Record<string, string>; authorizations: Authorization[] }
/**
 * Track confirmed net charges and pending maxima. Callers must hold the wallet process lock for mutations.
 */
export class Ledger {
  private data: LedgerData;
  /**
   * Load and validate persisted accounting; corrupted or over-budget state refuses further payments.
   */
  constructor(readonly file: string) {
    if (!existsSync(file)) this.data = { version: 1, budgets: {}, authorizations: [] };
    else {
      try {
        this.data = JSON.parse(readFileSync(file, 'utf8'));
        if (this.data.version !== 1 || !this.data.budgets || !Array.isArray(this.data.authorizations)) throw new Error();
        const nonces = new Set<string>();
        for (const a of this.data.authorizations) {
          if (!a.id || !a.runId || !a.callId || !['pending', 'confirmed', 'expired'].includes(a.state) || !/^0x[\da-fA-F]{64}$/.test(a.nonce) || !/^\d+$/.test(a.value) || BigInt(a.value) <= 0n || !/^\d+$/.test(a.validBefore)) throw new Error();
          if (a.state === 'confirmed' && (!a.transaction || !/^\d+$/.test(a.actual ?? '') || BigInt(a.actual!) > BigInt(a.value))) throw new Error();
          if (nonces.has(a.nonce)) throw new Error(); nonces.add(a.nonce);
        }
        for (const [run, cap] of Object.entries(this.data.budgets)) if (!/^\d+$/.test(cap) || this.exposure(run) > BigInt(cap)) throw new Error();
      } catch { throw new DemoError('ledger_invalid', 'The payment ledger could not be validated; no payments will be signed.'); }
    }
  }
  /**
   * Persist the complete state before control can return to a payment signer.
   */
  private save(): void { atomicJson(this.file, this.data); }
  /**
   * Create one positive invocation cap in USDC base units; reject reuse of a run ID.
   */
  begin(runId: string, cap: bigint): void {
    if (cap <= 0n || this.data.budgets[runId]) throw new DemoError('invalid_run_budget');
    this.data.budgets[runId] = cap.toString(); this.save();
  }
  /**
   * Return detached reservations so report formatting cannot change durable accounting.
   */
  list(runId?: string): Authorization[] { return structuredClone(this.data.authorizations.filter(a => !runId || a.runId === runId)); }
  /**
   * Sum confirmed actual charges and pending maxima, optionally scoped to one run. Expired reservations count as zero.
   */
  exposure(runId?: string): bigint {
    return this.data.authorizations.filter(a => !runId || a.runId === runId).reduce((sum, a) => sum + (a.state === 'confirmed' ? BigInt(a.actual!) : a.state === 'pending' ? BigInt(a.value) : 0n), 0n);
  }
  /**
   * Sum all still-reserved maxima across this wallet ledger in USDC base units.
   */
  pending(): bigint { return this.data.authorizations.filter(a => a.state === 'pending').reduce((sum, a) => sum + BigInt(a.value), 0n); }
  /**
   * Reserve a unique nonce synchronously before signing.
   * @param currentBalance Current USDC balance in base units; all pending reservations are subtracted.
   * @throws DemoError if the run cap, available balance or replay checks fail.
   */
  reserve(a: Authorization, currentBalance: bigint): void {
    const cap = this.data.budgets[a.runId];
    if (!cap || a.state !== 'pending' || BigInt(a.value) <= 0n) throw new DemoError('invalid_reservation');
    if (this.data.authorizations.some(x => x.nonce === a.nonce || x.id === a.id)) throw new DemoError('authorization_replay');
    if (this.exposure(a.runId) + BigInt(a.value) > BigInt(cap)) throw new DemoError('budget_exhausted');
    if (this.pending() + BigInt(a.value) > currentBalance) throw new DemoError('insufficient_unreserved_balance');
    // This synchronous transaction finishes before the signer receives control.
    this.data.authorizations.push(structuredClone(a)); this.save();
  }
  /**
   * Record a validated finalized net charge; repeating the same confirmation is idempotent.
   * @param actual Net buyer debit in USDC base units, bounded by the authorization maximum.
   * @throws DemoError if a later receipt conflicts with an existing confirmation.
   */
  confirm(id: string, actual: bigint, transaction: string, block: bigint, ticketHash: string): void {
    const a = this.data.authorizations.find(x => x.id === id);
    if (!a || a.state === 'expired' || actual < 0n || actual > BigInt(a.value) || !/^0x[\da-f]{64}$/i.test(transaction)) throw new DemoError('settlement_mismatch');
    if (a.state === 'confirmed') {
      if (a.actual !== String(actual) || a.transaction !== transaction) throw new DemoError('settlement_mismatch');
      return;
    }
    Object.assign(a, { state: 'confirmed', actual: actual.toString(), transaction, block: block.toString(), ticketHash }); this.save();
  }
  /**
   * Release a pending maximum only after finalized chain time passes expiry and the nonce is confirmed unused.
   */
  expire(id: string, finalizedTimestamp: bigint, authorizationUnused: boolean): void {
    const a = this.data.authorizations.find(x => x.id === id);
    if (!a || a.state !== 'pending' || !authorizationUnused || finalizedTimestamp <= BigInt(a.validBefore)) throw new DemoError('unsafe_release');
    a.state = 'expired'; this.save();
  }
}
