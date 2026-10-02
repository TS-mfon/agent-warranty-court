// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Fixture} from "./Fixture.sol";
import {VerdictLib} from "../../contracts/shared/VerdictLib.sol";
import {ProviderStake} from "../../contracts/base/ProviderStake.sol";
import {VerdictInbox} from "../../contracts/base/VerdictInbox.sol";
import {ReputationLog} from "../../contracts/base/ReputationLog.sol";
import {WarrantyEscrow} from "../../contracts/base/WarrantyEscrow.sol";

contract WarrantyEscrowTest is Fixture {
    bytes32 internal constant JOB = keccak256("job-1");
    bytes32 internal constant TRANSCRIPT = keccak256("transcript-bytes");

    // ---------------------------------------------------------------------
    // Funding
    // ---------------------------------------------------------------------

    function test_fundJob_splitsPremiumAndLocksStake() public {
        _stakeFor(provider, EXPECTED_STAKE_LOCK);
        _fund(JOB, JOB_AMOUNT);

        WarrantyEscrow.Job memory job = escrow.jobOf(JOB);
        assertEq(job.client, client);
        assertEq(job.provider, provider);
        assertEq(job.escrowed, EXPECTED_ESCROW);
        assertEq(job.stakeLocked, EXPECTED_STAKE_LOCK);
        assertEq(uint8(job.state), uint8(WarrantyEscrow.State.Funded));

        // The premium leaves immediately, so the escrow balance is exactly the
        // live escrow. That equality is the solvency invariant.
        assertEq(token.balanceOf(warrantyVault), EXPECTED_PREMIUM);
        assertEq(token.balanceOf(address(escrow)), EXPECTED_ESCROW);
        assertEq(escrow.totalEscrowed(), EXPECTED_ESCROW);

        assertEq(stake.locked(provider), EXPECTED_STAKE_LOCK);
        assertEq(stake.availableStake(provider), 0);
    }

    function test_fundJob_revertsWithoutProviderCollateral() public {
        _stakeFor(provider, EXPECTED_STAKE_LOCK - 1);
        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(
                ProviderStake.InsufficientAvailableStake.selector, EXPECTED_STAKE_LOCK, EXPECTED_STAKE_LOCK - 1
            )
        );
        escrow.fundJob(JOB, provider, JOB_AMOUNT, DELIVERY_WINDOW, 1);
    }

    function test_fundJob_rejectsDuplicateJobId() public {
        _stakeFor(provider, EXPECTED_STAKE_LOCK * 2);
        _fund(JOB, JOB_AMOUNT);
        vm.prank(client);
        vm.expectRevert(WarrantyEscrow.JobExists.selector);
        escrow.fundJob(JOB, provider, JOB_AMOUNT, DELIVERY_WINDOW, 1);
    }

    // ---------------------------------------------------------------------
    // Delivery and the signature gate
    // ---------------------------------------------------------------------

    function test_submitDelivery_providerDirectNeedsNoSignature() public {
        _fundedJob(JOB);
        _deliverByProvider(JOB, TRANSCRIPT);

        WarrantyEscrow.Job memory job = escrow.jobOf(JOB);
        assertEq(uint8(job.state), uint8(WarrantyEscrow.State.Delivered));
        assertEq(job.transcriptDigest, TRANSCRIPT);
    }

    function test_submitDelivery_relayedWithProviderSignature() public {
        _fundedJob(JOB);
        _deliverBySig(JOB, TRANSCRIPT);
        assertEq(escrow.jobOf(JOB).transcriptDigest, TRANSCRIPT);
    }

    /// @notice The adversarial case the signature exists for: a client trying
    ///         to fabricate evidence against an innocent provider.
    function test_submitDelivery_clientCannotForgeDelivery() public {
        _fundedJob(JOB);

        uint256 clientPk = 0xBADBEEF;
        bytes32 digest = escrow.deliveryDigestFor(JOB, TRANSCRIPT);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(clientPk, digest);

        vm.prank(client);
        vm.expectRevert(WarrantyEscrow.BadSignature.selector);
        escrow.submitDelivery(JOB, TRANSCRIPT, v, r, s);
    }

    /// @notice A signature over a *different* transcript must not authorize this
    ///         one, or the digest commitment is decorative.
    function test_submitDelivery_signatureIsBoundToTheDigest() public {
        _fundedJob(JOB);
        (uint8 v, bytes32 r, bytes32 s) = _signDelivery(JOB, TRANSCRIPT);

        vm.prank(outsider);
        vm.expectRevert(WarrantyEscrow.BadSignature.selector);
        escrow.submitDelivery(JOB, keccak256("a different transcript"), v, r, s);
    }

    function test_submitDelivery_signatureIsBoundToTheJob() public {
        _stakeFor(provider, EXPECTED_STAKE_LOCK * 2);
        _fund(JOB, JOB_AMOUNT);
        bytes32 otherJob = keccak256("job-2");
        _fund(otherJob, JOB_AMOUNT);

        (uint8 v, bytes32 r, bytes32 s) = _signDelivery(JOB, TRANSCRIPT);
        vm.prank(outsider);
        vm.expectRevert(WarrantyEscrow.BadSignature.selector);
        escrow.submitDelivery(otherJob, TRANSCRIPT, v, r, s);
    }

    /// @notice ECDSA admits a second valid signature for every message. Without
    ///         the low-`s` guard the same delivery could be presented twice
    ///         under different bytes.
    function test_submitDelivery_rejectsMalleableSignature() public {
        _fundedJob(JOB);
        (uint8 v, bytes32 r, bytes32 s) = _signDelivery(JOB, TRANSCRIPT);

        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 flippedS = bytes32(n - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;

        // Sanity: the flipped form is a genuinely valid signature for the same
        // digest, so this proves the guard rejects it rather than that the
        // bytes are garbage.
        bytes32 digest = escrow.deliveryDigestFor(JOB, TRANSCRIPT);
        assertEq(ecrecover(digest, flippedV, r, flippedS), provider, "flipped sig is not valid");

        vm.prank(outsider);
        vm.expectRevert(WarrantyEscrow.BadSignature.selector);
        escrow.submitDelivery(JOB, TRANSCRIPT, flippedV, r, flippedS);
    }

    function test_submitDelivery_rejectsBadV() public {
        _fundedJob(JOB);
        (, bytes32 r, bytes32 s) = _signDelivery(JOB, TRANSCRIPT);

        vm.prank(outsider);
        vm.expectRevert(WarrantyEscrow.BadSignature.selector);
        escrow.submitDelivery(JOB, TRANSCRIPT, 29, r, s);
    }

    function test_submitDelivery_revertsAfterDeliveryDeadline() public {
        _fundedJob(JOB);
        vm.warp(block.timestamp + DELIVERY_WINDOW + 1);
        vm.prank(provider);
        vm.expectRevert(WarrantyEscrow.DeliveryWindowPassed.selector);
        escrow.submitDelivery(JOB, TRANSCRIPT, 0, bytes32(0), bytes32(0));
    }

    // ---------------------------------------------------------------------
    // Terminal paths without a dispute
    // ---------------------------------------------------------------------

    function test_release_paysProviderAndUnlocksStake() public {
        _fundedJob(JOB);
        _deliverBySig(JOB, TRANSCRIPT);

        vm.warp(block.timestamp + ACCEPTANCE_WINDOW);
        uint256 before = token.balanceOf(provider);
        escrow.release(JOB);

        assertEq(token.balanceOf(provider) - before, EXPECTED_ESCROW);
        assertEq(uint8(escrow.stateOf(JOB)), uint8(WarrantyEscrow.State.Released));
        assertEq(stake.locked(provider), 0);
        assertEq(escrow.totalEscrowed(), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
        // Premium retained, as designed: it is an insurance cost, not a deposit.
        assertEq(token.balanceOf(warrantyVault), EXPECTED_PREMIUM);
    }

    function test_release_revertsWhileAcceptanceWindowOpen() public {
        _fundedJob(JOB);
        _deliverBySig(JOB, TRANSCRIPT);
        uint64 closesAt = escrow.jobOf(JOB).acceptanceDeadline;

        vm.expectRevert(abi.encodeWithSelector(WarrantyEscrow.AcceptanceWindowOpen.selector, closesAt));
        escrow.release(JOB);
    }

    function test_refundStale_returnsEscrowWhenProviderNeverDelivers() public {
        _fundedJob(JOB);
        vm.warp(block.timestamp + DELIVERY_WINDOW + 1);

        uint256 before = token.balanceOf(client);
        escrow.refundStale(JOB);

        assertEq(token.balanceOf(client) - before, EXPECTED_ESCROW);
        assertEq(uint8(escrow.stateOf(JOB)), uint8(WarrantyEscrow.State.Refunded));
        assertEq(stake.locked(provider), 0);
        assertEq(escrow.totalEscrowed(), 0);
    }

    function test_refundStale_revertsBeforeDeadline() public {
        _fundedJob(JOB);
        uint64 deadline = escrow.jobOf(JOB).deliveryDeadline;
        vm.expectRevert(abi.encodeWithSelector(WarrantyEscrow.DeliveryDeadlineNotPassed.selector, deadline));
        escrow.refundStale(JOB);
    }

    // ---------------------------------------------------------------------
    // Disputes
    // ---------------------------------------------------------------------

    function test_openDispute_onlyClient() public {
        _fundedJob(JOB);
        _deliverBySig(JOB, TRANSCRIPT);

        vm.prank(outsider);
        vm.expectRevert(WarrantyEscrow.NotClient.selector);
        escrow.openDispute(JOB);

        vm.prank(provider);
        vm.expectRevert(WarrantyEscrow.NotClient.selector);
        escrow.openDispute(JOB);
    }

    function test_openDispute_revertsAfterAcceptanceWindow() public {
        _fundedJob(JOB);
        _deliverBySig(JOB, TRANSCRIPT);
        uint64 closedAt = escrow.jobOf(JOB).acceptanceDeadline;

        vm.warp(closedAt + 1);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(WarrantyEscrow.AcceptanceWindowClosed.selector, closedAt));
        escrow.openDispute(JOB);
    }

    function test_openDispute_freezesProviderUnbonding() public {
        _stakeFor(provider, EXPECTED_STAKE_LOCK * 3);
        _fund(JOB, JOB_AMOUNT);
        _deliverBySig(JOB, TRANSCRIPT);
        _dispute(JOB);

        assertEq(stake.openDisputes(provider), 1);

        // The adversarial case from the plan: a provider trying to pull
        // collateral out from under a live dispute.
        vm.prank(provider);
        vm.expectRevert(ProviderStake.DisputeOpen.selector);
        stake.requestUnbond(1e6);
    }

    function test_settle_breachRefundsClientSlashesProviderAndLogsReputation() public {
        _fundedJob(JOB);
        _deliverBySig(JOB, TRANSCRIPT);
        bytes32 caseId = _dispute(JOB);
        _postAndFinalize(caseId, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);

        uint256 clientBefore = token.balanceOf(client);
        uint256 providerBefore = token.balanceOf(provider);

        uint256 expectedRefund = EXPECTED_ESCROW / 2; // 5000 bps
        uint256 expectedSlash = (EXPECTED_ESCROW * 2_500) / 10_000; // severity 2

        vm.expectEmit(true, true, true, true, address(reputation));
        emit ReputationLog.BreachRecorded(
            provider,
            client,
            caseId,
            1,
            VerdictLib.DEAD_LINK_CITATION,
            2,
            25,
            _verdictHash(caseId, VerdictLib.DEAD_LINK_CITATION, 5_000, 2),
            ""
        );
        escrow.settle(JOB);

        // Refund plus slash both land on the client; the provider keeps the
        // unrefunded half of the fee.
        assertEq(token.balanceOf(client) - clientBefore, expectedRefund + expectedSlash);
        assertEq(token.balanceOf(provider) - providerBefore, EXPECTED_ESCROW - expectedRefund);

        assertEq(uint8(escrow.stateOf(JOB)), uint8(WarrantyEscrow.State.Settled));
        assertEq(escrow.totalEscrowed(), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(stake.locked(provider), 0);
        assertEq(stake.openDisputes(provider), 0);
        assertEq(stake.totalStaked(provider), EXPECTED_STAKE_LOCK - expectedSlash);
    }

    function test_settle_noBreachPaysProviderAndDoesNotSlash() public {
        _fundedJob(JOB);
        _deliverBySig(JOB, TRANSCRIPT);
        bytes32 caseId = _dispute(JOB);
        _postAndFinalize(caseId, VerdictLib.NO_BREACH, 0, 0);

        uint256 providerBefore = token.balanceOf(provider);
        escrow.settle(JOB);

        assertEq(token.balanceOf(provider) - providerBefore, EXPECTED_ESCROW);
        assertEq(stake.totalStaked(provider), EXPECTED_STAKE_LOCK);
        assertEq(stake.locked(provider), 0);
        assertEq(stake.openDisputes(provider), 0);
    }

    function test_settle_severity3SlashExactlyExhaustsLockedCollateral() public {
        _fundedJob(JOB);
        _deliverBySig(JOB, TRANSCRIPT);
        bytes32 caseId = _dispute(JOB);
        _postAndFinalize(caseId, VerdictLib.SILENT_FAILURE, 10_000, 3);

        escrow.settle(JOB);

        // requiredStakeBps == maxSlashBps == 5000, so the worst verdict the
        // court can issue is exactly covered — never short, never over.
        assertEq(stake.totalStaked(provider), 0);
        assertEq(stake.locked(provider), 0);
    }

    function test_settle_revertsBeforeVerdictIsFinal() public {
        _fundedJob(JOB);
        _deliverBySig(JOB, TRANSCRIPT);
        bytes32 caseId = _dispute(JOB);
        _post(caseId, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);

        // Posted but still inside the challenge window.
        vm.expectRevert(
            abi.encodeWithSelector(VerdictInbox.VerdictNotFinal.selector, VerdictInbox.Status.Posted)
        );
        escrow.settle(JOB);
    }

    function test_settle_cannotSettleTwice() public {
        _fundedJob(JOB);
        _deliverBySig(JOB, TRANSCRIPT);
        bytes32 caseId = _dispute(JOB);
        _postAndFinalize(caseId, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);
        escrow.settle(JOB);

        vm.expectRevert(
            abi.encodeWithSelector(
                WarrantyEscrow.WrongState.selector, WarrantyEscrow.State.Settled, WarrantyEscrow.State.Disputed
            )
        );
        escrow.settle(JOB);
    }

    // ---------------------------------------------------------------------
    // Evidence unavailable: the cure window
    // ---------------------------------------------------------------------

    function test_evidenceUnavailable_opensCureWindowAndNeverSlashes() public {
        _fundedJob(JOB);
        _deliverBySig(JOB, TRANSCRIPT);
        bytes32 caseId = _dispute(JOB);
        _postAndFinalize(caseId, VerdictLib.EVIDENCE_UNAVAILABLE, 0, 0);

        escrow.settle(JOB);

        // Still disputed — a court that could not read the evidence has not
        // made a finding, so nothing settles yet.
        assertEq(uint8(escrow.stateOf(JOB)), uint8(WarrantyEscrow.State.Disputed));
        assertGt(escrow.jobOf(JOB).cureDeadline, block.timestamp);
        assertEq(stake.totalStaked(provider), EXPECTED_STAKE_LOCK);
        assertEq(escrow.totalEscrowed(), EXPECTED_ESCROW);
    }

    function test_settleAfterCure_releasesToProviderWithoutSlashing() public {
        _fundedJob(JOB);
        _deliverBySig(JOB, TRANSCRIPT);
        bytes32 caseId = _dispute(JOB);
        _postAndFinalize(caseId, VerdictLib.EVIDENCE_UNAVAILABLE, 0, 0);
        escrow.settle(JOB);

        vm.warp(escrow.jobOf(JOB).cureDeadline + 1);
        uint256 providerBefore = token.balanceOf(provider);
        escrow.settleAfterCure(JOB);

        assertEq(token.balanceOf(provider) - providerBefore, EXPECTED_ESCROW);
        assertEq(uint8(escrow.stateOf(JOB)), uint8(WarrantyEscrow.State.Released));
        assertEq(stake.totalStaked(provider), EXPECTED_STAKE_LOCK);
        assertEq(stake.openDisputes(provider), 0);
    }

    function test_settleAfterCure_revertsWhileCureWindowOpen() public {
        _fundedJob(JOB);
        _deliverBySig(JOB, TRANSCRIPT);
        bytes32 caseId = _dispute(JOB);
        _postAndFinalize(caseId, VerdictLib.EVIDENCE_UNAVAILABLE, 0, 0);
        escrow.settle(JOB);

        uint64 closesAt = escrow.jobOf(JOB).cureDeadline;
        vm.expectRevert(abi.encodeWithSelector(WarrantyEscrow.CureWindowOpen.selector, closesAt));
        escrow.settleAfterCure(JOB);
    }

    /// @notice The client's second bite. Without it, a transcript host that
    ///         happened to be down would defeat a legitimate claim outright.
    function test_cureWindow_allowsExactlyOneRedisputeThatCanFindBreach() public {
        _fundedJob(JOB);
        _deliverBySig(JOB, TRANSCRIPT);
        bytes32 caseId0 = _dispute(JOB);
        _postAndFinalize(caseId0, VerdictLib.EVIDENCE_UNAVAILABLE, 0, 0);
        escrow.settle(JOB);

        // Re-dispute inside the cure window gets a fresh case id, so the second
        // verdict does not collide with the first in the inbox.
        bytes32 caseId1 = _dispute(JOB);
        assertTrue(caseId1 != caseId0);
        assertEq(caseId1, escrow.caseIdFor(JOB, 1));

        _postAndFinalize(caseId1, VerdictLib.DEAD_LINK_CITATION, 7_500, 3);

        uint256 clientBefore = token.balanceOf(client);
        escrow.settle(JOB);

        uint256 expectedRefund = (EXPECTED_ESCROW * 7_500) / 10_000;
        uint256 expectedSlash = (EXPECTED_ESCROW * 5_000) / 10_000;
        assertEq(token.balanceOf(client) - clientBefore, expectedRefund + expectedSlash);
        assertEq(uint8(escrow.stateOf(JOB)), uint8(WarrantyEscrow.State.Settled));
        // Counted once for the whole lifecycle, cleared once.
        assertEq(stake.openDisputes(provider), 0);
    }

    function test_cureWindow_rejectsAThirdDispute() public {
        _fundedJob(JOB);
        _deliverBySig(JOB, TRANSCRIPT);
        bytes32 caseId0 = _dispute(JOB);
        _postAndFinalize(caseId0, VerdictLib.EVIDENCE_UNAVAILABLE, 0, 0);
        escrow.settle(JOB);

        bytes32 caseId1 = _dispute(JOB);
        _postAndFinalize(caseId1, VerdictLib.EVIDENCE_UNAVAILABLE, 0, 0);
        escrow.settle(JOB);

        vm.prank(client);
        vm.expectRevert(WarrantyEscrow.DisputeLimitReached.selector);
        escrow.openDispute(JOB);
    }

    function test_cureWindow_redisputeRejectedAfterWindowCloses() public {
        _fundedJob(JOB);
        _deliverBySig(JOB, TRANSCRIPT);
        bytes32 caseId = _dispute(JOB);
        _postAndFinalize(caseId, VerdictLib.EVIDENCE_UNAVAILABLE, 0, 0);
        escrow.settle(JOB);

        uint64 closedAt = escrow.jobOf(JOB).cureDeadline;
        vm.warp(closedAt + 1);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(WarrantyEscrow.CureWindowClosed.selector, closedAt));
        escrow.openDispute(JOB);
    }

    // ---------------------------------------------------------------------
    // Fuzzed invariants on the settlement arithmetic
    // ---------------------------------------------------------------------

    /// @notice Invariant 2: the split is exact for every bucket and amount.
    ///         No rounding may mint or strand value.
    function testFuzz_settlementSplitIsExact(uint256 amount, uint8 bucketIndex) public {
        amount = bound(amount, 1e6, 100_000e6);
        uint16[5] memory buckets = [0, 2_500, 5_000, 7_500, 10_000];
        uint16 payoutBps = buckets[bound(bucketIndex, 0, 4)];

        uint256 premium = (amount * PREMIUM_BPS) / 10_000;
        uint256 escrowed = amount - premium;
        uint256 required = (escrowed * REQUIRED_STAKE_BPS) / 10_000;

        _stakeFor(provider, required);
        vm.prank(client);
        escrow.fundJob(JOB, provider, amount, DELIVERY_WINDOW, 1);
        _deliverBySig(JOB, TRANSCRIPT);
        bytes32 caseId = _dispute(JOB);

        // Keep the verdict coherent: a non-zero payout implies a breach.
        uint8 code = payoutBps == 0 ? VerdictLib.NO_BREACH : VerdictLib.SCHEMA_MALFORMED_OUTPUT;
        uint8 severity = payoutBps == 0 ? 0 : 1;
        _postAndFinalize(caseId, code, payoutBps, severity);

        uint256 clientBefore = token.balanceOf(client);
        uint256 providerBefore = token.balanceOf(provider);
        escrow.settle(JOB);

        uint256 clientGain = token.balanceOf(client) - clientBefore;
        uint256 providerGain = token.balanceOf(provider) - providerBefore;
        uint256 slash = payoutBps == 0 ? 0 : (escrowed * 1_000) / 10_000;

        // Escrow is conserved exactly, and the escrow contract is left empty.
        assertEq(clientGain - slash + providerGain, escrowed, "escrow not conserved");
        assertEq(token.balanceOf(address(escrow)), 0, "escrow retained dust");
        assertEq(escrow.totalEscrowed(), 0);
    }

    /// @notice Invariant 3: only bucket values can ever reach settlement.
    function testFuzz_inboxRejectsNonBucketPayouts(uint16 payoutBps) public {
        vm.assume(!VerdictLib.isBucket(payoutBps));
        bytes32 caseId = keccak256("standalone");

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                VerdictInbox.IncoherentVerdict.selector, VerdictLib.DEAD_LINK_CITATION, payoutBps, 2
            )
        );
        inbox.postVerdict(caseId, keccak256("h"), VerdictLib.DEAD_LINK_CITATION, payoutBps, 2, keccak256("tx"));
    }

    /// @notice Invariant 1, stated as a property: the escrow's token balance
    ///         only ever moves to the job's own two parties. Any third address
    ///         gains nothing, whatever verdict is posted.
    function testFuzz_settlementNeverPaysANonParticipant(uint8 codeSeed, uint8 bucketIndex) public {
        _fundedJob(JOB);
        _deliverBySig(JOB, TRANSCRIPT);
        bytes32 caseId = _dispute(JOB);

        uint16[5] memory buckets = [0, 2_500, 5_000, 7_500, 10_000];
        uint16 payoutBps = buckets[bound(bucketIndex, 1, 4)];
        uint8 code = uint8(bound(codeSeed, 1, 5)); // any breach code
        uint8 severity = uint8(bound(uint256(codeSeed), 1, 3));

        _postAndFinalize(caseId, code, payoutBps, severity);

        uint256 outsiderBefore = token.balanceOf(outsider);
        uint256 vaultBefore = token.balanceOf(warrantyVault);
        uint256 relayerBefore = token.balanceOf(relayer);

        escrow.settle(JOB);

        assertEq(token.balanceOf(outsider), outsiderBefore, "outsider was paid");
        assertEq(token.balanceOf(warrantyVault), vaultBefore, "vault took settlement funds");
        assertEq(token.balanceOf(relayer), relayerBefore, "relayer took settlement funds");
    }
}
