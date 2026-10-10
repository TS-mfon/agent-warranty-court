# Integration

Two roles. A **buyer agent** funds work and disputes bad deliverables. A **seller
agent** stakes collateral, delivers with a signed transcript, and gets paid.

Read addresses through `@awc/shared` rather than copying them:

```ts
import { CHAINS, loadDeployment, addressOf } from '@awc/shared';

const base = loadDeployment(CHAINS.baseSepolia);
const ESCROW = addressOf(base, 'WarrantyEscrow');
const STAKE = addressOf(base, 'ProviderStake');
const INBOX = addressOf(base, 'VerdictInbox');
const USDC = addressOf(base, 'USDC');
```

`addressOf` throws on a missing contract. `undefined` would become the zero
address in most clients, and a transaction to the zero address succeeds silently.

---

## Seller agent

### 1. Publish an SLA and register

Host the SLA at a stable URL and register its digest. The digest is pinned, so
you cannot rewrite your obligations after a dispute is filed — which is the point
from the buyer's side.

```bash
SLA_DIGEST=$(curl -sS https://you.example/sla.md | sha256sum | cut -d' ' -f1)
```

Then on GenLayer (studionet, chain 61999):

```python
client.write_contract(
    address=COURT,
    function_name="register_provider",
    args=[erc8004_token_id, "https://you.example/sla.md", sla_digest],
)
```

### 2. Stake collateral

A job locks `escrowed * requiredStakeBps / 10000` — 50% on the live deployment.
A 5 USDC job needs 2.375 USDC of *available* stake, so stake enough to cover the
concurrent jobs you intend to accept.

```bash
cast send $USDC "approve(address,uint256)" $STAKE 10000000 --private-key $KEY --rpc-url $RPC
cast send $STAKE "stake(uint256)" 10000000 --private-key $KEY --rpc-url $RPC
cast call $STAKE "availableStake(address)(uint256)" $YOU --rpc-url $RPC
```

Withdrawal takes 21 days and is blocked while any dispute is open, including one
filed after you started the clock.

### 3. Deliver, with a signature

Hash the transcript, ask the escrow for the exact digest to sign, sign it, submit.

```ts
import { createHash } from 'node:crypto';

const transcript = JSON.stringify(executionLog);
const transcriptDigest = '0x' + createHash('sha256').update(transcript, 'utf8').digest('hex');
```

```bash
DIGEST=$(cast call $ESCROW "deliveryDigestFor(bytes32,bytes32)(bytes32)" $JOB_ID $TRANSCRIPT_DIGEST --rpc-url $RPC)
SIG=$(cast wallet sign --no-hash $DIGEST --private-key $KEY)
R=0x${SIG:2:64}; S=0x${SIG:66:64}; V=$((0x${SIG:130:2}))
cast send $ESCROW "submitDelivery(bytes32,bytes32,uint8,bytes32,bytes32)" \
  $JOB_ID $TRANSCRIPT_DIGEST $V $R $S --private-key $KEY --rpc-url $RPC
```

Use `deliveryDigestFor` rather than reconstructing the EIP-191 preimage. Two
rules are enforced and will revert `BadSignature`: `v` must be 27 or 28, and `s`
must be low-half. Most signers already produce canonical signatures; if yours
does not, normalise `s` to `n - s` and flip `v`.

Publish the transcript at a URL the buyer commits to when it disputes. If that
host is unreachable at adjudication time, the case resolves as
`EVIDENCE_UNAVAILABLE` — a cure window then release to you, never a slash. You
do not benefit from taking it offline, and nor does the buyer.

---

## Buyer agent

### 1. Pay through x402 (optional but recommended)

The x402 endpoint captures the warranty premium at payment time, so the trade is
insured before execution begins.

```bash
curl -sS "http://intake.example/quote?amount=5000000"
# { "split": { "gross":"5000000","premium":"250000","escrowed":"4750000","requiredStake":"2375000" }, … }
```

`POST /jobs` with no `X-PAYMENT` returns 402 and a challenge naming the asset,
the recipient, the amount, a nonce and a validity window. Sign an EIP-3009
`TransferWithAuthorization` over it, retry with the base64 payload in
`X-PAYMENT`, and the response carries the verified payer plus the exact `fundJob`
arguments.

```ts
import { splitPremiumForChain } from '@awc/x402';

const split = splitPremiumForChain(5_000_000n);
// { gross: 5000000n, premium: 250000n, escrowed: 4750000n, requiredStake: 2375000n }
```

That arithmetic is transcribed from `fundJob` including Solidity's truncation, so
the quote is a number the contract will honour.

### 2. Fund the job

```bash
JOB_ID=$(cast keccak "job:$(date +%s):$PROVIDER")
cast send $USDC "approve(address,uint256)" $ESCROW 5000000 --private-key $KEY --rpc-url $RPC
cast send $ESCROW "fundJob(bytes32,address,uint256,uint64,uint256)" \
  $JOB_ID $PROVIDER 5000000 86400 1 --private-key $KEY --rpc-url $RPC
```

Pick `jobId` yourself; it must be unused (`JobExists`). `deliveryWindow` is
seconds and must be non-zero.

### 3. Accept, or dispute

After `acceptanceDeadline` anyone may call `release(jobId)` and the provider is
paid. To dispute, you must act *before* that deadline:

```bash
CASE_ID=$(cast call $ESCROW "openDispute(bytes32)(bytes32)" $JOB_ID --rpc-url $RPC)
cast send $ESCROW "openDispute(bytes32)" $JOB_ID --private-key $KEY --rpc-url $RPC
```

`caseIdFor(jobId, disputeIndex)` is `pure`, so you can derive the id without a
transaction.

### 4. Open the case on GenLayer

Commit the evidence digests here. Both are checked against fetched bytes during
adjudication.

```python
client.write_contract(
    address=COURT,
    function_name="open_case",
    args=[
        case_id,                 # 0x + 64 hex, the Base caseId
        provider_address,
        job_id,                  # escrow_ref
        "https://you.example/transcript-1.json",
        transcript_sha256_hex,
        "DEAD_LINK_CITATION",    # your claim, from the closed enum, never NO_BREACH
        "The cited source does not exist.",
        ["https://citations.example/missing"],   # at most 5, no whitespace
    ],
)
```

Name the URLs you say are dead. The contract never scrapes links out of
attacker-supplied text, so an unnamed dead link is not probed.

### 5. Adjudicate

```python
client.write_contract(address=COURT, function_name="adjudicate", args=[case_id])
```

Then poll until the case is terminal:

```python
client.read_contract(address=COURT, function_name="case_status", args=[case_id])
# OPEN | DECIDED | EVIDENCE_UNAVAILABLE | APPEAL_AUTHORIZED
```

`[EXPECTED]` and `[TRANSIENT]` failures revert and leave the case `OPEN` — retry,
and a fresh leader is selected.

---

## Relaying a verdict to Base

Anyone can relay, against a bond. Read the verdict, post it, let the window
lapse, settle.

```python
v = client.read_contract(address=COURT, function_name="verdict", args=[case_id])
# verdict_hash and solidity_code are EMPTY STRINGS while the case is open —
# not zeros. Solidity code 0 is NO_BREACH, a real acquittal.
assert v["verdict_hash"], "case is not terminal yet"
```

```bash
cast send $USDC "approve(address,uint256)" $INBOX 100000000 --private-key $KEY --rpc-url $RPC
cast send $INBOX "postVerdict(bytes32,bytes32,uint8,uint16,uint8,bytes32)" \
  $CASE_ID $VERDICT_HASH $SOLIDITY_CODE $PAYOUT_BPS $SEVERITY $GENLAYER_TX_ID \
  --private-key $KEY --rpc-url $RPC

# after challengeWindow (2h), permissionless:
cast send $INBOX "finalizeVerdict(bytes32)" $CASE_ID --private-key $KEY --rpc-url $RPC
cast send $ESCROW "settle(bytes32)" $JOB_ID --private-key $KEY --rpc-url $RPC
```

The relayer bond is 100 USDC and is refunded at finalization, so running jobs
sequentially recycles one bond.

Recompute `verdict_hash` yourself before posting — see
[verdict-grammar.md](verdict-grammar.md#the-verdict-commitment). Posting a hash
that does not match the finalized GenLayer state is what the challenge mechanism
exists to punish.

If `settle` returns with the job still `Disputed`, the verdict was code 6 and a
cure window opened. Call `settleAfterCure(jobId)` after `cureDeadline`.

---

## Reading state

```ts
const state = await publicClient.readContract({
  address: ESCROW, abi, functionName: 'stateOf', args: [jobId],
});
```

Map the index through the contract's own enum order —
`None, Funded, Delivered, Disputed, Released, Settled, Refunded`. Do not
hand-write that list: transposing `Disputed` and `Released` is a real bug that
shipped in this repository's own front end and told a user their disputed job had
paid out. `web/build.mjs` now parses it from the Solidity.

`VerdictInbox.statusOf` is `None, Posted, Challenged, Final`.
