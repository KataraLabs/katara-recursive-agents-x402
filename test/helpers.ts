import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { randomBytes, randomUUID } from 'node:crypto';
import { MAINNET, type Config, type Network } from '../src/config.js';
import type { Authorization, Example, RunReport } from '../src/types.js';
import { agentCount } from '../src/examples.js';

export const SETTLEMENT = '0x1111111111111111111111111111111111111111' as const;

export function setup(network: Network = MAINNET) {
  const dir = mkdtempSync(join(tmpdir(), 'katara-demo-test-'));
  const config: Config = { network, gateway: network.gateway, model: network.model, asset: network.asset, settlement: SETTLEMENT, rpc: network.rpc, wallet: privateKeyToAccount(generatePrivateKey()), budget: 100_000n, concurrency: 2, deadlineSeconds: 300, maxTokens: 768, stateDir: dir };
  return { dir, config, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
export function authorization(config: Config, override: Partial<Authorization> = {}): Authorization {
  return { id: randomUUID(), runId: 'run', callId: randomUUID(), agentId: 'master', requestHash: 'hash', from: config.wallet!.address, to: config.settlement, asset: config.asset, network: config.network.network, nonce: `0x${randomBytes(32).toString('hex')}`, value: '10000', validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 300), startBlock: '100', state: 'pending', ...override };
}
export function report(example: Example): RunReport {
  return { version: 1, id: 'test', example: example.id, title: example.title, command: example.command, mode: 'fixture', startedAt: new Date().toISOString(), status: 'running', softwareCommit: 'test-fixture', gateway: 'none', network: 'none', model: 'fixture', budgetUnits: '0', budgetScope: 'test', plannedAgents: agentCount(example), agents: [], calls: [], sources: [], payments: [] };
}
/** A read-only payment chain with a funded wallet; allowance is the wallet's Permit2 allowance. */
export function chainStub(allowance = 0n, balance = 1_000_000n) {
  return { balance: async () => balance, blockNumber: async () => 100n, permit2Allowance: async () => allowance, permitNonce: async () => 7n };
}
