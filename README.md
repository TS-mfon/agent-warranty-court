# Agent Warranty Court

An autonomous warranty court for agent-to-agent commerce. GenLayer validators
independently fetch a provider's published SLA and signed execution transcript,
verify claimed facts against live web ground truth, and reach comparative
consensus on breach. USDC escrow and provider stake live on Base, where the
users, the liquidity and the x402 rails already are.

No human in the release path.

## The problem

Agentic commerce has standardised the happy path — ERC-8004 for identity, A2A for
negotiation, x402 for payment — but nothing handles the moment an agent
hallucinates, breaks its output schema, or silently fails while still charging.
Solidity cannot read a natural-language SLA or check whether a cited URL exists.
Human dispute networks take days and cost more than the trade.

## Architecture

```
  Client agent ──x402 pay──> Base: WarrantyEscrow (USDC)
                               │  95% base fee / 5% warranty premium
  Provider agent ─stake────> Base: ProviderStake (USDC, 21d unbonding)
                               │
        dispute filed ─────────┴──> GenLayer: warranty_court.py
                                      │  fetch SLA + transcript + ground truth
                                      │  run_nondet_unsafe(leader, validator)
                                      │  → verdict{code, payout_bps, severity}
                                      ▼
   ┌─────────────────────── FAST PATH (live) ──────────────────────────┐
   │  Keeper finalizes on GenLayer, reads verdict(), relays to Base    │
   ▼                                                                   │
  Base: VerdictInbox.postVerdict(caseId, verdictHash, …)               │
   │    bonded relayer · 2h challenge window                           │
   ├── unchallenged ──> finalizeVerdict() ──> escrow settles + slash   │
   └── challenged ────> resolves by timeout (see Limitations)          │
```

The relayer can **delay** settlement but never **steal** it. Base enforces every
invariant Solidity can check on its own — payout recipient ∈ {client, provider},
payout ≤ escrowed amount, closed payout-bucket set, no state change after
settlement — so even a fully compromised relayer has a bounded blast radius.

## The verdict grammar, four times over

The same rules exist in four places, deliberately: each hop re-derives them
rather than trusting its neighbour, because the relayer is the one party that is
merely bonded rather than trusted.

| Copy | Location |
|---|---|
| Solidity | `contracts/shared/VerdictLib.sol` |
| Python | `VIOLATION_CODES` in `contracts/genlayer/warranty_court.py` |
| TypeScript | `packages/shared/src/verdict.ts` |
| EVM ABI | `VerdictEmitterIface` in the Intelligent Contract |

Four copies of one rule set is a liability, so it is machine-checked rather than
documented: `scripts/check-grammar-parity.mjs` parses the real Solidity and
Python, imports the real TypeScript, compares all of it, and then feeds the
comparator six deliberately corrupted copies to prove it can fail.
`scripts/check-commitment-parity.mjs` extracts the actual Python commitment
function with `ast` and matches it against the TypeScript one over six awkward
vectors.

## Deployments

| Chain | What | Address |
|---|---|---|
| Base Sepolia (84532) | `WarrantyEscrow` | `0x2F9e1C96E5b9DF4d89991b444f1A5C4554aA843a` |
| Base Sepolia | `ProviderStake` | `0x736d0C33aec1B6542E16981c89D08f511E781313` |
| Base Sepolia | `VerdictInbox` | `0x4cE9d815Fd4189eEa1f1f527705Fa2C206A9B975` |
| Base Sepolia | `ReputationLog` | `0x0207EaDAeD95Fd35B4e35AaBc509DB9A90c111Bd` |
| Base Sepolia | `CanonicalVerdictReceiver` | `0xCdE505D5CF63A3F82cb54ac08Ad7892d495631Fc` |
| GenLayer studionet (61999) | `AgentWarrantyCourt` | `0x645f7F35CF0Efde19B56fa0f87BC06b814B14461` |

Full manifests, including every constructor parameter, are in `deployments/`.
Nothing in this repository hardcodes an address; every consumer reads those
files through `packages/shared/src/deployments.ts`.

## Limitations

These are real and worth reading before trusting the system with anything.

**The trustless backstop is not active.** The design calls for a challenged
verdict to be resolved by proving GenLayer's finalized state on Ethereum and
forwarding it to Base. Neither half could be deployed:

- `L1VerdictForwarder` needs GenLayer's L2→L1 message-inclusion verifier.
  GenLayer Bradbury demonstrably settles to Ethereum Sepolia — 383,307 batches
  committed, verified and executed, via Bridgehub
  `0xc4fd2580c3487bba18d63f50301020132342fdbd` and chain diamond
  `0xf8ed76fA41624355F56BC6885e76A208fE039170` — but neither
  `proveL2MessageInclusion` nor `proveL2MessageInclusionShared` is registered on
  that diamond, and on the Bridgehub a real selector and a deliberately
  nonexistent one revert identically. The interface cannot be established from
  outside, and deploying against a guessed verifier would produce a contract
  that looks live and verifies nothing.
- `VerdictEmitter` cannot be co-located with its court. Bradbury has a real EVM
  side but refuses the court's 21.65M-gas deploy; studionet hosts the court but
  implements no ghost contracts and its EVM RPC rejects standard tooling.

**Consequence:** a challenged verdict resolves through `timeoutChallenge` after
14 days, with the posted verdict standing and the challenger forfeiting its bond.
The relayer is bonded but not *provably* falsifiable. Everything that does not
depend on the backstop works.

**Other gaps:**

- `warrantyVault` is an EOA. No pooled vault contract exists yet.
- The court is deployed from a comment-stripped build
  (`build/warranty_court.min.py`), proven AST-equivalent to the documented
  source, because the 34 KB documented source estimates at 27.3M gas.
- Unaudited. Testnet only.

## Verification

```bash
forge test                                      # 152 Solidity tests
uvx --from genlayer-test pytest -q tests/direct  # 48 GenLayer direct-mode tests
npm test                                         # TypeScript package tests
node scripts/check-grammar-parity.mjs            # the four grammar copies agree
node scripts/check-commitment-parity.mjs         # TS commitment == Python commitment
node scripts/check-deployment.mjs                # every manifest address has code
node scripts/check-no-secrets.mjs                # nothing secret is tracked
```

The Solidity suite includes a stateful invariant layer driven by a handler with
three clients, three providers and a never-acting bystander, asserting that
escrow solvency holds as an *equality*, that terminal jobs stay terminal, and
that a verdict can never pay a non-participant.

## Layout

```
contracts/base/          Base L2: escrow, stake, bonded verdict inbox
contracts/genlayer/      The Intelligent Contract (Python, GenVM)
contracts/genlayer-evm/  GenLayer's EVM side: the verdict emitter
contracts/l1/            Ethereum: the canonical-backstop forwarder
contracts/shared/        VerdictLib — the grammar, shared by all three chains
packages/shared/         TypeScript grammar, commitment, deployment loader
script/                  Deploy scripts (Foundry + GenLayer)
scripts/                 Verification oracles
tests/                   Solidity, bridge and GenLayer direct-mode suites
web/                     Case explorer
```

## Licence

MIT
