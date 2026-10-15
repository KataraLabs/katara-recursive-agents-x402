import { expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createWallet } from '../src/wallet.js';
import { setup } from './helpers.js';
it('creates a private environment without printing or overwriting its key', () => {
  const s = setup(); try {
    const address = createWallet(s.dir); const file = join(s.dir, '.env'); const original = readFileSync(file, 'utf8');
    expect(address).toMatch(/^0x[\da-fA-F]{40}$/); expect(original).toContain(`KATARA_BUYER_ADDRESS=${address}`);
    expect(statSync(file).mode & 0o777).toBe(0o600); expect(() => createWallet(s.dir)).toThrow('Wallet creation requires');
    expect(readFileSync(file, 'utf8')).toBe(original);
  } finally { s.cleanup(); }
});
