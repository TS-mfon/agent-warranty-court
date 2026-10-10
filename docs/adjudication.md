# Adjudication

How GenLayer turns evidence into a verdict, and why the result is hard to
manipulate.

Source: [`../contracts/genlayer/warranty_court.py`](../contracts/genlayer/warranty_court.py).

## The methods

| Method | Who | What |
|---|---|---|
| `register_provider(erc8004_token_id, sla_url, sla_digest)` | provider | pins the SLA digest |
| `open_case(case_id, provider, escrow_ref, transcript_uri, transcript_digest, claimed_violation, client_statement, disputed_urls)` | client | commits the evidence |
| `adjudicate(case_id)` | anyone | runs consensus, writes the verdict |
| `authorize_appeal(case_id, reason)` | either party | one-shot, per case |
| `verdict(case_id)` | view | the structured verdict for the relayer |
| `case_status(case_id)`, `case_count()`, `is_registered(provider)` | view | state |

`case_id` must be a `0x`-prefixed 32-byte hex string — Base's `caseId`. It is
checked at `open_case`, not at `adjudicate`, and the reason is cost: by
adjudication time validators have already fetched the evidence and paid for the
model calls, so a malformed id would produce a decided but unbridgeable case.

## Consensus

`adjudicate` runs the non-deterministic work under `gl.vm.run_nondet_unsafe` with
a custom validator — not `strict_eq`, because LLM prose will never match
byte-for-byte, and not bare `prompt_comparative`, because different fields need
different tolerance.

The leader fetches and extracts inside one non-deterministic block and returns
canonical JSON. Each validator independently re-runs the same work and compares
field by field:

| Field | Rule |
|---|---|
| `violation_code` | exact match, from the closed enum |
| `payout_bps` | exact match, buckets only |
| `severity` | ±1 tolerated — **except** that any 0 must be unanimous |
| `reasoning` | stored, excluded from comparison |

Severity tolerates drift because it is a judgement of degree. "No breach" does
not, because a split on whether a breach occurred at all must never resolve into
a slash.

`reasoning` is excluded deliberately: requiring agreement on prose would mean no
case ever settles. It is still covered by the verdict commitment, so it cannot be
rewritten after the fact.

The validator type-checks before touching the payload —
`if not isinstance(leader_result, gl.vm.Return): return False` — because on a
failed leader run the result has no `calldata` attribute. Schema-only checking
would be leader-output-only validation, which proves formatting rather than
correctness.

## Evidence integrity

The defendant supplies the evidence URL. Three mechanisms, all mandatory.

**Hash-commitment at `open_case`.** The client commits `transcript_digest`;
validators verify fetched bytes hash to it. This kills mid-trial content swapping
*and* solves the time-varying-page problem in one move: validators fetching at
different moments still agree, because each checks against a fixed commitment
rather than against another validator's snapshot.

**Signature verification on Base.** The transcript must carry the provider's
signature, checked with `ecrecover` in `submitDelivery` before a dispute can open.
A client cannot forge evidence against an innocent provider. GenLayer therefore
only has to check that fetched bytes match a digest, which is why the Intelligent
Contract does no signature recovery.

**SLA pinned at registration.** `sla_digest` is fixed when the provider
registers, so a provider cannot silently rewrite its obligations after a dispute
is filed.

sha256 throughout, not keccak256: it is in the Python standard library here and a
native builtin in Solidity, so both sides agree without either importing a
hashing library.

## Prompt-injection defences

GenLayer's own guidance lists human-in-the-loop as a core mitigation. This design
rejects that by requirement, so the safety is bought structurally instead.

- Prompts are built in contract code. Fetched evidence is never interpolated into
  the instruction section, only into a fixed, clearly delimited data block.
- The delimiter is per-case, derived from the case id. Every validator computes
  the same fence, but a provider writing a transcript cannot predict it — the
  case id does not exist until the client opens the dispute. That makes
  delimiter-escape impractical.
- Output is constrained to a closed enum plus a bucketed integer. Anything
  off-enum is rejected outright.
- Evidence is truncated deterministically at a fixed character count, so leader
  and validators judge the same document.

**The ceiling on a successful injection.** No recipient is an input or an output
of a verdict — recipients live in Solidity on Base and are constrained to the
job's two parties. So the best a fully successful injection achieves is moving
money between the client and the provider, which are the two addresses Base
already knows. It cannot introduce a third.

## Error tagging

Failures are tagged so the validator can classify agreement, and so evidence
problems never become guilt:

| Tag | Meaning | Agreement rule |
|---|---|---|
| `[EXTERNAL]` | evidence gone or altered; deterministic | messages must match exactly |
| `[EXPECTED]` | malformed model output; deterministic | messages must match exactly |
| `[TRANSIENT]` | network flake | both sides need only agree it was transient |

An `[EXTERNAL]` failure on which validators agree becomes case status
`EVIDENCE_UNAVAILABLE`, violation code `NO_BREACH`, payout 0 — and on Base, a
cure window followed by release to the provider. **Never a slash.**

That asymmetry is load-bearing. If a failed fetch slashed, then taking a
provider's transcript host offline would be an attack on the provider, and taking
it offline yourself would be an attack on the client. Neither is possible when
unreadable evidence resolves to "no breach proven".

`[EXPECTED]` and `[TRANSIENT]` fail the transaction instead, leaving the case
`OPEN` and re-adjudicable under a fresh leader.

## What the relayer reads

`verdict(case_id)` returns a flat string map: `case_id`, `escrow_ref`, `status`,
`violation_code`, `payout_bps`, `severity`, `reasoning`, `verdict_hash`,
`solidity_code`, `appeal_used`, `client`, `provider`.

`verdict_hash` and `solidity_code` are empty strings while a case is open, not
zeros. Solidity code `0` is `NO_BREACH` — a real finding — and a relayer that
read a pending case as an acquittal would release the escrow early.

The map contains no address other than the two parties, which is the property
that makes the injection ceiling above hold end to end.
