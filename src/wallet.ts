/** @module Local wallet creation that never prints or overwrites an existing private key. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { DemoError } from './types.js';

/**
 * Create a new ignored .env from .env.example using exclusive owner-only file creation.
 * @param folder Destination directory; defaults to the current checkout.
 * @returns Only the public wallet address. This does not fund the wallet.
 * @throws DemoError if .env exists or cannot be written.
 */
export function createWallet(folder = process.cwd()): string {
  const template = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const key = generatePrivateKey(); const account = privateKeyToAccount(key);
  const env = template.replace(/^KATARA_BUYER_KEY=.*$/m, `KATARA_BUYER_KEY=${key}`).replace(/^KATARA_BUYER_ADDRESS=.*$/m, `KATARA_BUYER_ADDRESS=${account.address}`);
  try { writeFileSync(resolve(folder, '.env'), env, { flag: 'wx', mode: 0o600 }); }
  catch { throw new DemoError('wallet_file_exists_or_unwritable', 'Wallet creation requires a writable directory without an existing .env.'); }
  return account.address;
}
