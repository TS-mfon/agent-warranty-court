// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Fixture} from "./Fixture.sol";
import {VerdictLib} from "../../contracts/shared/VerdictLib.sol";
import {VerdictInbox} from "../../contracts/base/VerdictInbox.sol";
import {CanonicalVerdictReceiver} from "../../contracts/base/CanonicalVerdictReceiver.sol";

contract VerdictInboxTest is Fixture {
    bytes32 internal constant CASE = keccak256("case-1");

    function _hash(uint8 code, uint16 bps, uint8 sev) internal pure returns (bytes32) {
        return keccak256(abi.encode("verdict", CASE, code, bps, sev));
    }

    // ---------------------------------------------------------------------
    // Posting: the grammar gate
    // ---------------------------------------------------------------------

    function test_postVerdict_storesAndBondsRelayer() public {
        uint256 before = token.balanceOf(relayer);
        _post(CASE, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);

        VerdictInbox.Verdict memory v = inbox.verdictOf(CASE);
        assertEq(uint8(v.status), uint8(VerdictInbox.Status.Posted));
        assertEq(v.relayer, relayer);
        assertEq(v.payoutBps, 5_000);
        assertEq(v.code, VerdictLib.DEAD_LINK_CITATION);
        assertEq(v.severity, 2);
        assertEq(v.genlayerTxId, _txId(CASE));

        assertEq(before - token.balanceOf(relayer), RELAYER_BOND);
        assertEq(token.balanceOf(address(inbox)), RELAYER_BOND);
    }

    function test_postVerdict_rejectsDuplicate() public {
        _post(CASE, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);
        vm.prank(relayer);
        vm.expectRevert(VerdictInbox.CaseAlreadyPosted.selector);
        inbox.postVerdict(CASE, _hash(VerdictLib.NO_BREACH, 0, 0), VerdictLib.NO_BREACH, 0, 0, _txId(CASE));
    }

    /// @notice The shape a half-successful prompt injection produces: every
    ///         field individually legal, incoherent together.
    function test_postVerdict_rejectsNoBreachWithPayout() public {
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(VerdictInbox.IncoherentVerdict.selector, VerdictLib.NO_BREACH, 10_000, 0)
        );
        inbox.postVerdict(CASE, _hash(VerdictLib.NO_BREACH, 10_000, 0), VerdictLib.NO_BREACH, 10_000, 0, _txId(CASE));
    }

    function test_postVerdict_rejectsBreachWithoutPayout() public {
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                VerdictInbox.IncoherentVerdict.selector, VerdictLib.SILENT_FAILURE, 0, 2
            )
        );
        inbox.postVerdict(CASE, _hash(VerdictLib.SILENT_FAILURE, 0, 2), VerdictLib.SILENT_FAILURE, 0, 2, _txId(CASE));
    }

    function test_postVerdict_rejectsBreachBelowMinimumBucket() public {
        // 1000 bps is not a bucket and is also below the breach floor.
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                VerdictInbox.IncoherentVerdict.selector, VerdictLib.DEAD_LINK_CITATION, 1_000, 1
            )
        );
        inbox.postVerdict(
            CASE, _hash(VerdictLib.DEAD_LINK_CITATION, 1_000, 1), VerdictLib.DEAD_LINK_CITATION, 1_000, 1, _txId(CASE)
        );
    }

    function test_postVerdict_rejectsOffEnumCode() public {
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(VerdictInbox.IncoherentVerdict.selector, 7, 5_000, 2));
        inbox.postVerdict(CASE, _hash(7, 5_000, 2), 7, 5_000, 2, _txId(CASE));
    }

    function test_postVerdict_rejectsSeverityAboveThree() public {
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(VerdictInbox.IncoherentVerdict.selector, VerdictLib.SILENT_FAILURE, 5_000, 4)
        );
        inbox.postVerdict(
            CASE, _hash(VerdictLib.SILENT_FAILURE, 5_000, 4), VerdictLib.SILENT_FAILURE, 5_000, 4, _txId(CASE)
        );
    }

    function test_postVerdict_requiresHashAndTxId() public {
        vm.prank(relayer);
        vm.expectRevert(VerdictInbox.EmptyVerdictHash.selector);
        inbox.postVerdict(CASE, bytes32(0), VerdictLib.NO_BREACH, 0, 0, _txId(CASE));

        vm.prank(relayer);
        vm.expectRevert(VerdictInbox.EmptyGenlayerTxId.selector);
        inbox.postVerdict(CASE, _hash(VerdictLib.NO_BREACH, 0, 0), VerdictLib.NO_BREACH, 0, 0, bytes32(0));
    }

    function test_postVerdict_evidenceUnavailableMustCarryZeroPayout() public {
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(VerdictInbox.IncoherentVerdict.selector, VerdictLib.EVIDENCE_UNAVAILABLE, 2_500, 1)
        );
        inbox.postVerdict(
            CASE,
            _hash(VerdictLib.EVIDENCE_UNAVAILABLE, 2_500, 1),
            VerdictLib.EVIDENCE_UNAVAILABLE,
            2_500,
            1,
            _txId(CASE)
        );
    }

    // ---------------------------------------------------------------------
    // The optimistic window
    // ---------------------------------------------------------------------

    function test_finalizeVerdict_refundsRelayerBond() public {
        _post(CASE, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);
        uint256 before = token.balanceOf(relayer);

        vm.warp(block.timestamp + CHALLENGE_WINDOW);
        inbox.finalizeVerdict(CASE);

        assertEq(uint8(inbox.statusOf(CASE)), uint8(VerdictInbox.Status.Final));
        assertEq(token.balanceOf(relayer) - before, RELAYER_BOND);
        assertEq(token.balanceOf(address(inbox)), 0);
    }

    function test_finalizeVerdict_revertsInsideWindow() public {
        _post(CASE, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);
        uint64 closesAt = inbox.verdictOf(CASE).postedAt + CHALLENGE_WINDOW;

        vm.warp(block.timestamp + CHALLENGE_WINDOW - 1);
        vm.expectRevert(abi.encodeWithSelector(VerdictInbox.ChallengeWindowOpen.selector, closesAt));
        inbox.finalizeVerdict(CASE);
    }

    /// @notice Finalization is permissionless by design, so no operator can
    ///         withhold settlement.
    function test_finalizeVerdict_isPermissionless() public {
        _post(CASE, VerdictLib.NO_BREACH, 0, 0);
        vm.warp(block.timestamp + CHALLENGE_WINDOW);
        vm.prank(outsider);
        inbox.finalizeVerdict(CASE);
        assertEq(uint8(inbox.statusOf(CASE)), uint8(VerdictInbox.Status.Final));
    }

    function test_challenge_locksVerdictAndBondsChallenger() public {
        _post(CASE, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);
        uint256 before = token.balanceOf(challenger);

        vm.prank(challenger);
        inbox.challenge(CASE);

        assertEq(uint8(inbox.statusOf(CASE)), uint8(VerdictInbox.Status.Challenged));
        assertEq(inbox.verdictOf(CASE).challenger, challenger);
        assertEq(before - token.balanceOf(challenger), CHALLENGE_BOND);

        // A challenged verdict cannot be finalized optimistically.
        vm.warp(block.timestamp + CHALLENGE_WINDOW);
        vm.expectRevert(
            abi.encodeWithSelector(VerdictInbox.NotChallengeable.selector, VerdictInbox.Status.Challenged)
        );
        inbox.finalizeVerdict(CASE);
    }

    function test_challenge_revertsAfterWindowCloses() public {
        _post(CASE, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);
        vm.warp(block.timestamp + CHALLENGE_WINDOW);
        vm.prank(challenger);
        vm.expectRevert(VerdictInbox.ChallengeWindowClosed.selector);
        inbox.challenge(CASE);
    }

    function test_finalVerdictOf_revertsUnlessFinal() public {
        vm.expectRevert(abi.encodeWithSelector(VerdictInbox.VerdictNotFinal.selector, VerdictInbox.Status.None));
        inbox.finalVerdictOf(CASE);

        _post(CASE, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);
        vm.expectRevert(abi.encodeWithSelector(VerdictInbox.VerdictNotFinal.selector, VerdictInbox.Status.Posted));
        inbox.finalVerdictOf(CASE);
    }

    // ---------------------------------------------------------------------
    // Canonical resolution
    // ---------------------------------------------------------------------

    function test_resolveChallenge_honestRelayerTakesBothBonds() public {
        _post(CASE, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);
        vm.prank(challenger);
        inbox.challenge(CASE);

        uint256 relayerBefore = token.balanceOf(relayer);
        _deliverCanonical(CASE, _hash(VerdictLib.DEAD_LINK_CITATION, 5_000, 2), VerdictLib.DEAD_LINK_CITATION, 5_000, 2);

        VerdictInbox.Verdict memory v = inbox.verdictOf(CASE);
        assertEq(uint8(v.status), uint8(VerdictInbox.Status.Final));
        assertFalse(v.overturned);
        assertEq(token.balanceOf(relayer) - relayerBefore, RELAYER_BOND + CHALLENGE_BOND);
        assertEq(token.balanceOf(address(inbox)), 0);
    }

    /// @notice The property the whole optimistic design rests on: a relayer that
    ///         posts a verdict GenLayer did not reach is overturned and pays.
    function test_resolveChallenge_falseVerdictIsOverturnedAndRelayerLosesBond() public {
        // Relayer posts a maximal payout the court never issued.
        _post(CASE, VerdictLib.SILENT_FAILURE, 10_000, 3);
        vm.prank(challenger);
        inbox.challenge(CASE);

        uint256 challengerBefore = token.balanceOf(challenger);
        bytes32 truthHash = _hash(VerdictLib.NO_BREACH, 0, 0);
        _deliverCanonical(CASE, truthHash, VerdictLib.NO_BREACH, 0, 0);

        VerdictInbox.Verdict memory v = inbox.verdictOf(CASE);
        assertEq(uint8(v.status), uint8(VerdictInbox.Status.Final));
        assertTrue(v.overturned);
        // Canonical values replace the posted ones outright.
        assertEq(v.code, VerdictLib.NO_BREACH);
        assertEq(v.payoutBps, 0);
        assertEq(v.severity, 0);
        assertEq(v.verdictHash, truthHash);

        assertEq(token.balanceOf(challenger) - challengerBefore, RELAYER_BOND + CHALLENGE_BOND);
    }

    /// @notice A relayer that alters only the reasoning, keeping the numbers
    ///         intact, is still overturned — which is why the hash is stored.
    function test_resolveChallenge_detectsAlteredReasoningAlone() public {
        _post(CASE, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);
        vm.prank(challenger);
        inbox.challenge(CASE);

        _deliverCanonical(CASE, keccak256("the real reasoning"), VerdictLib.DEAD_LINK_CITATION, 5_000, 2);

        assertTrue(inbox.verdictOf(CASE).overturned);
        assertEq(inbox.verdictOf(CASE).verdictHash, keccak256("the real reasoning"));
    }

    function test_resolveChallenge_rejectsIncoherentCanonicalValues() public {
        _post(CASE, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);
        vm.prank(challenger);
        inbox.challenge(CASE);

        // Set the cross-domain sender first: `expectRevert` binds to the very
        // next call, so it cannot be placed ahead of the `_deliverCanonical`
        // helper — the mock setter would absorb the expectation and the test
        // would pass without ever exercising the coherence check.
        messenger.setXDomainMessageSender(l1Forwarder);
        vm.expectRevert(
            abi.encodeWithSelector(VerdictInbox.IncoherentVerdict.selector, VerdictLib.NO_BREACH, 10_000, 0)
        );
        messenger.relay(
            address(receiver),
            abi.encodeCall(
                CanonicalVerdictReceiver.deliverVerdict,
                (CASE, keccak256("h"), VerdictLib.NO_BREACH, uint16(10_000), uint8(0))
            )
        );

        // The challenge is still live, so the honest path remains open.
        assertEq(uint8(inbox.statusOf(CASE)), uint8(VerdictInbox.Status.Challenged));
    }

    function test_resolveChallenge_onlyFromCanonicalReceiver() public {
        _post(CASE, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);
        vm.prank(challenger);
        inbox.challenge(CASE);

        vm.prank(outsider);
        vm.expectRevert(VerdictInbox.NotCanonicalReceiver.selector);
        inbox.resolveChallenge(CASE, keccak256("h"), VerdictLib.NO_BREACH, 0, 0);
    }

    function test_setCanonicalReceiver_isOneShot() public {
        vm.expectRevert(VerdictInbox.ReceiverAlreadySet.selector);
        inbox.setCanonicalReceiver(outsider);
    }

    // ---------------------------------------------------------------------
    // Canonical bridge authentication
    // ---------------------------------------------------------------------

    /// @notice `xDomainMessageSender` alone is not authentication: a direct
    ///         caller controls `msg.sender` entirely. Without the messenger
    ///         check, this call would succeed and forge a verdict.
    function test_receiver_rejectsDirectCall() public {
        _post(CASE, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);
        vm.prank(challenger);
        inbox.challenge(CASE);

        messenger.setXDomainMessageSender(l1Forwarder);
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(CanonicalVerdictReceiver.NotMessenger.selector, outsider));
        receiver.deliverVerdict(CASE, keccak256("h"), VerdictLib.NO_BREACH, 0, 0);
    }

    /// @notice `msg.sender == messenger` alone is not authentication either:
    ///         any L1 address can send through the messenger. Without the
    ///         forwarder check, anyone could forge a verdict.
    function test_receiver_rejectsWrongL1Sender() public {
        _post(CASE, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);
        vm.prank(challenger);
        inbox.challenge(CASE);

        address attacker = makeAddr("l1Attacker");
        messenger.setXDomainMessageSender(attacker);

        vm.expectRevert(abi.encodeWithSelector(CanonicalVerdictReceiver.NotL1Forwarder.selector, attacker));
        messenger.relay(
            address(receiver),
            abi.encodeCall(
                CanonicalVerdictReceiver.deliverVerdict, (CASE, keccak256("h"), VerdictLib.NO_BREACH, uint16(0), uint8(0))
            )
        );
    }

    /// @notice An unset cross-domain sender reads as the zero address, which
    ///         must not pass either.
    function test_receiver_rejectsZeroL1Sender() public {
        _post(CASE, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);
        vm.prank(challenger);
        inbox.challenge(CASE);

        vm.expectRevert(abi.encodeWithSelector(CanonicalVerdictReceiver.NotL1Forwarder.selector, address(0)));
        messenger.relay(
            address(receiver),
            abi.encodeCall(
                CanonicalVerdictReceiver.deliverVerdict, (CASE, keccak256("h"), VerdictLib.NO_BREACH, uint16(0), uint8(0))
            )
        );
    }

    // ---------------------------------------------------------------------
    // Bridge outage
    // ---------------------------------------------------------------------

    function test_timeoutChallenge_postedVerdictStandsAndChallengerForfeits() public {
        _post(CASE, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);
        vm.prank(challenger);
        inbox.challenge(CASE);

        uint256 relayerBefore = token.balanceOf(relayer);
        uint256 challengerBefore = token.balanceOf(challenger);

        vm.warp(block.timestamp + CANONICAL_TIMEOUT);
        inbox.timeoutChallenge(CASE);

        VerdictInbox.Verdict memory v = inbox.verdictOf(CASE);
        assertEq(uint8(v.status), uint8(VerdictInbox.Status.Final));
        assertEq(v.payoutBps, 5_000, "posted verdict should stand");
        assertFalse(v.overturned);

        assertEq(token.balanceOf(relayer) - relayerBefore, RELAYER_BOND + CHALLENGE_BOND);
        assertEq(token.balanceOf(challenger), challengerBefore);
        assertEq(token.balanceOf(address(inbox)), 0);
    }

    function test_timeoutChallenge_revertsBeforeTimeout() public {
        _post(CASE, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);
        vm.prank(challenger);
        inbox.challenge(CASE);
        uint64 timesOutAt = inbox.verdictOf(CASE).challengedAt + CANONICAL_TIMEOUT;

        vm.warp(block.timestamp + CANONICAL_TIMEOUT - 1);
        vm.expectRevert(abi.encodeWithSelector(VerdictInbox.CanonicalStillPending.selector, timesOutAt));
        inbox.timeoutChallenge(CASE);
    }

    /// @notice Every posted verdict reaches a terminal state by some route, or
    ///         the escrow behind it locks forever.
    function test_everyChallengedVerdictHasATerminalPath() public {
        bytes32 a = keccak256("case-a");
        bytes32 b = keccak256("case-b");

        vm.prank(relayer);
        inbox.postVerdict(a, keccak256("ha"), VerdictLib.NO_BREACH, 0, 0, keccak256("txa"));
        vm.prank(relayer);
        inbox.postVerdict(b, keccak256("hb"), VerdictLib.NO_BREACH, 0, 0, keccak256("txb"));

        vm.prank(challenger);
        inbox.challenge(a);
        vm.prank(challenger);
        inbox.challenge(b);

        // One resolves canonically, one times out. Both end Final.
        _deliverCanonical(a, keccak256("ha"), VerdictLib.NO_BREACH, 0, 0);
        vm.warp(block.timestamp + CANONICAL_TIMEOUT);
        inbox.timeoutChallenge(b);

        assertEq(uint8(inbox.statusOf(a)), uint8(VerdictInbox.Status.Final));
        assertEq(uint8(inbox.statusOf(b)), uint8(VerdictInbox.Status.Final));
    }
}
