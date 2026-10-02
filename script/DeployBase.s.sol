// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

import {IERC20} from "../contracts/base/interfaces/IERC20.sol";
import {ProviderStake} from "../contracts/base/ProviderStake.sol";
import {VerdictInbox} from "../contracts/base/VerdictInbox.sol";
import {ReputationLog} from "../contracts/base/ReputationLog.sol";
import {WarrantyEscrow} from "../contracts/base/WarrantyEscrow.sol";
import {CanonicalVerdictReceiver, ICrossDomainMessenger} from "../contracts/base/CanonicalVerdictReceiver.sol";

/// @notice Deploys the Base side of the warranty court and wires it together.
///
/// @dev Deployment order is forced by three one-shot setters. `setEscrow` on the
///      stake vault and the reputation log, and `setCanonicalReceiver` on the
///      inbox, can each be called exactly once, so the escrow must exist before
///      they run and a mistake here is not repairable on the same deployment.
///      That is why the wiring is asserted at the end of this script rather than
///      left for a human to eyeball in the logs.
///
///      The receiver takes an L1 forwarder address that is **reserved, not yet
///      deployed**. GenLayer exposes no provable L2→L1 inclusion-proof interface
///      for chain 4221 (see `.unlazy/build/PLAN.md` revision 2), so deploying a
///      forwarder against a guessed verifier was declined. The address is
///      precomputed from the deployer's Ethereum Sepolia nonce so the forwarder
///      can be deployed there later without touching anything on Base — which
///      matters precisely because `setCanonicalReceiver` is one-shot.
contract DeployBase is Script {
    // Circle's USDC on Base Sepolia, verified on chain: symbol "USDC", 6 decimals.
    address internal constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    // OP Stack predeploy, identical across every OP chain.
    address internal constant L2_MESSENGER = 0x4200000000000000000000000000000000000007;

    uint256 internal constant RELAYER_BOND = 100e6; // 100 USDC
    uint256 internal constant CHALLENGE_BOND = 100e6; // 100 USDC
    uint64 internal constant CHALLENGE_WINDOW = 2 hours;

    /// @dev Kept at the designed 14 days even though the canonical path is not
    ///      active on this deployment. Shortening it would optimise for the
    ///      degraded state and be wrong the moment the forwarder is deployed;
    ///      the backstop needs hours of headroom for batch commitment, proof
    ///      generation and the execution delay.
    uint64 internal constant CANONICAL_TIMEOUT = 14 days;

    uint64 internal constant UNBONDING_DELAY = 21 days; // contract enforces >= 21 days
    uint16 internal constant PREMIUM_BPS = 500; // 5% warranty premium
    uint16 internal constant REQUIRED_STAKE_BPS = 5_000; // 50% of job value
    uint64 internal constant ACCEPTANCE_WINDOW = 3 days;
    uint64 internal constant CURE_WINDOW = 3 days;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address reservedForwarder = vm.envAddress("RESERVED_L1_FORWARDER");

        // The premium pool has no contract of its own in this version, so it is
        // an address the owner controls. Declared as an input rather than
        // silently defaulted to the deployer, so the choice is visible.
        address warrantyVault = vm.envOr("WARRANTY_VAULT", deployer);

        require(reservedForwarder != address(0), "RESERVED_L1_FORWARDER unset");
        require(USDC.code.length > 0, "no USDC at the expected address on this chain");
        require(L2_MESSENGER.code.length > 0, "no L2CrossDomainMessenger predeploy on this chain");

        IERC20 usdc = IERC20(USDC);

        vm.startBroadcast(pk);

        ProviderStake stakeVault = new ProviderStake(usdc, UNBONDING_DELAY);
        VerdictInbox inbox =
            new VerdictInbox(usdc, RELAYER_BOND, CHALLENGE_BOND, CHALLENGE_WINDOW, CANONICAL_TIMEOUT);
        ReputationLog reputation = new ReputationLog();

        WarrantyEscrow escrow = new WarrantyEscrow(
            usdc,
            stakeVault,
            inbox,
            reputation,
            warrantyVault,
            PREMIUM_BPS,
            REQUIRED_STAKE_BPS,
            ACCEPTANCE_WINDOW,
            CURE_WINDOW
        );

        CanonicalVerdictReceiver receiver =
            new CanonicalVerdictReceiver(inbox, ICrossDomainMessenger(L2_MESSENGER), reservedForwarder);

        // The three one-shot calls.
        stakeVault.setEscrow(address(escrow));
        reputation.setEscrow(address(escrow));
        inbox.setCanonicalReceiver(address(receiver));

        vm.stopBroadcast();

        // Assert the wiring rather than print it and hope. Each of these reads
        // back a value that cannot be corrected on this deployment if wrong.
        require(stakeVault.escrow() == address(escrow), "stake vault escrow miswired");
        require(reputation.escrow() == address(escrow), "reputation escrow miswired");
        require(inbox.canonicalReceiver() == address(receiver), "inbox receiver miswired");
        require(address(escrow.stakeVault()) == address(stakeVault), "escrow stake vault miswired");
        require(address(escrow.inbox()) == address(inbox), "escrow inbox miswired");
        require(address(escrow.reputation()) == address(reputation), "escrow reputation miswired");
        require(escrow.warrantyVault() == warrantyVault, "escrow warranty vault miswired");
        require(address(receiver.inbox()) == address(inbox), "receiver inbox miswired");
        require(receiver.l1Forwarder() == reservedForwarder, "receiver forwarder miswired");

        // Emitted as JSON-ish key=value lines so the deploy wrapper can build
        // the manifest from stdout without re-deriving an address.
        console.log("DEPLOYED ProviderStake=%s", address(stakeVault));
        console.log("DEPLOYED VerdictInbox=%s", address(inbox));
        console.log("DEPLOYED ReputationLog=%s", address(reputation));
        console.log("DEPLOYED WarrantyEscrow=%s", address(escrow));
        console.log("DEPLOYED CanonicalVerdictReceiver=%s", address(receiver));
        console.log("DEPLOYED USDC=%s", USDC);
        console.log("DEPLOYED WarrantyVault=%s", warrantyVault);
        console.log("DEPLOYED ReservedL1Forwarder=%s", reservedForwarder);
        console.log("WIRING OK");
    }
}
