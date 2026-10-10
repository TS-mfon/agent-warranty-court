# Threat model

What each participant can and cannot achieve, and the gaps that remain.

## Guarantees Solidity enforces regardless of any verdict

These hold even if GenLayer consensus were entirely subverted, because Base never
takes a verdict's word for them:

- **Recipients are a closed set.** A payout reaches only the job's client or its
  provider. No verdict field names an address, on either chain.
- **Payouts are bounded per case.** A payout cannot exceed what that job
  escrowed, so one verdict cannot reach another job's money.
- **Payouts come from a closed set.** `0, 2500, 5000, 7500, 10000` bps. An
  off-bucket value reverts `IncoherentVerdict`.
- **Coherence is re-derived.** `NO_BREACH` with a payout is rejected at every
  hop, independently.
- **Terminal states are terminal.** No second settlement is reachable.
- **Slashes reach only locked collateral.** Not free stake, not a pending
  unbonding request, not another job's collateral.
- **Solvency is an equality.** The escrow's USDC balance equals the sum of live
  per-job escrow exactly, asserted as a stateful invariant.

## A malicious relayer

**Can:** delay settlement by not posting. Post a verdict GenLayer never reached.

**Cannot:** profit from either. A posted verdict must be coherent, must pay one of
two known addresses, and cannot exceed the job's escrow. The bond is refunded
only on a verdict that stands, and `postVerdict` records the GenLayer transaction
id so anyone can check the claim independently.

**Cannot censor.** `finalizeVerdict`, `release`, `refundStale`, `settle` and
`settleAfterCure` are all permissionless. A relayer going silent delays a
disputed case; it cannot strand an undisputed one.

**Residual risk, and it is real.** On the live deployment a false verdict that is
challenged still *stands* after `canonicalTimeout`, because the canonical path is
not deployed. The relayer is bonded, not provably wrong. See below.

## A malicious client

**Cannot forge evidence.** The transcript must carry the provider's signature,
verified with `ecrecover` on Base before a dispute can open.

**Cannot swap evidence mid-trial.** Digests are committed at `open_case` and
validators verify fetched bytes against them.

**Cannot dispute indefinitely.** `MAX_DISPUTES` is 2.

**Cannot dispute late.** `openDispute` reverts `AcceptanceWindowClosed` after the
acceptance deadline.

**Cannot claim an acquittal as a breach.** `open_case` rejects `NO_BREACH` as a
claimed violation.

## A malicious provider

**Cannot rewrite its obligations.** `sla_digest` is pinned at registration.

**Cannot withdraw collateral mid-dispute.** Checked at `requestUnbond` and again
at `withdraw`, because the first only proves no dispute was open when the clock
started.

**Cannot escape by going dark.** An unreachable evidence host yields
`EVIDENCE_UNAVAILABLE` — a cure window then release, never a slash. That sounds
like it favours the provider, and it does; the alternative is worse. If a failed
fetch slashed, taking a provider's host offline would be an attack on the
provider and taking it offline yourself would be an attack on the client.

**Cannot double-sign a delivery.** High-`s` signatures and `v` outside {27, 28}
are rejected, so one delivery has exactly one valid encoding.

## An injected transcript

Evidence is interpolated only into a fixed, delimited data block, never into the
instruction section. The delimiter is derived per case from the case id, which
does not exist until the client disputes, so a provider cannot write a transcript
that escapes it.

Output is a closed enum plus a bucketed integer. An injected instruction can at
most produce an off-enum output, which fails validation.

**The ceiling:** a fully successful injection moves money between the client and
the provider. It cannot introduce a recipient, because no recipient is an input
or an output of a verdict.

## The canonical backstop is not active

The design calls for a challenged verdict to be settled by proving GenLayer's
finalized state on Ethereum and forwarding it to Base. Both halves are written
and tested. Neither is deployed.

**The forwarder** needs GenLayer's L2→L1 message-inclusion verifier. What was
measured:

- GenLayer settles to Ethereum Sepolia. Its Bridgehub
  (`0xc4fd2580c3487bba18d63f50301020132342fdbd`) has code there and none on
  mainnet. Chain 4221 reports 383,307 batches committed, verified **and
  executed** — the settlement is real, not theoretical.
- Chain 4221's diamond proxy is `0xf8ed76fA41624355F56BC6885e76A208fE039170`,
  with six registered facets.
- Neither `proveL2MessageInclusion` nor `proveL2MessageInclusionShared` is
  registered on it. Both revert `"F"` — and a negative control established that
  `"F"` is the DiamondProxy facet-not-found error, because a function that cannot
  exist reverts identically.
- On the Bridgehub, the shared variant, the legacy variant and a deliberately
  nonexistent function all revert with no reason string, so existence and absence
  are indistinguishable from outside.

Deploying against a guessed verifier would produce a contract that looks live and
verifies nothing, which is worse than not deploying it.

**The emitter** cannot be co-located with its court. Bradbury has a real EVM side
but refuses the court's 21.65M-gas deploy; studionet hosts the court but
implements no ghost contracts and its EVM RPC rejects standard tooling.

**Consequence.** A challenged verdict resolves through `timeoutChallenge` after
14 days: the posted verdict stands and the challenger forfeits its bond. That is
the designed degradation and it is safe in the sense that no unbounded loss is
possible — but the thing that makes a lying relayer *provably* wrong is absent.

**What would fix it.** One fact from GenLayer: the address and exact signature of
the contract serving L2→L1 inclusion proofs for chain 4221. No contract in this
repository needs to change. `CanonicalVerdictReceiver` is already deployed
pointing at a reserved forwarder address (precomputed from the deployer's Sepolia
nonce), because `VerdictInbox.setCanonicalReceiver` is one-shot and that was the
only way to keep the door open.

## Other known gaps

- **Unaudited.** No third party has reviewed these contracts.
- **Testnet only.** Do not put real value through this deployment.
- **`warrantyVault` is an EOA.** The premium accumulates at an address the
  deployer controls; no pooled vault contract exists in this version.
- **Reputation writes only on an adjudicated breach.** A provider that quietly
  refunds to avoid a verdict accrues no negative signal, which is exploitable
  over time.
- **The deployed court is a comment-stripped build**
  (`build/warranty_court.min.py`), proven AST-equivalent to the documented
  source, because the 34 KB documented source estimates at 27.3M gas.
