import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { Ledger, acquireWalletLock } from '../src/ledger.js';
import { authorization, setup } from './helpers.js';

describe('payment reservations', () => {
  it('lets only one concurrent child reserve the last affordable payment', async () => {
    const s = setup(); try {
      const ledger = new Ledger(join(s.dir, 'ledger.json')); ledger.begin('run', 10_000n);
      const outcomes = await Promise.allSettled([1, 2].map(async () => { await Promise.resolve(); ledger.reserve(authorization(s.config), 20_000n); }));
      expect(outcomes.filter(x => x.status === 'fulfilled')).toHaveLength(1);
      expect(ledger.exposure('run')).toBe(10_000n);
      expect(new Ledger(ledger.file).pending()).toBe(10_000n);
      expect(statSync(ledger.file).mode & 0o777).toBe(0o600);
    } finally { s.cleanup(); }
  });
  it('keeps an earlier authorization reserved across a fresh challenge', () => {
    const s = setup(); try {
      const ledger = new Ledger(join(s.dir, 'ledger.json')); ledger.begin('run', 20_000n);
      ledger.reserve(authorization(s.config), 100_000n); ledger.reserve(authorization(s.config), 100_000n);
      expect(() => ledger.reserve(authorization(s.config), 100_000n)).toThrow('budget_exhausted');
      expect(new Ledger(ledger.file).pending()).toBe(20_000n);
    } finally { s.cleanup(); }
  });
  it('releases only confirmed excess and makes duplicate confirmations idempotent', () => {
    const s = setup(); try {
      const ledger = new Ledger(join(s.dir, 'ledger.json')); ledger.begin('run', 20_000n);
      const a = authorization(s.config); ledger.reserve(a, 30_000n);
      const tx = `0x${'a'.repeat(64)}`;
      ledger.confirm(a.id, 4000n, tx, 120n, `0x${'b'.repeat(64)}`);
      ledger.confirm(a.id, 4000n, tx, 120n, `0x${'b'.repeat(64)}`);
      expect(ledger.exposure()).toBe(4000n); expect(ledger.pending()).toBe(0n);
      expect(() => ledger.confirm(a.id, 5000n, tx, 120n, '')).toThrow('settlement_mismatch');
      expect(() => ledger.confirm(a.id, 11000n, tx, 120n, '')).toThrow('settlement_mismatch');
    } finally { s.cleanup(); }
  });
  it('requires finalized expiry and unused authorization state to release', () => {
    const s = setup(); try {
      const ledger = new Ledger(join(s.dir, 'ledger.json')); ledger.begin('run', 20_000n);
      const a = authorization(s.config, { validBefore: '300' }); ledger.reserve(a, 30_000n);
      expect(() => ledger.expire(a.id, 300n, true)).toThrow('unsafe_release');
      expect(() => ledger.expire(a.id, 301n, false)).toThrow('unsafe_release');
      expect(ledger.pending()).toBe(10_000n);
      ledger.expire(a.id, 301n, true); expect(ledger.exposure()).toBe(0n);
    } finally { s.cleanup(); }
  });
  it('refuses duplicate nonces and exposure beyond the available token balance', () => {
    const s = setup(); try {
      const ledger = new Ledger(join(s.dir, 'ledger.json')); ledger.begin('run', 100_000n);
      const a = authorization(s.config); ledger.reserve(a, 15_000n);
      expect(() => ledger.reserve(a, 100_000n)).toThrow('authorization_replay');
      expect(() => ledger.reserve(authorization(s.config), 15_000n)).toThrow('insufficient_unreserved_balance');
    } finally { s.cleanup(); }
  });
  it('refuses corrupt persisted data and concurrent wallet processes', () => {
    const s = setup(); try {
      const file = join(s.dir, 'ledger.json'); writeFileSync(file, '{broken');
      expect(() => new Ledger(file)).toThrow('could not be validated');
      const release = acquireWalletLock(s.dir, s.config.wallet!.address);
      expect(() => acquireWalletLock(s.dir, s.config.wallet!.address)).toThrow('Another process');
      release(); expect(existsSync(join(s.dir, `wallet-${s.config.wallet!.address.toLowerCase()}.lock`))).toBe(false);
      expect(readFileSync(file, 'utf8')).toBe('{broken');
    } finally { s.cleanup(); }
  });
});
