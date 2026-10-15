/** @module Public data contracts used by scenarios, reports and versioned JSON Schemas. */

/** Supported scenario identities; adding one also requires registration and synopsis headings. */
export type ExampleId = 'repository' | 'documentation' | 'comparison' | 'trip' | 'cryptocurrency';

/** One permitted public endpoint; URL templates are expanded only by the source collector. */
export interface SourceSpec {
  /** Stable citation ID, unique within its scenario. */
  id: string;
  title: string;
  /** HTTPS URL; repository templates may use {repo} and {commit}. */
  url: string;
  /** Sample at most two same-host links after collecting the page. */
  links?: boolean;
  /** Select a bounded adapter for structured research data instead of HTML extraction. */
  format?: 'candles' | 'tvl' | 'releases' | 'rpc-block';
}

/** Leaf agent with an explicit source scope; a model-generated task cannot expand it. */
export interface Researcher {
  id: string;
  title: string;
  question: string;
  /** References SourceSpec IDs from the same scenario.
   * @minItems 1
   */
  sourceIds: string[];
}

/** Parent agent that plans and synthesizes the work of its fixed researchers. */
export interface Specialist {
  id: string;
  title: string;
  goal: string;
  /** A specialist cannot create extra researchers through model output.
   * @minItems 1
   * @maxItems 3
   */
  researchers: Researcher[];
}

/** Scenario input. Runtime validation also checks unique IDs, source references and the total tree size. */
export interface Example {
  id: ExampleId;
  title: string;
  /** Default user request; --command can replace it without changing source permissions. */
  command: string;
  description: string;
  /** Public owner/name resolved to a commit for repository-source collection. */
  repository?: string;
  /** The source collector refuses endpoints outside these hosts.
   * @maxItems 30
   */
  sources: SourceSpec[];
  /** At most sixteen agents may execute, including the master and all descendants.
   * @minItems 1
   * @maxItems 4
   */
  specialists: Specialist[];
}

/** A retrieved source or a recorded retrieval failure. Public exports shorten text, not its hashes. */
export interface Source {
  id: string;
  title: string;
  url: string;
  /** ISO 8601 observation timestamp; this is not a claim that the source is still current. */
  retrievedAt: string;
  /** HTTP status, or zero if no response was available. */
  status: number;
  /** SHA-256 of retrieved response bytes, or empty before retrieval. */
  sha256: string;
  /** Numbered, bounded source view locally; a short excerpt in public exports. */
  text: string;
  /** Hash of the full local source view; public excerpts cannot be used to verify this hash. */
  textSha256?: string;
  error?: string;
  /** Resolved Git commit for immutable repository citation links. */
  commit?: string;
  /** True only for synthetic offline sources. */
  fixture?: boolean;
  links?: { url: string; status: number; error?: string }[];
}

/** Inclusive source-view line range. Retrieval metadata cannot support a factual claim. */
export interface Citation {
  sourceId: string;
  /** First cited line, starting at one.
   * @integer
   * @minimum 1
   */
  startLine: number;
  /** Last cited line; runtime validation also requires endLine >= startLine.
   * @integer
   * @minimum 1
   */
  endLine: number;
}

/** Only supported findings enter the master synthesis; uncertain means insufficient verification. */
export type EvidenceVerdict = 'supported' | 'unsupported' | 'uncertain';

/** Review provenance. A model verdict is a source-support check, not proof of factual correctness. */
export interface EvidenceAssessment {
  verdict: EvidenceVerdict;
  reason: string;
  /** Hash of the exact assessed claim or original draft section. */
  claimHash: string;
  checkedAt: string;
  /** Distinguishes deterministic checks, paid Katara Cortex review and synthetic fixture review. */
  method: 'policy' | 'model' | 'fixture';
  callId?: string;
  /** Hashes identify cited source spans without exporting their full text. */
  support: { sourceId: string; startLine: number; endLine: number; sourceHash: string; spanHash: string }[];
}

/** A paraphrased observation with citations; assessment is absent until source review runs. */
export interface Finding {
  claim: string;
  citations: Citation[];
  assessment?: EvidenceAssessment;
}

/** One scenario-specific part of the master answer. */
export interface SynopsisSection {
  heading: string;
  body: string;
  citations: Citation[];
  /** Retained for older parser provenance; new synthesis rejects unknown evidence references. */
  unverifiedEvidence?: number[];
}

/** Structured research output. Parent summaries are never treated as evidence without cited findings. */
export interface AgentOutput {
  summary: string;
  findings: Finding[];
  limitations: string[];
  synopsis?: SynopsisSection[];
  /** Coverage of the user's request, independent of execution or payment status. */
  completion?: 'complete' | 'partial';
  /** Assessments refer to the retained original draft; rejected sections may have been replaced. */
  review?: { status: 'supported' | 'partial'; sections: { id: string; assessment: EvidenceAssessment }[] };
}

/** Separate paid or fixture revision tied to the exact bytes of an exported source report. */
export interface SynopsisRevision {
  version: 1;
  id: string;
  sourceRunId: string;
  sourceReportHash: string;
  /** SHA-256 by implementation path; source research is reused rather than refreshed. */
  implementationFingerprint: Record<string, string>;
  example: ExampleId;
  startedAt: string;
  finishedAt?: string;
  mode: 'mainnet' | 'fixture';
  status: 'running' | 'succeeded' | 'failed';
  output?: AgentOutput;
  error?: string;
  calls: CallEvidence[];
  payments: Authorization[];
  evidenceReview?: RunReport['evidenceReview'];
  masterDraft?: AgentOutput;
  /** Raw model draft kept in ignored local state and removed by publicSynopsis. */
  draftText?: string;
  /** Historical parser provenance; exporters never promote an unreviewed draft. */
  postprocessing?: { originalStatus: string; originalError?: string; parserHash: string; processedAt: string };
  reviewNotes?: string[];
  validationIssues: { attempt: number; detail: string }[];
}

/** One logical task in the recursive tree; each task can make multiple bounded inference calls. */
export interface Agent {
  id: string;
  parentId?: string;
  title: string;
  /** Zero is the master; one is a specialist; two is a researcher. */
  depth: number;
  assignment?: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  output?: AgentOutput;
  error?: string;
  children: string[];
  validationIssues?: { purpose: CallEvidence['purpose']; attempt: number; code: string; detail: string }[];
}

/** Completion metadata without prompt bodies, raw responses or payment signatures. */
export interface CallEvidence {
  id: string;
  agentId: string;
  purpose: 'plan' | 'research' | 'synthesize' | 'repair' | 'review';
  requestedModel: string;
  servedModel?: string;
  provider?: string;
  requestId?: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'succeeded' | 'failed';
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  /** Charge the gateway reported in katara.cost_usdc, in USDC (test USDC in test mode). Chain evidence is authoritative for live payments. */
  costUsdc?: string;
  /** The gateway's own error code, parameter and message when it refused this call. */
  gateway?: GatewayRefusal;
  /** Times the call waited for the gateway's quote rate limit before its first quote; waits are not failures. */
  quoteWaits?: number;
  /** Paid Test call answered by the network's simulated reply because no Fuji provider was free; the agent used its fixture output. */
  simulated?: true;
  /** One completion may reserve several maxima after fresh payment challenges. */
  authorizationIds: string[];
  error?: string;
}

/** Durable EIP-3009 reservation. Amounts, times and block numbers remain decimal strings in JSON. */
export interface Authorization {
  id: string;
  runId: string;
  callId: string;
  agentId: string;
  /** Hash of the exact completion request bytes that were retried with payment. */
  requestHash: string;
  from: string;
  /** Verified settlement recipient, never a model-selected address. */
  to: string;
  asset: string;
  network: string;
  /** exact: EIP-3009 transfer of the maximum with a refund; upto: Permit2 transfer of the charge only. Absent means exact. */
  scheme?: 'exact' | 'upto';
  /** Set when an upto payment carried a sponsored EIP-2612 permit; only one may be unsettled per wallet. */
  sponsored?: true;
  /** EIP-3009 nonce, or the Permit2 nonce as 32-byte hex. */
  nonce: string;
  /** Authorized maximum in six-decimal USDC base units.
   * @pattern ^[1-9][0-9]*$
   */
  value: string;
  /** Unix seconds; validity is checked against finalized chain time before releasing a reservation. */
  validAfter: string;
  validBefore: string;
  /** First block searched for authorization and settlement evidence. */
  startBlock: string;
  state: 'pending' | 'confirmed' | 'expired';
  /** Confirmed net buyer debit, including fees within that charge; not the authorization maximum.
   * @pattern ^[0-9]+$
   */
  actual?: string;
  transaction?: string;
  block?: string;
  /** The quote's ticket for upto, which reconciliation looks for in Settled events; the settled ticket once confirmed. */
  ticketHash?: string;
}

/** Run artifact, including partial progress. Export checks enforce mode, review and payment consistency. */
export interface RunReport {
  presentationNotes?: string[];
  version: 1;
  id: string;
  example: ExampleId;
  title: string;
  command: string;
  /** mainnet: paid per request over x402; test: a Test API key on Avalanche Fuji; fixture: offline. */
  mode: 'mainnet' | 'test' | 'fixture';
  startedAt: string;
  finishedAt?: string;
  /** Execution outcome; source coverage and settlement have separate fields. */
  status: 'running' | 'succeeded' | 'partial' | 'failed';
  error?: string;
  softwareCommit: string;
  gateway: string;
  network: string;
  model: string;
  /** Shared invocation cap in USDC base units; zero for an offline fixture.
   * @pattern ^[0-9]+$
   */
  budgetUnits: string;
  /** Identifies whether the cap covers one example or the entire invocation. */
  budgetScope: string;
  plannedAgents: number;
  agents: Agent[];
  calls: CallEvidence[];
  sources: Source[];
  payments: Authorization[];
  result?: AgentOutput;
  evidenceReview?: { findings: Finding[]; checkedAt: string };
  /** Original parsed draft before unsupported sections were replaced. */
  masterDraft?: AgentOutput;
}

/** A gateway's error answer as it sent it: untrusted text, bounded and stripped of control characters. */
export interface GatewayRefusal {
  status: number;
  code?: string;
  param?: string;
  message?: string;
}
/** A stable machine error code with an intentionally safe message for CLI and report output; gateway is the refusal it reports, if any. */
export class DemoError extends Error {
  /** Messages must not contain wallet keys, signatures, private source text or transport dumps. */
  constructor(public code: string, message = code, public gateway?: GatewayRefusal) { super(message); this.name = 'DemoError'; }
}

/** Collapse unknown exceptions to a stable code without disclosing their potentially sensitive messages. */
export function errorCode(error: unknown): string {
  if (error instanceof DemoError) return error.code;
  if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
  return 'request_failed';
}
