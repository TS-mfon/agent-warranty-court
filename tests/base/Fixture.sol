// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {IERC20} from "../../contracts/base/interfaces/IERC20.sol";
import {VerdictLib} from "../../contracts/shared/VerdictLib.sol";
import {ProviderStake} from "../../contracts/base/ProviderStake.sol";
import {VerdictInbox} from "../../contracts/base/VerdictInbox.sol";
import {ReputationLog} from "../../contracts/base/ReputationLog.sol";
import {WarrantyEscrow} from "../../contracts/base/WarrantyEscrow.sol";
import {CanonicalVerdictReceiver, ICrossDomainMessenger} from "../../contracts/base/CanonicalVerdictReceiver.sol";

import {MockUSDC, MockMessenger} from "./mocks/Mocks.sol";

/// @notice Shared deployment and helpers for the Base-side test suite.
abstract contract Fixture is Test {
    uint16 internal constant PREMIUM_BPS = 500; // 5% warranty premium
    uint16 internal constant REQUIRED_STAKE_BPS = 5_000; // 50% of job value
    uint64 internal constant ACCEPTANCE_WINDOW = 3 days;
    uint64 internal constant CURE_WINDOW = 3 days;
    uint64 internal constant CHALLENGE_WINDOW = 2 hours;
    uint64 internal constant CANONICAL_TIMEOUT = 14 days;
    uint64 internal constant UNBONDING_DELAY = 21 days;
    uint64 internal constant DELIVERY_WINDOW = 1 days;

    uint256 internal constant RELAYER_BOND = 100e6;
    uint256 internal constant CHALLENGE_BOND = 100e6;

    uint256 internal constant JOB_AMOUNT = 1_000e6;
    uint256 internal constant EXPECTED_PREMIUM = 50e6;
    uint256 internal constant EXPECTED_ESCROW = 950e6;
    uint256 internal constant EXPECTED_STAKE_LOCK = 475e6;

    MockUSDC internal token;
    ProviderStake internal stake;
    VerdictInbox internal inbox;
    ReputationLog internal reputation;
    WarrantyEscrow internal escrow;
    CanonicalVerdictReceiver internal receiver;
    MockMessenger internal messenger;

    address internal warrantyVault;
    address internal l1Forwarder;
    address internal client;
    address internal relayer;
    address internal challenger;
    address internal outsider;

    /// @dev The provider is key-derived so delivery signatures can be produced.
    uint256 internal providerPk = 0xA11CE;
    address internal provider;

    function setUp() public virtual {
        warrantyVault = makeAddr("warrantyVault");
        l1Forwarder = makeAddr("l1Forwarder");
        client = makeAddr("client");
        relayer = makeAddr("relayer");
        challenger = makeAddr("challenger");
        outsider = makeAddr("outsider");
        provider = vm.addr(providerPk);

        token = new MockUSDC();
        messenger = new MockMessenger();

        stake = new ProviderStake(IERC20(address(token)), UNBONDING_DELAY);
        inbox = new VerdictInbox(
            IERC20(address(token)), RELAYER_BOND, CHALLENGE_BOND, CHALLENGE_WINDOW, CANONICAL_TIMEOUT
        );
        reputation = new ReputationLog();
        escrow = new WarrantyEscrow(
            IERC20(address(token)),
            stake,
            inbox,
            reputation,
            warrantyVault,
            PREMIUM_BPS,
            REQUIRED_STAKE_BPS,
            ACCEPTANCE_WINDOW,
            CURE_WINDOW
        );

        stake.setEscrow(address(escrow));
        reputation.setEscrow(address(escrow));

        receiver = new CanonicalVerdictReceiver(inbox, ICrossDomainMessenger(address(messenger)), l1Forwarder);
        inbox.setCanonicalReceiver(address(receiver));

        _mintAndApprove(client, 1_000_000e6);
        _mintAndApprove(provider, 1_000_000e6);
        _mintAndApprove(relayer, 1_000_000e6);
        _mintAndApprove(challenger, 1_000_000e6);
        _mintAndApprove(outsider, 1_000_000e6);

        // Timestamps start at 1 in Foundry; move forward so window arithmetic
        // is never comparing against a near-zero clock.
        vm.warp(1_700_000_000);
    }

    function _mintAndApprove(address who, uint256 amount) internal {
        token.mint(who, amount);
        vm.startPrank(who);
        token.approve(address(escrow), type(uint256).max);
        token.approve(address(stake), type(uint256).max);
        token.approve(address(inbox), type(uint256).max);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Flow helpers
    // ---------------------------------------------------------------------

    function _stakeFor(address who, uint256 amount) internal {
        vm.prank(who);
        stake.stake(amount);
    }

    function _fund(bytes32 jobId, uint256 amount) internal {
        vm.prank(client);
        escrow.fundJob(jobId, provider, amount, DELIVERY_WINDOW, 1);
    }

    /// @dev A fully staked, funded job — the starting point for most tests.
    function _fundedJob(bytes32 jobId) internal {
        _stakeFor(provider, EXPECTED_STAKE_LOCK);
        _fund(jobId, JOB_AMOUNT);
    }

    function _signDelivery(bytes32 jobId, bytes32 transcriptDigest)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 digest = escrow.deliveryDigestFor(jobId, transcriptDigest);
        (v, r, s) = vm.sign(providerPk, digest);
    }

    /// @dev Relayed delivery: a third party submits what the provider signed
    ///      off-chain. This is the common agentic path, so it is the default.
    function _deliverBySig(bytes32 jobId, bytes32 transcriptDigest) internal {
        (uint8 v, bytes32 r, bytes32 s) = _signDelivery(jobId, transcriptDigest);
        vm.prank(outsider);
        escrow.submitDelivery(jobId, transcriptDigest, v, r, s);
    }

    function _deliverByProvider(bytes32 jobId, bytes32 transcriptDigest) internal {
        vm.prank(provider);
        escrow.submitDelivery(jobId, transcriptDigest, 0, bytes32(0), bytes32(0));
    }

    function _dispute(bytes32 jobId) internal returns (bytes32 caseId) {
        vm.prank(client);
        caseId = escrow.openDispute(jobId);
    }

    function _post(bytes32 caseId, uint8 code, uint16 payoutBps, uint8 severity) internal {
        vm.prank(relayer);
        inbox.postVerdict(caseId, _verdictHash(caseId, code, payoutBps, severity), code, payoutBps, severity, _txId(caseId));
    }

    function _finalize(bytes32 caseId) internal {
        vm.warp(block.timestamp + CHALLENGE_WINDOW);
        inbox.finalizeVerdict(caseId);
    }

    /// @dev Post, let the window close, finalize — the uncontested happy path.
    function _postAndFinalize(bytes32 caseId, uint8 code, uint16 payoutBps, uint8 severity) internal {
        _post(caseId, code, payoutBps, severity);
        _finalize(caseId);
    }

    function _verdictHash(bytes32 caseId, uint8 code, uint16 payoutBps, uint8 severity)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode("verdict", caseId, code, payoutBps, severity));
    }

    function _txId(bytes32 caseId) internal pure returns (bytes32) {
        return keccak256(abi.encode("genlayer-tx", caseId));
    }

    /// @dev Deliver a canonical verdict the way the real bridge would: through
    ///      the messenger, with the L1 forwarder as the cross-domain sender.
    function _deliverCanonical(bytes32 caseId, bytes32 verdictHash, uint8 code, uint16 payoutBps, uint8 severity)
        internal
    {
        messenger.setXDomainMessageSender(l1Forwarder);
        messenger.relay(
            address(receiver),
            abi.encodeCall(CanonicalVerdictReceiver.deliverVerdict, (caseId, verdictHash, code, payoutBps, severity))
        );
    }
}
