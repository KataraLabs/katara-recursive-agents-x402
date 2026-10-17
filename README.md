# Recursive agents with Katara Cortex and x402

Give the master agent a public research command. It assigns specialists, each
specialist spawns researchers, and their findings return to the master. The master
checks their source support and writes a readable answer. Every report opens with
that synopsis, followed by expandable evidence, agent work, and payment records.

The agents call **Katara Cortex** (`katara/cortex@1`) and pay for each call with
**x402** from a wallet you create here: test USDC on Avalanche Fuji while you try
it, native USDC on Avalanche C-Chain when you run it for real. There is no account,
API key, local gateway or blockchain node to set up.

| Example | Specialists | Researchers | Spawned | Total agents |
| --- | ---: | ---: | ---: | ---: |
| [Public repository explainer](examples/repository/index.html) | 4 | 8 | 12 | 13 |
| [Documentation audit](examples/documentation/index.html) | 3 | 6 | 9 | 10 |
| [SQL service comparison](examples/comparison/index.html) | 3 | 9 | 12 | 13 |
| [Boston day trip](examples/trip/index.html) | 4 | 8 | 12 | 13 |
| [AVAX activity briefing](examples/cryptocurrency/index.html) | 3 | 6 | 9 | 10 |

The master is included in each total. All five examples execute 59 agents. Their
fixture runs exercise 91 completion calls, including master evidence reviews.
Live review batches and schema repairs can add calls. Agents are recursive tasks
in one TypeScript process with distinct source permissions and outputs. Katara
Cortex assigns their work within each scenario's fixed tree.

## Quick start

Use Node.js 22.14 or later.

```sh
npm ci
npm run demo -- run all --offline
```

The offline run uses synthetic sources and findings, needs no wallet, and makes no
network requests or payments. The checked-in [sample results](evidence/results.html)
show what a report looks like.

## Run on Test

Test is Katara's network for trying things out. It pays in test USDC on Avalanche
Fuji, which has no value.

```sh
npm run wallet
npm run faucet
npm run demo -- doctor
npm run demo -- run cryptocurrency --budget 1.25
```

1. `npm run wallet` creates a wallet in an ignored `.env`, set to Test, and prints
   its address. It never overwrites an existing `.env`.
2. `npm run faucet` claims 5 test USDC for the wallet (once a day) and approves
   Permit2 so payments can use `upto`. Both are Fuji transactions that need a
   little Fuji AVAX for gas. If the wallet has none, the command prints the address
   and where to get some, and sends nothing.
3. `npm run demo -- doctor` checks the gateway, the chain, the token and Katara's
   settlement contract, and shows the wallet's balance. It makes no payment.
4. `run` executes an example and prints the path of its HTML report. Five test USDC
   covers about twelve examples, since one costs about 0.40 test USDC (some 16 calls at
   the 0.025 minimum); the faucet pays out again the next day.

Test proves the wallet, the payments, the ledger and reconciliation end to end. It
does not prove answer quality. When no Test provider is free, Katara answers with a
simulated reply that runs no model but is still quoted, paid and settled. The agent
that asked then uses the example's built-in fixture output, and the report says how
many calls were simulated. Live answers always come from a model; a simulated reply
there is refused.

## Run on Live

Live pays in native USDC on Avalanche C-Chain. Set `KATARA_MODE=live` in `.env`,
send USDC on Avalanche C-Chain to the wallet address, and set `AVALANCHE_RPC_URL` to
your own HTTPS C-Chain RPC endpoint: Avalanche's public endpoint rate limits busy
addresses, and a run reads the chain often. Avalanche lists RPC providers on its
[integrations page](https://build.avax.network/integrations). Then run:

```sh
npm run demo -- doctor
npm run demo -- run all --budget 3.50
```

Check the token against the contract listed by
[Circle](https://developers.circle.com/stablecoins/usdc-contract-addresses) before
sending. The wallet needs no AVAX: Katara submits the settlement transactions, and
on Live it can also pay for the wallet's Permit2 approval as part of the first
`upto` payment.

Expect some Live examples to finish `partial`, and the command to exit with
`run_partial`. That is the evidence review doing its job, not a failure; see
[Partial answers](#partial-answers).

## How payment works

Every completion call is its own x402 payment. Katara answers the unpaid request
with a quote that offers two ways to pay the same maximum, and the client signs one
locally:

- `upto`, a Permit2 transfer of at most the quoted amount, from which Katara
  collects only the call's charge. The client uses it when the wallet has approved
  Permit2, or when Katara offers to sponsor that approval.
- `exact`, an EIP-3009 transfer of the quoted amount, from which the settlement
  contract refunds the difference in the same transaction. The client uses it
  otherwise, and when Katara answers an `upto` payment with
  `412 permit2_allowance_required`.

The client fixes the gateway, chain, token and settlement contract for each network;
you do not enter addresses. Katara publishes them on its
[Networks page](https://docs.katara.com/about/networks/), and `doctor` checks them
against the gateway and the chain.

| | Test (`KATARA_MODE=test`) | Live (default) |
| --- | --- | --- |
| Gateway | `https://api.katara.com/test` | `https://api.katara.com` |
| Chain | Avalanche Fuji, `eip155:43113` | Avalanche C-Chain, `eip155:43114` |
| Token | test USDC `0xFED854555Faeeca02aCdB3fed90b0CD4048d3F45` | USDC `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` |
| Settlement contract | `0xCA03Fe30B1c3cEA94530Ca95f21d8a487dB065c7` | `0x7f8D1049519Ddcb1Cb041Fb1b0dF7A125e96ACF3` |

Addresses are per chain. On Avalanche C-Chain, `0x7f8D1049519Ddcb1Cb041Fb1b0dF7A125e96ACF3` is the Live settlement contract; on Fuji the same address belonged to the Test settlement contract until October 2026. The client checks each network's chain ID, so an address is only ever used on its own chain.

### Budget

**Every paid run requires an explicit `--budget`.** Katara charges at least 0.025
USDC per call on both networks. The budget caps the whole invocation, including
planning, reviews, synthesis and repairs, and counts each signed maximum until the
chain shows the actual charge. A payment whose outcome is unknown, such as a Katara
Cortex fallback to another provider, still uses budget until it settles or expires.

| Example | Fixture calls | Minimum at 0.025 USDC | Suggested `--budget` |
| --- | ---: | ---: | ---: |
| repository | 20 | 0.50 | 0.75 |
| documentation | 16 | 0.40 | 0.75 |
| comparison | 19 | 0.475 | 0.75 |
| trip | 20 | 0.50 | 0.75 |
| cryptocurrency | 16 | 0.40 | 0.75 |
| all five | 91 | 2.275 | 3.50 |

Katara lets one address hold ten unpaid quotes and ask for thirty a minute. The
client spaces its quote requests to stay under that, and if Katara still answers
`429 quote_rate_limited` it waits as long as `Retry-After` says and asks again,
without signing anything; the call record notes the wait. A run that keeps hitting
the limit stops with `quote_rate_limited`. When Katara refuses a call, the CLI and
the report show its error code, parameter and message.

The client reads the chain through Avalanche's public RPC by default, which limits
how often one address may ask. It retries an RPC answer of 429 or 5xx a few times
with growing waits and reuses balance and block reads for a few seconds. If the
public endpoint still refuses, the command stops with `rpc_http_429` (or the status
it got). Set `AVALANCHE_RPC_URL` in `.env` to your own HTTPS RPC endpoint for the
network's chain, from any of the providers on Avalanche's
[integrations page](https://build.avax.network/integrations), and run again.

A Katara Community model on modest hardware can take minutes to answer a long
prompt. The client waits up to 240 seconds for each call, longer than Katara itself
waits for a provider to start answering a pay-per-call request, and within the 300
seconds a payment authorization stays valid. Set `KATARA_DEMO_REQUEST_SECONDS`
(30 to 300) to change it. Each example also stops after
`KATARA_DEMO_DEADLINE_SECONDS`, 300 by default and at most 1800; raise that for a
slow model too.

When the wallet has not approved Permit2 on Live, Katara can pay for the approval as
part of an `upto` payment. Only one such payment is in flight per wallet at a time;
the calls around it pay with `exact` until it settles or expires.

Live reviews and schema repairs add calls beyond the fixture count. Hold at least
the budget in the wallet: the client refuses to sign when the balance does not cover
every pending maximum. Run `npm run demo -- reconcile` to record settled charges,
and `npm run demo -- inspect` to list the last run's reports. Only inference is
paid; public source endpoints that demand payment are marked unavailable.

## Read the answer and evidence

Open the HTML path printed by the CLI. A matching JSON record is saved under
`.katara/runs/`. The synopsis includes scenario-specific sections and explicit
evidence gaps. The evidence section contains child findings, source review
verdicts and reasons, source hashes, the original master draft, model metadata,
and confirmed Avalanche transaction links.

Finding reviews use the cited source text. Only supported findings enter the
master prompt. A second review checks the master draft; unsupported sections are
replaced with supported findings or a missing-evidence statement. Unknown citations
and fabricated source ranges are rejected. Source review can still miss factual
errors; inspect the evidence before acting on a generated answer.

### Partial answers

A report's status is `partial` when the answer is incomplete on purpose, because
the client kept out what it could not support:

- the second review marked a section of the master's draft unsupported or
  uncertain, and the answer replaced it with a missing-evidence statement;
- a public source could not be retrieved; or
- an agent failed, for example after a refused call or an answer cut off twice at
  its output limit, and its siblings' findings were kept.

The answer itself opens with "Partial answer" whenever its coverage is partial,
which includes a master that reports gaps in its own coverage; such a run can still
have the status `succeeded`. The "What remains unverified" section lists the gaps.
Under "Research evidence, agent work, and payments", "Original master draft and
section review" gives each section's verdict and reason, and the agent tree shows
any agent that failed and why. Every call in a partial run was paid for like any
other, and the budget and payment evidence count them. With `run all`, the command
exits 1 with `run_partial` when any example is partial; the JSON result still lists
every report.

Payment acceptance over HTTP is separate from settlement. The ledger reserves
signed maxima until matching finalized chain events establish the charge or an
authorization expires unused. Preserve `.katara` while payments are pending and
use the wallet from one checkout at a time. Ledgers are scoped to the chain,
asset, settlement contract, and buyer.

To export a completed run to the local `evidence/` folder:

```sh
npm run evidence -- <run-id>
```

To revise only the master answer, retain the ignored local source snapshots,
export the original run, and use:

```sh
npm run synopsis -- <run-id> all --budget 1.00 --total-cap 8.00
npm run demo -- reconcile
npm run synopsis:export -- <revision-id>
```

This pays for source reviews and synthesis of the recorded research, at least
three calls per example; it does not refresh sources. The revision budget covers that invocation. `--total-cap` also
limits cumulative exposure in this wallet's current ledger. Revisions require
matching source snapshot hashes and keep the original run JSON unchanged. An
unreviewed draft cannot be promoted to the final answer during export.

Only public inputs belong in demo commands. Exported reports include commands and
structured findings, but omit private keys, payment signatures, full model
conversations, and full source text. Source excerpts are capped at 25 words.
Bounded source views and revision drafts remain in ignored local storage to make
later review possible; do not publish `.katara` or `.env`.

## Agent onboarding

Start with [AGENTS.md](AGENTS.md) or its identical [CLAUDE.md](CLAUDE.md) mirror.
The [contributor guide](docs/contributing.html) maps the code and explains how to
modify examples. The [JSDoc reference](docs/api.html), [LLM index](llms.txt), and
[full-text guide](llms-full.txt) describe the runtime and data contracts.

Every CLI command accepts `--json` for one versioned response, including failures
and partial results. Use `npm run --silent demo -- plan all --json` to keep npm
banners out of stdout. JSON output changes formatting; live `run` still spends
USDC unless `--offline` is supplied. Versioned [JSON Schemas](schemas/v1/) cover
scenarios, run reports, synopsis revisions and CLI responses.

`npm run docs` regenerates the guides, API reference, schemas, LLM indexes and
the instruction mirror. `npm run generated:check` refuses stale artifacts without
rewriting them. These checks also run through `npm run check`.

## Maintenance

The [guide](docs/index.html) explains the agent tree; the
[payment reference](docs/payments.html) covers configuration and recovery.
`npm run check` runs type checks, offline tests and generated-file checks;
`npm run docs` regenerates the guides; `npm run audit` checks the dependency tree.

[Dependabot](.github/dependabot.yml) checks npm dependencies weekly and groups
security updates separately. Review its PRs with `npm ci`, `npm run check`,
`npm run build`, and `npm run audit` before merging. Updates are not auto-merged.

## License

The code is licensed under [MIT](LICENSE). Linked source material and excerpts
retain their original owners and terms.
