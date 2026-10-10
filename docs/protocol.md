# Protocol

A buyer agent escrows payment for work. If it disputes the deliverable, GenLayer
validators adjudicate against the provider's published SLA and signed transcript,
and the verdict settles the escrow. Nothing in the release path requires a human.

## The two chains, and why the split

| | Base Sepolia | GenLayer studionet |
|---|---|---|
| Holds | USDC escrow, provider stake | nothing of value |
| Decides | everything arithmetic: recipients, ceilings, timing, buckets | whether a natural-language obligation was breached |
| Why | deterministic, cheap, where the liquidity is | can read an SLA and probe the live web |

Solidity cannot read "responses must cite a verifiable source" and decide whether
a response did, nor fetch a citation and observe a 404. Validators can. Neither
can be replaced by the other, so each does only what it is good at.

## States

`WarrantyEscrow.State`, in declaration order — the index is the on-chain value:

| # | State | Meaning |
|---|---|---|
| 0 | `None` | no such job |
| 1 | `Funded` | escrowed, awaiting delivery |
| 2 | `Delivered` | transcript submitted, acceptance window running |
| 3 | `Disputed` | a case is open; stake frozen |
| 4 | `Released` | paid to the provider — terminal |
| 5 | `Settled` | paid per verdict — terminal |
| 6 | `Refunded` | returned to the client — terminal |

A cure window (unreadable evidence) is not a separate state: the job stays
`Disputed` with `cureDeadline` set, and `settleAfterCure` moves it to `Released`.

Terminal means terminal. Once a job is `Released`, `Settled` or `Refunded`, no
later verdict, cure window or settlement can move it again — which is also what
makes double-settlement unreachable rather than merely guarded.

## Transitions

| From | Call | Who | To |
|---|---|---|---|
| `None` | `fundJob` | client | `Funded` |
| `Funded` | `submitDelivery` | anyone with the provider's signature | `Delivered` |
| `Funded` | `refundStale` | anyone, after `deliveryDeadline` | `Refunded` |
| `Delivered` | `openDispute` | client, before `acceptanceDeadline` | `Disputed` |
| `Delivered` | `release` | anyone, after `acceptanceDeadline` | `Released` |
| `Disputed` | `settle` | anyone, once the verdict is `Final` | `Settled`, or `Disputed` with a cure window |
| `Disputed` + cure | `settleAfterCure` | anyone, after `cureDeadline` | `Released` |
| `Disputed` + cure | `openDispute` | client | `Disputed` (second dispute) |

Three things follow from that table and are worth stating directly.

**Settlement is permissionless.** `release`, `refundStale`, `settle` and
`settleAfterCure` take no privileged caller. No operator can withhold a payout by
going quiet; anyone who wants the job closed can close it.

**Disputes are capped.** `MAX_DISPUTES` is 2. A client cannot re-dispute
indefinitely to keep a provider's stake frozen.

**Every job terminates.** Undelivered work is refundable after the delivery
window. Unreadable evidence releases to the provider after the cure window. There
is no path that holds funds forever.

## Economics

### The funding split

`fundJob(jobId, provider, amount, deliveryWindow, erc8004TokenId)` computes, in
`uint256` with Solidity's truncating division:

```
premium  = amount   * premiumBps       / 10000
escrowed = amount - premium
required = escrowed * requiredStakeBps / 10000
```

On the live deployment `premiumBps` is 500 (5%) and `requiredStakeBps` is 5000
(50%). For a 5 USDC job:

| Quantity | Base units | Meaning |
|---|---|---|
| `amount` | 5000000 | what the client pays |
| `premium` | 250000 | skimmed to `warrantyVault` at funding — this is the insurance |
| `escrowed` | 4750000 | what the escrow holds, and the ceiling on any payout |
| `required` | 2375000 | provider collateral locked in the same transaction |

The premium leaves at funding time, which is why the escrow's USDC balance equals
the sum of live per-job escrow exactly rather than approximately. That equality
is asserted as an invariant, not an inequality.

`required` is a fraction of `escrowed`, not of `amount`. Taking it from the gross
would over-quote a provider's stake requirement and make fundable jobs look
unfundable.

### Slashing

Stake slashed on a breach, as a fraction of job value — `VerdictLib.slashBpsFor`:

| Severity | Slash |
|---|---|
| 1 | 1000 bps (10%) |
| 2 | 2500 bps (25%) |
| 3 | 5000 bps (50%) |
| 0 or other | 0 |

Scaled by job value rather than by stake balance. A percentage of stake would
make one small dispute catastrophic for a large provider and trivial for a small
one, inverting the incentive the stake exists to create.

A slash can only reach collateral locked for *that* job. It cannot touch free
stake, a pending unbonding request, or another job's collateral. The constructor
also rejects a `requiredStakeBps` below `slashBpsFor(3)`, because stake under the
worst-case slash would make the harshest verdict unenforceable.

### Unbonding

`MIN_UNBONDING_DELAY` is 21 days and the constructor enforces it. The delay must
exceed the maximum case duration, or a provider withdraws collateral the moment a
dispute lands. Two separate checks enforce the freeze: `requestUnbond` refuses to
start while a dispute is open, and `withdraw` refuses to complete if one opened
after the clock started. Without the second, a provider could unbond
pre-emptively on day 0 and walk out through a dispute filed on day 1.

## Timing

| Parameter | Live value | What it bounds |
|---|---|---|
| `deliveryWindow` | per job | provider must deliver before this lapses |
| `acceptanceWindow` | 3 days | client's window to dispute a delivery |
| `cureWindow` | 3 days | provider's window after unreadable evidence |
| `challengeWindow` | 2 hours | anyone's window to challenge a posted verdict |
| `canonicalTimeout` | 14 days | then a challenged verdict resolves by timeout |
| `unbondingDelay` | 21 days | provider's stake withdrawal delay |

`challengeWindow` is a free parameter, not a correctness hinge. It covers only
relayer honesty — "does this verdict match the finalized GenLayer state?" — which
is a bounded, independently checkable question. GenLayer's own appeal timing is
deliberately irrelevant to Base: the relayer may only post verdicts already
final on GenLayer, and `postVerdict` records the GenLayer transaction id so the
claim can be verified by anyone.
