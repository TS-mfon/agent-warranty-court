# Contract reference

Five contracts on Base Sepolia. Addresses in
[`../deployments/84532.json`](../deployments/84532.json).

Conventions used below: amounts are USDC base units (6 decimals); times are Unix
seconds in `uint64`; `bps` is basis points out of 10000. Reverts are listed by
custom-error name — all of these are custom errors, so decode them from the
revert data rather than expecting a string.

---

## WarrantyEscrow

Holds the money and the state machine. Every function is `nonReentrant` except
the views.

### `fundJob(bytes32 jobId, address provider, uint256 amount, uint64 deliveryWindow, uint256 erc8004TokenId)`

Caller becomes the job's client. Pulls `amount` USDC from the caller, pays
`premium` to `warrantyVault`, escrows the remainder, and locks the provider's
collateral in the same transaction — so a job cannot exist unwarranted.

Requires an ERC-20 approval of at least `amount` to the escrow, and the provider
must already have `required` available stake.

Reverts: `JobExists`, `ZeroAddress` (provider), `ZeroAmount`,
`DeliveryWindowTooShort`, and `InsufficientAvailableStake` from the stake vault.

Emits `JobFunded(bytes32 indexed jobId, address indexed client, address indexed provider, uint256 escrowed, …)`.

### `submitDelivery(bytes32 jobId, bytes32 transcriptDigest, uint8 v, bytes32 r, bytes32 s)`

Records the transcript digest with the provider's signature over it. The caller
need not be the provider — the signature is the authorisation — which lets a
relayer submit on the provider's behalf.

The signed digest is EIP-191 over an inner struct hash. Use
`deliveryDigestFor(jobId, transcriptDigest)` to obtain exactly what must be
signed rather than reconstructing it.

Signature rules, both enforced: `v` must be 27 or 28, and `s` must be in the
lower half of the curve order. ECDSA admits a second valid signature for every
message; accepting both would let one delivery be presented twice under
different bytes.

Reverts: `WrongState(actual, expected)`, `DeliveryWindowPassed`, `BadSignature`.

Emits `DeliverySubmitted(bytes32 indexed jobId, bytes32 transcriptDigest, uint64 acceptanceDeadline)`.

### `openDispute(bytes32 jobId) returns (bytes32 caseId)`

Client only. Opens a case, freezes the provider's stake, and returns the case id
to use on GenLayer and in `VerdictInbox`.

Callable from `Delivered` before `acceptanceDeadline`, or from `Disputed` when a
cure window is open (a re-dispute after unreadable evidence).

Reverts: `NotClient`, `DisputeLimitReached` (`MAX_DISPUTES` is 2),
`AcceptanceWindowClosed(closedAt)`, `WrongState`.

Emits `DisputeOpened(bytes32 indexed jobId, bytes32 indexed caseId, uint8 disputeIndex)`.

### `release(bytes32 jobId)`

Permissionless. After `acceptanceDeadline` with no dispute, pays the escrow to
the provider and unlocks collateral.

Reverts: `WrongState`, `AcceptanceWindowOpen(closesAt)`.

Emits `JobReleased(bytes32 indexed jobId, address indexed provider, uint256 amount)`.

### `refundStale(bytes32 jobId)`

Permissionless. After `deliveryDeadline` with no delivery, returns the escrow to
the client and unlocks collateral.

Reverts: `WrongState`, `DeliveryDeadlineNotPassed(deadline)`.

Emits `JobRefunded(bytes32 indexed jobId, address indexed client, uint256 amount)`.

### `settle(bytes32 jobId)`

Permissionless. Reads the final verdict from `VerdictInbox` and applies it: pays
the bucketed share to the client, the remainder to the provider, slashes
collateral per severity, and writes to `ReputationLog`.

On verdict code 6 (`EVIDENCE_UNAVAILABLE`) it does not settle — it opens a cure
window and leaves the job `Disputed`.

Reverts: `WrongState`, `VerdictNotFinal(status)` from the inbox,
`InsufficientPayoutBucket(payoutBps)`.

Emits `JobSettled(bytes32 indexed jobId, bytes32 indexed caseId, uint8 code, uint16 payoutBps, …)`, or `CureWindowOpened(bytes32 indexed jobId, uint64 cureDeadline)`.

### `settleAfterCure(bytes32 jobId)`

Permissionless. After `cureDeadline`, releases to the provider. No slash: an
unreachable evidence host is never a finding of fault.

Reverts: `NoCureWindow`, `CureWindowOpen(closesAt)`, `WrongState`.

### Views

| Function | Returns |
|---|---|
| `jobOf(bytes32 jobId)` | the full `Job` struct |
| `stateOf(bytes32 jobId)` | `State` — see [protocol.md](protocol.md#states) |
| `caseIdFor(bytes32 jobId, uint8 disputeIndex)` | the deterministic case id; `pure` |
| `deliveryDigestFor(bytes32 jobId, bytes32 transcriptDigest)` | the exact digest a provider signs |

`Job` fields: `client`, `provider`, `escrowed`, `stakeLocked`, `erc8004TokenId`,
`transcriptDigest`, `deliveryDeadline`, `acceptanceDeadline`, `cureDeadline`,
`disputesUsed`, `state`.

### Constants

`MAX_DISPUTES` = 2. `DELIVERY_TYPEHASH` is public; prefer `deliveryDigestFor`.

---

## ProviderStake

Provider collateral. The escrow-only surface (`lock`, `unlock`, `slash`,
`disputeOpened`, `disputeClosed`) reverts `NotEscrow` for anyone else; it is
listed here only so integrators know it exists and is closed.

### `stake(uint256 amount)`

Pulls USDC from the caller and credits it. Requires an approval.

Reverts: `ZeroAmount`. Emits `Staked(address indexed provider, uint256 amount, uint256 total)`.

### `requestUnbond(uint256 amount)`

Starts the withdrawal clock. One request at a time — a second would silently
overwrite the first's clock.

Reverts: `ZeroAmount`, `DisputeOpen`, `UnbondingAlreadyPending`,
`InsufficientAvailableStake(requested, available)`.

Emits `UnbondRequested(address indexed provider, uint256 amount, uint64 readyAt)`.

### `cancelUnbond()`

Returns a pending request to active duty immediately.

Reverts: `NoUnbondingRequest`. Emits `UnbondCancelled`.

### `withdraw()`

Pays out a matured request. Checks for an open dispute *again* here, because
`requestUnbond` only proved none was open when the clock started.

Reverts: `NoUnbondingRequest`, `UnbondingNotReady(readyAt)`, `DisputeOpen`.

Emits `Withdrawn(address indexed provider, uint256 amount)`.

### Views

| Function | Returns |
|---|---|
| `availableStake(address provider)` | total minus locked minus pending unbond |
| `totalStaked(address)` | public mapping |
| `locked(address)` | public mapping |
| `openDisputes(address)` | public mapping; non-zero freezes withdrawal |
| `unbonding(address)` | public mapping of `{amount, readyAt}` |
| `unbondingDelay()` | immutable, at least `MIN_UNBONDING_DELAY` (21 days) |

---

## VerdictInbox

The bonded optimistic relay endpoint. `Status` is `None, Posted, Challenged, Final`.

### `postVerdict(bytes32 caseId, bytes32 verdictHash, uint8 code, uint16 payoutBps, uint8 severity, bytes32 genlayerTxId)`

Any address may post, against a USDC bond of `relayerBond` (100 USDC on the live
deployment) pulled from the caller. The verdict must be coherent per
[verdict-grammar.md](verdict-grammar.md) — Base re-derives the rules rather than
trusting the poster.

`genlayerTxId` is recorded so a challenger can verify independently that the
posted values match the finalized GenLayer state.

Reverts: `CaseAlreadyPosted`, `EmptyVerdictHash`, `EmptyGenlayerTxId`,
`IncoherentVerdict(code, payoutBps, severity)`.

Emits `VerdictPosted(bytes32 indexed caseId, address indexed relayer, bytes32 verdictHash, uint8 code, …)`.

### `challenge(bytes32 caseId)`

Any address, within `challengeWindow`, against a bond of `challengeBond`.

Reverts: `NotChallengeable(status)`, `ChallengeWindowClosed`.

Emits `VerdictChallenged(bytes32 indexed caseId, address indexed challenger)`.

### `finalizeVerdict(bytes32 caseId)`

Permissionless. After `challengeWindow` with no challenge, marks the verdict
`Final` and refunds the relayer's bond.

Reverts: `NotChallengeable(status)`, `ChallengeWindowOpen(closesAt)`.

Emits `VerdictFinalized(bytes32 indexed caseId, uint8 code, uint16 payoutBps, uint8 severity, bool overturned)`.

### `timeoutChallenge(bytes32 caseId)`

Permissionless. After `canonicalTimeout` with no canonical resolution, the posted
verdict stands, the relayer takes both bonds, and the challenger forfeits.

**On the live deployment this is how every challenge resolves**, because the
canonical path is not deployed. See [security.md](security.md#the-canonical-backstop-is-not-active).

Reverts: `NotChallenged(status)`, `CanonicalStillPending(timesOutAt)`.

Emits `ChallengeTimedOut(bytes32 indexed caseId, address indexed challenger, address indexed relayer)`.

### `resolveChallenge(bytes32 caseId, bytes32 verdictHash, uint8 code, uint16 payoutBps, uint8 severity)`

Callable only by the configured `CanonicalVerdictReceiver` (`NotCanonicalReceiver`
otherwise). Replaces the posted values with the canonical ones, marks
`overturned` when they differ, and pays both bonds to whichever side was right.

Not reachable on the live deployment.

Reverts: `NotCanonicalReceiver`, `NotChallenged(status)`, `IncoherentVerdict`.

### Views

| Function | Returns |
|---|---|
| `verdictOf(bytes32 caseId)` | the full `Verdict` struct |
| `statusOf(bytes32 caseId)` | `Status` |
| `finalVerdictOf(bytes32 caseId)` | the verdict, reverting `VerdictNotFinal(status)` unless final |

Use `finalVerdictOf` when you intend to act on a verdict: it refuses to return
one that is not yet final, where `verdictOf` would hand you a pending one.

---

## CanonicalVerdictReceiver

### `deliverVerdict(bytes32 caseId, bytes32 verdictHash, uint8 code, uint16 payoutBps, uint8 severity)`

Receives an L1→L2 message and forwards it to `VerdictInbox.resolveChallenge`.

Two independent authentication checks, and both are necessary. `msg.sender` must
be the `L2CrossDomainMessenger` (`NotMessenger(caller)`) — without it, any direct
caller controls `msg.sender` and could forge a verdict. And
`messenger.xDomainMessageSender()` must be the configured L1 forwarder
(`NotL1Forwarder(xDomainSender)`) — without it, any L1 address could send through
the messenger.

Emits `CanonicalVerdictDelivered(bytes32 indexed caseId, uint8 code, uint16 payoutBps, uint8 severity)`.

---

## ReputationLog

### `recordBreach(...)`

Escrow-only (`NotEscrow`). Called from `settle` on a breach verdict.

Emits `BreachRecorded(address indexed provider, address indexed client, bytes32 indexed caseId, uint256 erc8004TokenId, …)`.

A stand-in for the ERC-8004 Reputation Registry, emitting the same schema so the
records can be migrated once that registry's Base address is confirmed.

---

## One-shot setters

`ProviderStake.setEscrow`, `ReputationLog.setEscrow` and
`VerdictInbox.setCanonicalReceiver` can each be called exactly once
(`EscrowAlreadySet` / `ReceiverAlreadySet`). They are wired at deployment and
asserted immediately afterwards, because a mistake is not repairable on the same
deployment.
