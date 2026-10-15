/** @module Katara's Live and Test networks, explicit wallet configuration and exact six-decimal USDC budget parsing. */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { getAddress, isAddress, parseUnits, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DemoError } from './types.js';

/** The canonical Permit2 contract; the same address on Avalanche C-Chain and Fuji. */
export const PERMIT2 = getAddress('0x000000000022D473030F116dDEE9F6B43aC78BA3');
/** The x402 upto proxy every upto signature names as spender; the same address on both chains. */
export const UPTO_PROXY = getAddress('0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002');

/**
 * One Katara network. Both are served by the production API and paid per request with x402 from the same wallet.
 * Token, settlement and faucet addresses are the values Katara publishes on its Networks page
 * (docs.katara.com/about/networks/); preflight checks them again against the gateway and the chain.
 */
export interface Network {
  mode: 'live' | 'test';
  /** Report label: mainnet for Live, test for Test. */
  label: 'mainnet' | 'test';
  name: string;
  gateway: string; model: string;
  chainId: number; network: string; rpc: string;
  asset: Hex; settlement: Hex;
  /** Native USDC exposes DOMAIN_SEPARATOR(); the Test token exposes only EIP-5267 eip712Domain(). */
  domainSource: 'separator' | 'eip5267';
  /** Block explorer for transactions on this chain, as the Networks page names it. */
  explorer: string;
  /** Test USDC faucet; Live has none. */
  faucet?: Hex;
}
/** Live: native USDC on Avalanche C-Chain through https://api.katara.com. The default. */
export const MAINNET = {
  mode: 'live', label: 'mainnet', name: 'Avalanche C-Chain',
  gateway: 'https://api.katara.com', model: 'katara/cortex@1',
  chainId: 43114, network: 'eip155:43114',
  rpc: 'https://api.avax.network/ext/bc/C/rpc',
  asset: getAddress('0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E'),
  settlement: getAddress('0xB54f9763f9C6D34089A752290922Dd301c5724fC'),
  domainSource: 'separator',
  explorer: 'https://snowtrace.io',
} as const satisfies Network;
/** Test: test USDC with no value on Avalanche Fuji through https://api.katara.com/test. */
export const TEST = {
  mode: 'test', label: 'test', name: 'Avalanche Fuji',
  gateway: 'https://api.katara.com/test', model: 'katara/cortex@1',
  chainId: 43113, network: 'eip155:43113',
  rpc: 'https://api.avax-test.network/ext/bc/C/rpc',
  asset: getAddress('0xfed854555faeeca02acdb3fed90b0cd4048d3f45'),
  settlement: getAddress('0x7f8d1049519ddcb1cb041fb1b0df7a125e96acf3'),
  domainSource: 'eip5267',
  explorer: 'https://testnet.snowtrace.io',
  faucet: getAddress('0xe66bcb6d2864d851bb282440fa3da2a82093cbf5'),
} as const satisfies Network;
/**
 * Link a transaction to the explorer of the network it settled on, named by its CAIP-2 id.
 * @returns undefined for an unknown network or a malformed hash, so no link points at the wrong chain.
 */
export function explorerTx(network: string, hash: string): string | undefined {
  const known = [MAINNET, TEST].find(n => n.network === network);
  return known && /^0x[\da-fA-F]{64}$/.test(hash) ? `${known.explorer}/tx/${hash}` : undefined;
}
/**
 * Resolved runtime configuration. The wallet contains signing capability and must never be serialized into reports.
 */
export interface Config {
  network: Network;
  gateway: string; model: string; rpc: string; asset: Hex; settlement: Hex;
  wallet?: ReturnType<typeof privateKeyToAccount>; budget: bigint;
  concurrency: number; deadlineSeconds: number; maxTokens: number;
  stateDir: string;
}
/**
 * Resolve this wallet's ledger without mixing chains, assets, settlement contracts or buyers.
 * @throws DemoError when no wallet is configured.
 */
export function ledgerPath(config: Config): string {
  if (!config.wallet) throw new DemoError('wallet_missing');
  return paymentLedgerPath(config.stateDir, config.wallet.address, config.asset, config.settlement, config.network.chainId);
}
/**
 * Build a wallet ledger path from validated addresses; reject path fragments supplied as addresses.
 */
export function paymentLedgerPath(stateDir: string, buyer: string, asset: string, settlement: string, chainId: number): string {
  if (![buyer, asset, settlement].every(a => isAddress(a)) || !Number.isSafeInteger(chainId)) throw new DemoError('invalid_ledger_address');
  return join(stateDir, `payments-${chainId}-${asset.toLowerCase()}-${settlement.toLowerCase()}-${buyer.toLowerCase()}.json`);
}
/**
 * Parse a positive decimal USDC amount without floating-point arithmetic or rounding.
 * @param value Plain decimal text with at most six fractional digits.
 * @returns The amount in USDC base units.
 * @throws DemoError for zero, negative values, exponents or unsupported precision.
 */
export function money(value: string): bigint {
  if (!/^(0|[1-9]\d{0,5})(\.\d{1,6})?$/.test(value)) throw new DemoError('invalid_budget');
  const units = parseUnits(value, 6);
  if (units <= 0n) throw new DemoError('invalid_budget');
  return units;
}
/**
 * Resolve the network for KATARA_MODE (live by default, or test) and refuse any .env value that disagrees with it.
 * @param options Fixture mode skips .env and wallet loading; explicit env replaces file and process settings.
 * @returns Configuration without performing network requests, signing or funding.
 * @throws DemoError for an unknown mode, mismatched pinned values, wallet or limits.
 */
export function loadConfig(options: { budget?: string; fixture?: boolean; stateDir?: string; env?: Record<string, string | undefined> } = {}): Config {
  const envPath = resolve('.env');
  const file = !options.fixture && !options.env && existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
  const env = options.env ?? { ...file, ...process.env };
  const mode = options.fixture ? 'live' : env.KATARA_MODE || 'live';
  if (mode !== 'live' && mode !== 'test') throw new DemoError('invalid_mode', 'Set KATARA_MODE to live or test.');
  const network: Network = mode === 'test' ? TEST : MAINNET;
  // These keys are optional. When set they must agree with the pinned values, so an edited .env cannot redirect payments.
  const pinned: Record<string, string> = {
    KATARA_GW_BASE: network.gateway, KATARA_GW_MODEL: network.model,
    KATARA_CHAIN_ID: String(network.chainId), KATARA_X402_NETWORK: network.network,
    KATARA_X402_ASSET: network.asset, KATARA_SETTLEMENT_ADDRESS: network.settlement,
  };
  for (const [key, value] of Object.entries(pinned)) {
    if (!options.fixture && env[key] && env[key]!.toLowerCase() !== value.toLowerCase()) throw new DemoError('network_configuration_mismatch', `Check ${key}; ${mode} demos use ${value}. Remove the line to use the published value.`);
  }
  let wallet: Config['wallet'];
  if (!options.fixture) {
    const key = env.KATARA_BUYER_KEY;
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new DemoError('wallet_missing', 'Run npm run wallet, or set KATARA_BUYER_KEY in the ignored .env.');
    try { wallet = privateKeyToAccount(key as Hex); } catch { throw new DemoError('invalid_wallet'); }
    if (env.KATARA_BUYER_ADDRESS && env.KATARA_BUYER_ADDRESS.toLowerCase() !== wallet.address.toLowerCase()) throw new DemoError('wallet_address_mismatch');
  }
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const v = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(v) || v < min || v > max) throw new DemoError('invalid_limits', `Check ${key}.`);
    return v;
  };
  // An RPC for the other chain fails the chain-id check in preflight before anything is signed.
  const rpc = options.fixture ? network.rpc : env.KATARA_RPC_URL || network.rpc;
  const rpcUrl = new URL(rpc);
  if (rpcUrl.protocol !== 'https:' || rpcUrl.username || rpcUrl.password) throw new DemoError('invalid_rpc');
  return {
    network, gateway: network.gateway, model: network.model, rpc,
    asset: network.asset, settlement: network.settlement, wallet,
    budget: money(options.budget ?? env.KATARA_DEMO_BUDGET_USDC ?? '1.00'),
    concurrency: integer('KATARA_DEMO_CONCURRENCY', 2, 1, 4),
    deadlineSeconds: integer('KATARA_DEMO_DEADLINE_SECONDS', 300, 30, 1800),
    maxTokens: integer('KATARA_DEMO_MAX_TOKENS', 768, 128, 2048),
    stateDir: resolve(options.stateDir ?? '.katara'),
  };
}
