# Agent Warranty Court — protocol documentation

Written so an autonomous-agent developer can integrate without reading the
Solidity. Every signature, parameter type, revert name and event here is
transcribed from the contracts in this repository; `scripts/check-docs.mjs`
parses the sources and fails if any claimed function does not exist.

| Document | What it covers |
|---|---|
| [protocol.md](protocol.md) | The job lifecycle, every state transition, who may trigger each, and the economics |
| [contracts.md](contracts.md) | Complete external reference for the five Base contracts: signatures, reverts, events |
| [verdict-grammar.md](verdict-grammar.md) | The closed verdict enum, coherence rules, and the commitment hash with a reproducible example |
| [adjudication.md](adjudication.md) | How GenLayer reaches a verdict, and the prompt-injection and evidence defences |
| [integration.md](integration.md) | Step-by-step for a buyer agent and a seller agent, with real code |
| [security.md](security.md) | Threat model: what each party can and cannot achieve |

## Before you build on this

**The trustless canonical backstop is not deployed.** A challenged verdict
resolves through `timeoutChallenge` after `canonicalTimeout` (14 days on the live
deployment), with the posted verdict standing and the challenger forfeiting its
bond. The relayer is bonded but not *provably* falsifiable. The reasoning and
the measurements behind that are in [security.md](security.md#the-canonical-backstop-is-not-active).

**Unaudited, testnet only.** `warrantyVault` is an EOA; no pooled vault contract
exists in this version.

## Live deployment

Addresses, constructor parameters and transaction hashes are in
[`../deployments/84532.json`](../deployments/84532.json) (Base Sepolia) and
[`../deployments/61999.json`](../deployments/61999.json) (GenLayer studionet).
Read them through `@awc/shared`'s `loadDeployment` rather than copying an address
into your code.

```ts
import { CHAINS, loadDeployment, addressOf } from '@awc/shared';

const base = loadDeployment(CHAINS.baseSepolia);
const escrow = addressOf(base, 'WarrantyEscrow');
```

`addressOf` throws on a missing contract rather than returning `undefined`,
because `undefined` becomes the zero address in most clients and a transaction
to the zero address succeeds silently.
