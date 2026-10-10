# Defects found and fixed

Each entry names the defect, how it was found, and the regression guard that now
fails without the fix. Ordered by how badly it would have misled a user.

## F1 — The inspector mislabelled disputed and released jobs

**Severity: user-visible, silent.** `web/generated/data.js` carried a
hand-written `JOB_STATES` array in which `Released` and `Disputed` were
transposed, plus a trailing `Curing` state that does not exist in the contract.
`WarrantyEscrow.State` is `None, Funded, Delivered, Disputed, Released, Settled,
Refunded`.

The consequence: the `/inspect` page read `stateOf(jobId)` correctly, then looked
the number up in the wrong table. A job under active dispute displayed as
**"Released"** — that is, a user checking whether their disputed job had paid out
would have been told it had.

**How it was found.** Not by a test. Every test passed, because
`web/test/web.test.ts` asserted the same wrong array — both were written from the
same bad recollection, so the test agreed with the bug. It surfaced only when the
documentation work required transcribing the real enum out of
`contracts/base/WarrantyEscrow.sol`.

**Fix.** `web/build.mjs` now parses both enums from the Solidity at build time,
so the names cannot be typed wrongly. The test compares the generated array
against its own independent parse of the contract, with explicit index
assertions (`[3] === 'Disputed'`, `[4] === 'Released'`) so a parse that silently
returned an empty list cannot pass either.

**Guard.** `web/test/web.test.ts` → "state names are the contract enums, in the
contract order". Reverting `build.mjs` to the literal array fails it.

**Lesson, recorded because it generalises.** A test written from the same
assumption as the code under test is not a check, it is a second copy of the
assumption. The verdict grammar already had this problem solved — four copies,
machine-compared against the source — and the enum names should have been held
to the same standard from the start.

## F2 — `verifyAuthorizationSignature` called with transposed arguments

**Severity: would have rejected every valid payment.** `packages/x402/src/server.ts`
called `verifyAuthorizationSignature(domain, auth, sig)`. The real signature is
`(authorization, domain, sig)`. Both parameters are plain objects, so it compiled
cleanly and failed at runtime inside viem's typed-data validator with
`Cannot read properties of undefined (reading 'length')` — an error that reads as
a library bug rather than a caller mistake.

**How it was found.** The x402 happy-path test failed. Diagnosed by calling the
verifier directly and reading the stack into viem's `validateTypedData`.

**Guard.** `packages/x402/test/x402.test.ts` → "a valid payment returns the payer
and the exact fundJob arguments".

## F3 — `buildChallenge` called with transposed arguments

**Severity: malformed 402 responses.** Same class as F2:
`buildChallenge(error, [requirements])` instead of `(requirements, error)`. The
402 body carried the requirements array in its `error` field, so a paying client
would have received an unintelligible failure instead of a payment challenge.

**How it was found.** Two x402 tests failed after F2 was fixed — the challenge
assertions. The diff showed the requirements object where a string was expected,
which pointed straight at the argument order.

**Guard.** `packages/x402/test/x402.test.ts` → "an unpaid request gets a 402
carrying everything needed to pay".

## F4 — `check-suite.mjs` could not fail

**Severity: a gate that certified absent coverage.** The oracle ran
`npm run test --workspace <pkg> -- --test-name-pattern=<concern>`. npm appends
passthrough arguments to the *end* of the script string, and these packages' test
scripts end in `&& echo <marker>`, so the flag landed on `echo` and was silently
ignored — every concern reported the entire suite as matching. The second
attempt, trusting the runner's `# pass` counter, was also wrong: with a pattern
matching nothing, `node --test` still reports one pass (the file itself counts),
so `pass >= 1` certifies absence.

**How it was found.** The oracle's own positive control: running it against a
deliberately nonexistent concern, which passed.

**Fix.** It now invokes `node --test` directly, parses individual test names out
of the TAP stream, and treats "no test name contains this concern" as failure.

**Guard.** `scripts/check-suite.mjs` now fails on absent coverage. Verified
directly: `node scripts/check-suite.mjs --package @awc/x402 --concern premium`
reports "3 of 24 tests cover" and exits 0, while the same command with a concern
no test covers exits 1 with "none of them cover this concern".

**Lesson.** This is why every absence check in `scripts/` carries a control that
feeds it known-bad input. The bug was not in the matching logic, it was in the
assumption that the filter was being applied at all — and only running the
oracle against something it must reject could reveal that.

## F5 — Vercel served 404 while reporting 200

**Severity: a deliverable reported as live that was not.** Two deployment
configurations (`buildCommand` + `outputDirectory: "."`, then zero-config) both
produced deployments that served 404. Each measured 200 immediately after
deploying, because the measurement hit a CDN cache entry from an earlier state;
`x-vercel-cache: HIT` was in the response the whole time.

I reported the site as live twice on that evidence. Both reports were wrong.

**How it was found.** `scripts/check-vercel.mjs` asserts page *content* and walks
every referenced asset rather than checking a status code. The status code agreed
with the wrong conclusion on every attempt.

**Fix.** Deployed via Vercel's Build Output API (`.vercel/output`), which bypasses
framework detection entirely. Project-level SSO protection — which answers 302 on
a deployment URL — was disabled via the API.

**Guard.** `scripts/check-vercel.mjs`, now per route: it fetches all five pages,
asserts route-specific content, walks every asset, and checks the served
`chrome.js` still lists every route. A gate that only looked at `/` is how this
went stale when the lookup moved to `/inspect`.

## F6 — The comment-stripping build altered the adjudication prompt

**Severity: would have changed what validators judge.** `script/build_genlayer.py`
pruned whitespace-only lines after removing comments, which deleted the blank
lines *inside* the multi-line adjudication prompt — the text every GenLayer
validator reads when deciding a case.

**How it was found.** The build's own AST-equivalence check, which compares
parsed trees rather than text. A line-level diff would have shown only removed
blank lines and looked harmless.

**Fix.** Blank-line pruning removed entirely. Leftover blank lines cost one byte
each in calldata, which is not a reason to touch string content.

**Guard.** `script/build_genlayer.py` refuses to emit an artifact that is not
AST-equivalent to the documented source.

## F7 — Three hand-written function selectors were all wrong

**Severity: a gate failing closed for the wrong reason.**
`scripts/check-deployment.mjs` hardcoded selectors for `escrow()`,
`canonicalReceiver()` and `l1Forwarder()`. All three were wrong, so `eth_call`
hit the fallback and returned empty — the wiring check would have reported a
correctly-wired deployment as miswired.

**How it was found.** Verified against `cast sig` instead of trusting the comment
that claimed they were computed.

**Fix.** Replaced with verified values, and the web layer now derives selectors
with `cast sig` at build time so none is ever typed again.

**Guard.** `node scripts/check-deployment.mjs --chain 84532` passes with three
wiring readbacks; a wrong selector returns empty and fails it.
