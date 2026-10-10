# Agent Warranty Court

**An autonomous warranty court for agent-to-agent commerce.** When one AI agent
pays another for work, this protocol escrows the payment in USDC on Base. If the
buyer disputes the deliverable, GenLayer validators independently fetch the
provider's published SLA and signed execution transcript, verify the claims
against live web ground truth, and reach comparative consensus on whether the
provider breached. The verdict settles the escrow and slashes provider stake.

No human in the release path.

- **Live site:** https://agent-warranty-court.vercel.app
- **Full protocol documentation:** [`docs/`](docs/)
- **Threat model and known gaps:** [`docs/security.md`](docs/security.md)

---

## The problem

Agentic commerce standardised the happy path — ERC-8004 for identity, A2A for
negotiation, x402 for payment. Nothing handles the moment an agent hallucinates a
citation, breaks its output schema, or silently fails while still charging.

Solidity cannot read "responses must cite a verifiable source" and decide whether
a response did, nor fetch a cited URL and observe that it 404s. Human dispute
networks can, but take days and cost more than the trade. Neither fits a market
where the trades are small, constant, and between machines.

This is the missing layer: judgment that is automated, adversarially checkable,
and cheap enough to use on a $5 job.

## Architecture

```
  buyer agent ──x402 pay──> Base: WarrantyEscrow (USDC)
                              │  95% escrowed · 5% warranty premium
  seller agent ─stake─────> Base: ProviderStake (21d unbonding)
                              │
       dispute filed ─────────┴──> GenLayer: warranty_court.py
                                     │  fetch SLA + transcript + ground truth
                                     │  independent re-derivation, consensus
                                     │  → {code, payout_bps, severity}
                                     ▼
  ┌──────────────────── FAST PATH (live) ─────────────────────┐
  │ keeper reads the finalized verdict, posts it to Base      │
  ▼                                                           │
 Base: VerdictInbox.postVerdict(...)   bonded · 2h window     │
  ├── unchallenged ──> finalizeVerdict() ──> settle()         │
  └── challenged ────> resolves by timeout (see Limitations)  │
```

The relayer can **delay** settlement but never **steal** it. Base enforces every
invariant arithmetic can enforce, regardless of what a verdict claims: payout
recipient ∈ {client, provider}, payout ≤ that job's escrow, payouts from a closed
five-value set, no movement after a terminal state.

## Quickstart

### Buyer agent

```bash
# 1. fund a job (5 USDC: 0.25 premium, 4.75 escrowed, 2.375 provider stake locked)
cast send $USDC "approve(address,uint256)" $ESCROW 5000000 --private-key $KEY --rpc-url $RPC
cast send $ESCROW "fundJob(bytes32,address,uint256,uint64,uint256)" \
  $JOB_ID $PROVIDER 5000000 86400 1 --private-key $KEY --rpc-url $RPC

# 2. dispute, before the acceptance deadline
cast send $ESCROW "openDispute(bytes32)" $JOB_ID --private-key $KEY --rpc-url $RPC
```

Then `open_case` and `adjudicate` on GenLayer with the evidence digests. Full
sequence with real values: [`docs/integration.md`](docs/integration.md).

### Seller agent

```bash
# stake collateral, then deliver with a signature over the transcript digest
cast send $STAKE "stake(uint256)" 10000000 --private-key $KEY --rpc-url $RPC
DIGEST=$(cast call $ESCROW "deliveryDigestFor(bytes32,bytes32)(bytes32)" $JOB_ID $TRANSCRIPT --rpc-url $RPC)
```

Use `deliveryDigestFor` rather than reconstructing the EIP-191 preimage.

### Never hardcode an address

```ts
import { CHAINS, loadDeployment, addressOf } from '@awc/shared';
const escrow = addressOf(loadDeployment(CHAINS.baseSepolia), 'WarrantyEscrow');
```

`addressOf` throws on a missing contract, because `undefined` becomes the zero
address in most clients and a transaction to the zero address succeeds silently.

## Deployment

| Chain | Contract | Address |
|---|---|---|
| Base Sepolia (84532) | `WarrantyEscrow` | `0x2F9e1C96E5b9DF4d89991b444f1A5C4554aA843a` |
| Base Sepolia | `ProviderStake` | `0x736d0C33aec1B6542E16981c89D08f511E781313` |
| Base Sepolia | `VerdictInbox` | `0x4cE9d815Fd4189eEa1f1f527705Fa2C206A9B975` |
| Base Sepolia | `ReputationLog` | `0x0207EaDAeD95Fd35B4e35AaBc509DB9A90c111Bd` |
| Base Sepolia | `CanonicalVerdictReceiver` | `0xCdE505D5CF63A3F82cb54ac08Ad7892d495631Fc` |
| GenLayer studionet (61999) | `AgentWarrantyCourt` | `0x645f7F35CF0Efde19B56fa0f87BC06b814B14461` |

Every constructor parameter and transaction hash is in [`deployments/`](deployments/).

## Limitations

Read these before trusting the system with anything.

**The trustless canonical backstop is not active.** A challenged verdict should be
settled by proving GenLayer's finalized state on Ethereum and forwarding it to
Base. Both halves are written and tested; neither could be deployed. GenLayer
demonstrably settles to Ethereum Sepolia — 383,307 batches committed, verified and
executed — but neither inclusion-proof selector is registered on its chain
diamond, and on its Bridgehub a real selector and a deliberately nonexistent one
revert identically, so the interface cannot be established from outside.

**Consequence:** a challenged verdict resolves through `timeoutChallenge` after 14
days, with the posted verdict standing and the challenger forfeiting its bond. The
relayer is bonded but not *provably* falsifiable. The full measurements are in
[`docs/security.md`](docs/security.md#the-canonical-backstop-is-not-active).

**Also:** unaudited, testnet only, `warrantyVault` is an EOA with no pooled vault
contract, and the deployed court is a comment-stripped build proven AST-equivalent
to the documented source.

## Verification

```bash
forge test                                        # 152 Solidity tests, incl. stateful invariants
uvx --from genlayer-test pytest -q tests/direct   # 48 GenLayer direct-mode tests
npm test                                          # TypeScript packages

node scripts/check-grammar-parity.mjs     # the four verdict-grammar copies agree
node scripts/check-commitment-parity.mjs  # TS commitment == the real Python function
node scripts/check-deployment.mjs         # every manifest address has code on its chain
node scripts/check-docs.mjs               # every documented signature exists
node scripts/check-no-secrets.mjs         # nothing secret is tracked
node scripts/check-vercel.mjs             # all five routes serve the real app
```

Every oracle that asserts an absence carries a **negative control** — it is fed
deliberately bad input and fails if it accepts it. An absence check that cannot
fail is worse than no check: it certifies.

The Solidity suite includes a handler-driven invariant layer with three clients,
three providers and a never-acting bystander, asserting that escrow solvency holds
as an *equality*, that terminal jobs stay terminal, and that a verdict can never
pay a non-participant.

## Why the verdict grammar exists four times

| Copy | Location |
|---|---|
| Solidity | [`contracts/shared/VerdictLib.sol`](contracts/shared/VerdictLib.sol) |
| Python | `VIOLATION_CODES` in [`contracts/genlayer/warranty_court.py`](contracts/genlayer/warranty_court.py) |
| TypeScript | [`packages/shared/src/verdict.ts`](packages/shared/src/verdict.ts) |
| EVM ABI | `VerdictEmitterIface` in the Intelligent Contract |

Deliberate duplication: the relayer sits between two chains and is the only
participant that is merely bonded rather than trusted, so each hop re-derives the
grammar instead of inheriting its neighbour's verdict. A single shared
implementation would mean one bug reaches every layer at once.

The duplication is only safe because it is machine-compared —
`scripts/check-grammar-parity.mjs` parses the real sources and then proves it can
fail against six corrupted copies. See
[`docs/verdict-grammar.md`](docs/verdict-grammar.md).

## Layout

```
contracts/base/          Base L2: escrow, stake, bonded verdict inbox, reputation
contracts/genlayer/      the Intelligent Contract (Python, GenVM)
contracts/genlayer-evm/  GenLayer's EVM side: the verdict emitter (written, not deployed)
contracts/l1/            Ethereum: the canonical-backstop forwarder (written, not deployed)
contracts/shared/        VerdictLib — the grammar, shared across all three chains
packages/shared/         TypeScript grammar, commitment, deployment loader
packages/x402/           x402 payment leg: premium capture at payment time
script/                  deploy scripts (Foundry + GenLayer)
scripts/                 verification oracles
tests/                   Solidity, bridge and GenLayer direct-mode suites
web/                     the five-page site
docs/                    protocol specification
reports/findings.md      defects found during the build, each with its regression guard
```

## Licence

MIT
