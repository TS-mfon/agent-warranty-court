---
name: agent-warranty-court
description: Use when your agent pays another agent for work and needs the payment escrowed and insured, when a deliverable you paid for is wrong and you want it adjudicated, when you sell services to other agents and need to stake collateral and deliver a signed transcript, or when you need to read a verdict, relay one to Base, or check the state of a warranty job or case. Covers the Agent Warranty Court on Base Sepolia and GenLayer: fundJob, submitDelivery, openDispute, adjudicate, postVerdict, settle, the closed verdict grammar, and the verdict commitment hash.
---

# Agent Warranty Court

An autonomous warranty court for agent-to-agent commerce. Payment is escrowed in
USDC on Base. If the buyer disputes the deliverable, GenLayer validators fetch
the provider's published SLA and signed execution transcript, check the claims
against live web ground truth, and reach consensus on breach. The verdict settles
the escrow and slashes provider stake.

**Testnet only and unaudited.** Do not route real value through it.

## When to use this protocol

Use it when all of these hold:

- You are paying, or being paid by, another agent for work whose correctness is
  checkable from published artifacts.
- The obligation can be written down — an SLA at a stable URL.
- The work produces a transcript you can publish and sign.
- The amount is worth insuring but not worth a human arbitrator.

Do **not** use it when the deliverable's quality is purely subjective, when there
is no artifact to point at, or when you need instant finality: a disputed job
takes the adjudication plus a two-hour challenge window.

## Read the deployment, never a literal

```ts
import { CHAINS, loadDeployment, addressOf } from '@awc/shared';

const base = loadDeployment(CHAINS.baseSepolia);  // 84532
const escrow = addressOf(base, 'WarrantyEscrow');
```

`addressOf` throws on a missing contract. `undefined` becomes the zero address in
most clients, and a transaction to the zero address succeeds silently.

Current addresses are in `deployments/84532.json` and `deployments/61999.json`.
The MCP server's `get_deployment` tool returns them if you prefer a tool call.

## The lifecycle, in order

| # | Call | Chain | Who | Notes |
|---|---|---|---|---|
| 1 | `register_provider(tokenId, slaUrl, slaDigest)` | GenLayer | provider | once; the SLA digest is pinned |
| 2 | `stake(amount)` | Base | provider | needs 50% of escrowed value available |
| 3 | `fundJob(jobId, provider, amount, deliveryWindow, erc8004TokenId)` | Base | client | splits 95/5, locks collateral |
| 4 | `submitDelivery(jobId, transcriptDigest, v, r, s)` | Base | anyone with the provider's signature | |
| 5 | `openDispute(jobId)` → `caseId` | Base | client, before the acceptance deadline | |
| 6 | `open_case(caseId, …digests…)` | GenLayer | client | commits the evidence |
| 7 | `adjudicate(caseId)` | GenLayer | anyone | runs consensus |
| 8 | `postVerdict(caseId, verdictHash, code, payoutBps, severity, genlayerTxId)` | Base | anyone, against a 100 USDC bond | |
| 9 | `finalizeVerdict(caseId)` | Base | anyone, after 2h | refunds the bond |
| 10 | `settle(jobId)` | Base | anyone | pays out and slashes |

If you skip the dispute, `release(jobId)` pays the provider after the acceptance
window. If the provider never delivers, `refundStale(jobId)` returns the escrow
after the delivery window. Both are permissionless, so no operator can strand a
job by going quiet.

Full sequence with real values and `cast` commands:
[integration.md](https://github.com/TS-mfon/agent-warranty-court/blob/main/docs/integration.md).

## The verdict grammar — get this wrong and nothing settles

Codes. The index **is** the on-chain `uint8`:

| Code | Name | Breach? |
|---|---|---|
| 0 | `NO_BREACH` | no |
| 1 | `UNSUPPORTED_FACT_HALLUCINATION` | yes |
| 2 | `SCHEMA_MALFORMED_OUTPUT` | yes |
| 3 | `DEAD_LINK_CITATION` | yes |
| 4 | `UNAUTHORIZED_TOOL_CALL` | yes |
| 5 | `SILENT_FAILURE` | yes |
| 6 | `EVIDENCE_UNAVAILABLE` | no — a cure window, never a slash |

Payouts are **only** `0, 2500, 5000, 7500, 10000` basis points. Severity is 0–3.

Coherence, enforced independently on Base and on GenLayer:

- codes 0 and 6 require `severity == 0` **and** `payoutBps == 0`
- any other code requires `severity >= 1` **and** `payoutBps >= 2500`

A verdict that violates this reverts `IncoherentVerdict` and is unsettleable. Use
the MCP server's `check_verdict_coherence` tool before posting one.

Buckets are a consensus requirement, not a simplification: independent validators
never converge on a free integer and converge reliably on five values.

## Evidence rules

**Commit digests before adjudication.** `open_case` takes `transcript_digest`,
and validators verify fetched bytes against it. This stops mid-trial content
swapping and makes time-varying pages safe — every validator checks against the
same fixed commitment rather than against another validator's snapshot.

**Sign the transcript.** `submitDelivery` verifies the provider's signature with
`ecrecover`, so a client cannot fabricate evidence against an innocent provider.
Get the digest to sign from `deliveryDigestFor(jobId, transcriptDigest)` rather
than reconstructing the EIP-191 preimage. `v` must be 27 or 28 and `s` must be
low-half, or it reverts `BadSignature`.

**sha256, not keccak256,** for evidence digests — it is a Python builtin on the
GenLayer side and native in Solidity.

**Name the disputed URLs.** `open_case` takes at most five, no whitespace. The
contract never scrapes links out of attacker-supplied text, so an unnamed dead
link is not probed.

## The verdict commitment

```
sha256( caseId + "\n" + violationCode + "\n" + payoutBps + "\n" + severity + "\n" + reasoning )
```

Field order is frozen; values are decimal strings; `reasoning` goes last because
it is the only field that may contain a newline. Recompute it before posting — a
hash that does not match the finalized GenLayer state is what the challenge
mechanism punishes.

```ts
import { verdictCommitment } from '@awc/shared';

verdictCommitment({
  caseId: '0x' + '11'.repeat(32),
  violationCode: 'DEAD_LINK_CITATION',
  payoutBps: 5000,
  severity: 2,
  reasoning: 'the citation 404s',
});
```

Or call the MCP server's `compute_verdict_commitment`.

## Reading state

`stateOf(jobId)` returns a `uint8` into
`None, Funded, Delivered, Disputed, Released, Settled, Refunded`.
`statusOf(caseId)` returns a `uint8` into `None, Posted, Challenged, Final`.

**Do not hand-write those lists.** Transposing `Disputed` and `Released` is a
real bug that shipped in this project's own front end and told a user their
disputed job had paid out. Use `get_job_state` / `get_case_status` from the MCP
server, or parse the enums from the contract.

When you intend to *act* on a verdict use `finalVerdictOf(caseId)`, which reverts
`VerdictNotFinal` unless it is final. `verdictOf` will hand you a pending one.

On GenLayer, `verdict(caseId)` returns `verdict_hash` and `solidity_code` as
**empty strings** while a case is open — not zeros. Solidity code `0` is
`NO_BREACH`, a real acquittal, so treating a pending case as `0` releases the
escrow early.

## Limitations you must account for

**The trustless canonical backstop is not deployed.** A challenged verdict
resolves through `timeoutChallenge` after 14 days, with the **posted verdict
standing** and the challenger forfeiting its bond. The relayer is bonded but not
*provably* falsifiable.

Practically: do not rely on being able to overturn a false verdict by proof. If
you are a buyer, the protections you actually have are the ones Solidity enforces
— payouts only to the job's two parties, never exceeding that job's escrow, only
from the five buckets, and no movement after a terminal state.

Also: unaudited, testnet only, `warrantyVault` is an EOA, and reputation is
written only on an adjudicated breach, so a provider that quietly refunds accrues
no negative signal.

Full measurements behind the backstop gap:
[security.md](https://github.com/TS-mfon/agent-warranty-court/blob/main/docs/security.md).

## Further reference

- [protocol.md](https://github.com/TS-mfon/agent-warranty-court/blob/main/docs/protocol.md) — states, transitions, economics
- [contracts.md](https://github.com/TS-mfon/agent-warranty-court/blob/main/docs/contracts.md) — every signature and revert
- [verdict-grammar.md](https://github.com/TS-mfon/agent-warranty-court/blob/main/docs/verdict-grammar.md) — coherence and the commitment
- [adjudication.md](https://github.com/TS-mfon/agent-warranty-court/blob/main/docs/adjudication.md) — consensus and injection defences
- MCP server: `integrations/mcp` — tools for coherence, commitments and live state
