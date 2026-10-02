#!/usr/bin/env python3
"""Deploy the Intelligent Contract to GenLayer Bradbury.

Resolves a genuine circular dependency. `VerdictEmitter.court` is immutable by
design — a settable court address would be a rewrite key for every future
verdict — and the Intelligent Contract's `verdict_emitter` is immutable for the
same reason. Each constructor therefore wants the other's address.

The IC is deployed first, against the emitter's *predicted* CREATE address,
because the emitter's address is predictable from the deployer's EVM nonce while
the IC's is assigned by the GenLayer deploy path. The prediction is then checked
rather than trusted: `deploy_emitter.sh` asserts the emitter actually landed at
the predicted address, and if it did not, both deploys are redone with the
corrected nonce. Testnet gas makes that iteration cheap; a silently mismatched
pair would make every verdict unbridgeable.

Usage:
    PRIVATE_KEY=0x... VERDICT_EMITTER=0x... python3 script/deploy_genlayer.py
"""

import json
import os
import pathlib
import re
import sys

from genlayer_py import create_account, create_client
from genlayer_py.chains import testnet_bradbury, studionet

ROOT = pathlib.Path(__file__).resolve().parent.parent
# Defaults to the documented source; `GENLAYER_SOURCE` points at the stripped
# build artifact, which `check-genlayer-build.mjs` proves behaves identically.
CONTRACT = pathlib.Path(
    os.environ.get("GENLAYER_SOURCE", ROOT / "contracts" / "genlayer" / "warranty_court.py")
)
# Bradbury refuses this deploy: the stripped artifact estimates at 21.65M gas
# and the node's per-transaction ceiling sits between 10M (accepted) and 19M
# (refused). Studionet is the owner-sanctioned alternative target.
CHAINS = {"bradbury": testnet_bradbury, "studionet": studionet}
CHAIN_IDS = {"bradbury": 4221, "studionet": 61999}
CHAIN_RPCS = {
    "bradbury": "https://rpc-bradbury.genlayer.com",
    "studionet": "https://studio.genlayer.com/api",
}
TARGET = os.environ.get("GENLAYER_TARGET", "bradbury")

MANIFEST = ROOT / "deployments" / f"{CHAIN_IDS.get(TARGET, 4221)}.json"

ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")


# Bradbury's block gas limit is 100,000,000, and the SDK passes the raw
# `eth_estimateGas` result through as the transaction's gas. For a 34 KB
# contract body the node's estimate comes back above the block limit and the
# transaction is rejected with "gas limit too high" before it is ever mined.
#
# Clamping is therefore not a workaround for a bad estimate but the only way to
# submit at all. The cap is below the block limit with headroom, and the deploy
# still fails loudly if the contract genuinely needs more: it would run out of
# gas rather than silently half-deploy.
GAS_CAP = int(os.environ.get("GENLAYER_GAS_CAP", 90_000_000))


def _clamp_gas() -> None:
    """Cap the SDK's gas field at `GAS_CAP`, leaving everything else alone."""
    from genlayer_py.contracts import actions

    original = actions._prepare_transaction

    def patched(*args, **kwargs):
        tx = original(*args, **kwargs)
        estimated = int(tx.get("gas", "0x0"), 16) if isinstance(tx.get("gas"), str) else int(tx.get("gas", 0))
        if estimated > GAS_CAP:
            print(f"gas: estimate {estimated} exceeds cap, clamping to {GAS_CAP}")
            tx["gas"] = hex(GAS_CAP)
        else:
            print(f"gas: {estimated}")
        return tx

    actions._prepare_transaction = patched


def fail(message: str) -> "None":
    print(f"genlayer deploy FAILED: {message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    private_key = os.environ.get("PRIVATE_KEY", "")
    emitter = os.environ.get("VERDICT_EMITTER", "")

    if not private_key:
        fail("PRIVATE_KEY is unset")
    if not ADDRESS_RE.match(emitter):
        fail(f"VERDICT_EMITTER is not an EVM address: {emitter!r}")

    code = CONTRACT.read_bytes()
    if b"def publishVerdict" not in code:
        fail("the contract source has no publishVerdict interface; refusing to deploy an unwired court")

    _clamp_gas()
    account = create_account(account_private_key=private_key)
    client = create_client(chain=CHAINS[TARGET], account=account)

    print(f"target:          {TARGET} (chain {CHAIN_IDS[TARGET]})")
    print(f"deployer:        {account.address}")
    print(f"verdict_emitter: {emitter}")
    print(f"source bytes:    {len(code)}")

    if os.environ.get("GENLAYER_DRY_RUN") == "1":
        # Estimate and stop. Every real attempt burns a nonce, which matters
        # because the emitter's address is predicted from that nonce.
        from genlayer_py.contracts import actions as _actions

        _actions._prepare_transaction(
            self=client,
            sender=account.address,
            recipient=client.chain.consensus_main_contract["address"],
            data="0x" + ("00" * 4),
            value=0,
        )
        print("dry run: estimate printed above; no transaction sent")
        return

    tx_hash = client.deploy_contract(code=code, args=[emitter])
    print(f"deploy tx:       {tx_hash}")

    receipt = client.wait_for_transaction_receipt(transaction_hash=tx_hash)

    # The receipt schema is not documented, so search rather than index blindly:
    # guessing a key and getting `None` would write a manifest with a null
    # address that every downstream consumer would then treat as deployed.
    address = None
    # GenLayer puts the new contract address in `to_address`/`recipient` on a
    # deploy receipt, and repeats it inside `data.contract_address`. Checked in
    # that order, because the generic scan below cannot distinguish a contract
    # address from a validator address and there are five of those.
    for key in ("to_address", "recipient", "contract_address", "contractAddress", "address"):
        value = receipt.get(key) if isinstance(receipt, dict) else getattr(receipt, key, None)
        if isinstance(value, str) and ADDRESS_RE.match(value):
            address = value
            break
    if address is None:
        data = receipt if isinstance(receipt, dict) else getattr(receipt, "__dict__", {})
        found = re.findall(r"0x[0-9a-fA-F]{40}", json.dumps(data, default=str))
        candidates = [a for a in found if a.lower() != account.address.lower() and a.lower() != emitter.lower()]
        if len(set(candidates)) == 1:
            address = candidates[0]
        else:
            fail(
                "could not identify the contract address in the receipt; "
                f"candidates={sorted(set(candidates))} keys={sorted(data) if isinstance(data, dict) else type(data)}"
            )

    print(f"DEPLOYED AgentWarrantyCourt={address}")

    # Prove it answers before claiming a deployment. A contract that deployed
    # but cannot be read is not a working court, and the manifest is what every
    # other component trusts.
    try:
        count = client.read_contract(address=address, function_name="case_count", args=[])
        registered = client.read_contract(
            address=address, function_name="is_registered", args=[account.address]
        )
    except Exception as err:  # noqa: BLE001 - surface the real reason
        fail(f"deployed at {address} but a view call failed: {err}")

    print(f"case_count():    {count}")
    print(f"is_registered(): {registered}")
    if int(count) != 0:
        fail(f"a freshly deployed court reports {count} cases; wrong address or stale state")

    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    existing = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    contracts = dict(existing.get("contracts", {}))
    contracts["AgentWarrantyCourt"] = address
    tx_hashes = dict(existing.get("txHashes", {}))
    tx_hashes["AgentWarrantyCourt"] = str(tx_hash)

    manifest = {
        "chainId": CHAIN_IDS[TARGET],
        "name": CHAINS[TARGET].name,
        "rpcUrl": CHAIN_RPCS[TARGET],
        "deployer": account.address,
        "contracts": contracts,
        "txHashes": tx_hashes,
        "notes": existing.get(
            "notes",
            "Intelligent Contract plus its EVM-side VerdictEmitter. The court's "
            "verdict_emitter and the emitter's court are both immutable, so the "
            "pair must be deployed against each other's addresses.",
        ),
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"manifest:        {MANIFEST.relative_to(ROOT)}")
    print("genlayer court deployment passed")


if __name__ == "__main__":
    main()
