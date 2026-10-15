/** @module Machine-readable CLI contracts. USDC amounts are integer strings in six-decimal base units. */
import type { ExampleId, GatewayRefusal, Researcher, RunReport } from './types.js';

/** Commands supported by both human and JSON output. */
export type CliCommand = 'help' | 'list' | 'plan' | 'sources' | 'doctor' | 'inspect' | 'run' | 'reconcile' | 'faucet';

/** Counts describe logical agents; a parent can make several inference calls. */
export interface ExampleSummary {
  id: ExampleId;
  title: string;
  command: string;
  description: string;
  specialists: number;
  researchers: number;
  spawnedAgents: number;
  totalAgents: number;
}

/** The fixed tree and source permissions that Katara Cortex may assign work within. */
export interface ExamplePlan extends ExampleSummary {
  assignments: { id: string; title: string; goal: string; researchers: Researcher[] }[];
}

/** Report locations and accounting, without source bodies or wallet secrets. */
export interface ReportSummary {
  example: ExampleId;
  title: string;
  mode: RunReport['mode'];
  status: RunReport['status'];
  agents: number;
  plannedAgents: number;
  calls: number;
  /** Paid Test calls answered by the simulated reply; their agents used fixture output. */
  simulatedCalls: number;
  /** Confirmed net charges in USDC base units, excluding pending authorizations. */
  confirmedUnits: string;
  /** Maximum amounts still reserved; these authorizations may yet settle. */
  pendingUnits: string;
  htmlPath: string;
  jsonPath: string;
}

/** Results remain available on partial runs; inspect the envelope's ok field and process exit code. */
export type CliResult =
  | { command: 'help'; text: string }
  | { command: 'list'; examples: ExampleSummary[] }
  | { command: 'plan'; examples: ExamplePlan[] }
  | { command: 'sources'; examples: { example: ExampleId; retrieved: number; total: number; sources: { id: string; url: string; status: number; error?: string }[] }[] }
  | { command: 'inspect'; runId: string; reports: ReportSummary[] }
  | { command: 'doctor'; mode: 'live' | 'test'; address: string; balanceUnits: string; permit2AllowanceUnits: string; chainId: number; network: string; asset: string; settlement: string; gateway: string; model: string; block: string; configurationVerified: true; paidCapacityVerified: false }
  | { command: 'faucet'; address: string; claimed: boolean; claimTransaction?: string; nextClaimAt?: string; approved: boolean; approveTransaction?: string; balanceUnits: string; permit2AllowanceUnits: string; gasWei: string }
  | { command: 'reconcile'; pendingAuthorizations: number; confirmedUnits: string; pendingUnits: string }
  | { command: 'run'; runId: string; mode: RunReport['mode']; budgetUnits: string; exposureUnits: string; reports: ReportSummary[] };

/** Versioned envelope emitted once to stdout with --json; failures never contain raw exception objects. */
export type CliResponse =
  | { schemaVersion: 1; ok: true; result: CliResult }
  | { schemaVersion: 1; ok: false; command: CliCommand | 'unknown'; error: { code: string; message: string; gateway?: GatewayRefusal }; result?: CliResult };
