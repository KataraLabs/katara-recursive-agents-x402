import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { loadConfig, MAINNET, TEST, ledgerPath, paymentLedgerPath } from '../src/config.js';
import { SETTLEMENT } from './helpers.js';
const env = () => ({ KATARA_BUYER_KEY: generatePrivateKey() });
describe('mainnet configuration', () => {
  it('pins native USDC, chain, gateway, model and the published settlement contract', () => {
    const config = loadConfig({ env: env() });
    expect(config).toMatchObject({ gateway: 'https://api.katara.com', model: 'katara/cortex@1', asset: MAINNET.asset, settlement: MAINNET.settlement, rpc: MAINNET.rpc });
    expect(MAINNET).toMatchObject({ chainId: 43114, network: 'eip155:43114' });
  });
  it('accepts matching optional settings and refuses any that point elsewhere', () => {
    const e = env();
    expect(loadConfig({ env: { ...e, KATARA_SETTLEMENT_ADDRESS: MAINNET.settlement.toLowerCase(), KATARA_CHAIN_ID: '43114', KATARA_X402_ASSET: MAINNET.asset } }).settlement).toBe(MAINNET.settlement);
    for (const change of [{ KATARA_SETTLEMENT_ADDRESS: SETTLEMENT }, { KATARA_SETTLEMENT_ADDRESS: 'bad' }, { KATARA_CHAIN_ID: '43113' }, { KATARA_X402_NETWORK: 'eip155:43113' }, { KATARA_X402_ASSET: SETTLEMENT }, { KATARA_GW_BASE: 'https://wrong.example' }, { KATARA_GW_MODEL: 'other' }]) expect(() => loadConfig({ env: { ...e, ...change } })).toThrow('live demos use');
  });
  it('isolates ledgers by chain, asset, settlement and wallet and refuses path-like addresses', () => {
    const c = loadConfig({ env: env(), stateDir: '/private/tmp/katara-config-test' });
    expect(ledgerPath(c)).toContain(`payments-43114-${MAINNET.asset.toLowerCase()}-${MAINNET.settlement.toLowerCase()}-`);
    const other = privateKeyToAccount(generatePrivateKey());
    expect(ledgerPath({ ...c, wallet: other })).not.toBe(ledgerPath(c));
    expect(ledgerPath({ ...c, settlement: other.address })).not.toBe(ledgerPath(c));
    expect(() => paymentLedgerPath(c.stateDir, '../escape', c.asset, c.settlement, 43114)).toThrow('invalid_ledger_address');
  });
  it('keeps fixtures wallet-free even when live configuration is invalid', () => {
    const config = loadConfig({ fixture: true, env: { KATARA_BUYER_KEY: 'invalid', KATARA_CHAIN_ID: '1', KATARA_RPC_URL: 'bad' } });
    expect(config.wallet).toBeUndefined(); expect(config.rpc).toBe(MAINNET.rpc);
  });
});

describe('Test network mode', () => {
  it('pays on the Test network with the same wallet and no API key', () => {
    const e = env();
    const config = loadConfig({ env: { ...e, KATARA_MODE: 'test' } });
    expect(config.network).toBe(TEST);
    expect(config).toMatchObject({ gateway: 'https://api.katara.com/test', model: 'katara/cortex@1', asset: TEST.asset, settlement: TEST.settlement, rpc: TEST.rpc });
    expect(config.wallet!.address).toBe(loadConfig({ env: e }).wallet!.address);
    expect(TEST).toMatchObject({ chainId: 43113, network: 'eip155:43113' });
    expect(() => loadConfig({ env: { KATARA_MODE: 'test' } })).toThrow('npm run wallet');
    expect(() => loadConfig({ env: { ...e, KATARA_MODE: 'staging' } })).toThrow('live or test');
  });
  it('checks optional pinned values against the Test network', () => {
    const base = { ...env(), KATARA_MODE: 'test' };
    expect(loadConfig({ env: { ...base, KATARA_CHAIN_ID: '43113', KATARA_SETTLEMENT_ADDRESS: TEST.settlement } }).network).toBe(TEST);
    for (const change of [{ KATARA_CHAIN_ID: '43114' }, { KATARA_SETTLEMENT_ADDRESS: MAINNET.settlement }, { KATARA_X402_ASSET: MAINNET.asset }, { KATARA_GW_BASE: MAINNET.gateway }]) expect(() => loadConfig({ env: { ...base, ...change } })).toThrow('test demos use');
  });
  it('keeps Test and Live payments in separate ledgers for one wallet', () => {
    const e = env();
    const live = loadConfig({ env: e, stateDir: '/private/tmp/katara-config-test' });
    const test = loadConfig({ env: { ...e, KATARA_MODE: 'test' }, stateDir: '/private/tmp/katara-config-test' });
    expect(ledgerPath(test)).toContain(`payments-43113-${TEST.asset.toLowerCase()}-${TEST.settlement.toLowerCase()}-${e.KATARA_BUYER_KEY ? test.wallet!.address.toLowerCase() : ''}`);
    expect(ledgerPath(test)).not.toBe(ledgerPath(live));
  });
});
