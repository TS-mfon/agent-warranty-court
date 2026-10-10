# Verdict grammar

A verdict is three numbers and a hash. The numbers come from closed sets, and
every component that touches a verdict re-derives the rules rather than trusting
its neighbour.

## Violation codes

The index *is* the on-chain `uint8`. Source of truth:
[`../contracts/shared/VerdictLib.sol`](../contracts/shared/VerdictLib.sol).

| Code | Name | Breach? |
|---|---|---|
| 0 | `NO_BREACH` | no |
| 1 | `UNSUPPORTED_FACT_HALLUCINATION` | yes |
| 2 | `SCHEMA_MALFORMED_OUTPUT` | yes |
| 3 | `DEAD_LINK_CITATION` | yes |
| 4 | `UNAUTHORIZED_TOOL_CALL` | yes |
| 5 | `SILENT_FAILURE` | yes |
| 6 | `EVIDENCE_UNAVAILABLE` | no |

Code 6 is not a violation on GenLayer — it is a case *status* there, and is
absent from the Python `VIOLATION_CODES` tuple. The relayer maps that status onto
code 6 so Base can tell an adjudicated acquittal (settle now) from a court that
could not read the evidence (cure window first). Both carry a zero payout, so
without the distinction the cure window could never trigger.

Codes 0 and 6 both return `false` from `isBreach`.

## Payout buckets

`0, 2500, 5000, 7500, 10000` basis points of the escrowed amount, refunded to the
client. Nothing in between is accepted.

This is a consensus requirement, not a simplification. Independent validators are
asked to agree without coordinating; on a free integer they will not — two honest
validators reading the same transcript land on 6340 and 6347 and the case fails
to settle. On a five-value set they converge reliably. Base enforces the same
closed set, so an off-bucket payout is unsettleable even if it somehow cleared
consensus.

## Severity and slashing

Severity is 0–3. `slashBpsFor`: 1 → 1000, 2 → 2500, 3 → 5000, anything else → 0.
Applied to job value, not to stake balance.

## Coherence

`VerdictLib.isCoherent(code, payoutBps, severity)` — all of:

- `code <= 6`
- `severity <= 3`
- `payoutBps` is one of the five buckets
- if `code` is 0 or 6: `severity == 0` **and** `payoutBps == 0`
- otherwise: `severity >= 1` **and** `payoutBps >= 2500`

Individually valid fields can still be incoherent together, and that specific
shape — `NO_BREACH` carrying a full refund — is what a half-successful prompt
injection produces. The check exists for that case.

The TypeScript implementation adds one rule Solidity does not need: every field
must be an integer. `uint8` cannot hold `2.5` or `NaN`, but a JSON number off the
wire can, and a keeper that accepted one would compute a payout Solidity then
rejects.

## The verdict commitment

Base stores a `verdictHash`. A relayer posts it; a challenger recomputes it to
prove the relayer posted something else. If two implementations disagree by one
byte, every posted verdict is overturnable and every relayer bond is forfeit —
so the format is fixed and mechanically compared across languages.

```
sha256( caseId + "\n" + violationCode + "\n" + payoutBps + "\n" + severity + "\n" + reasoning )
```

Field order is frozen. Values are the decimal string forms of the integers.
`reasoning` goes last because it is the only field allowed to contain a newline —
anywhere else it could forge a field boundary.

Newline-joined rather than JSON-encoded: key ordering in a JSON object is a
serializer detail, and a commitment whose bytes depend on a serializer's mood is
not a commitment.

### Worked example

Inputs:

```
caseId         0x1111111111111111111111111111111111111111111111111111111111111111
violationCode  DEAD_LINK_CITATION
payoutBps      5000
severity       2
reasoning      the citation 404s
```

Preimage, exactly (`\n` are real newlines, no trailing newline):

```
0x1111111111111111111111111111111111111111111111111111111111111111
DEAD_LINK_CITATION
5000
2
the citation 404s
```

Reproduce it:

```bash
printf '%s\n%s\n%s\n%s\n%s' \
  "0x$(printf '11%.0s' $(seq 32))" DEAD_LINK_CITATION 5000 2 'the citation 404s' \
  | sha256sum
```

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

The commitment covers the reasoning as well as the numbers, and that is the
point: a relayer that posts the right payout but rewrites *why* is still
overturned. Without the prose in the hash it could launder a fabricated rationale
through an otherwise-correct verdict.

## Why the grammar exists four times

| Copy | Location |
|---|---|
| Solidity | [`../contracts/shared/VerdictLib.sol`](../contracts/shared/VerdictLib.sol) |
| Python | `VIOLATION_CODES` in [`../contracts/genlayer/warranty_court.py`](../contracts/genlayer/warranty_court.py) |
| TypeScript | [`../packages/shared/src/verdict.ts`](../packages/shared/src/verdict.ts) |
| EVM ABI | `VerdictEmitterIface` in the Intelligent Contract |

Four copies of one rule set is a liability. It is deliberate anyway: the relayer
sits between two chains and is the only participant that is merely bonded rather
than trusted, so each hop re-derives the grammar instead of inheriting a
neighbour's verdict. A single shared implementation would mean one bug reaches
every layer at once.

The mitigation is not a comment asking people to remember.
`scripts/check-grammar-parity.mjs` parses the real Solidity and the real Python,
imports the real TypeScript, compares every code, bucket, scalar and slash tier,
and then feeds the comparator six deliberately corrupted copies to prove it can
fail. `scripts/check-commitment-parity.mjs` extracts the actual Python commitment
function with `ast` and matches it against the TypeScript one over six awkward
vectors, including non-ASCII and embedded newlines.
