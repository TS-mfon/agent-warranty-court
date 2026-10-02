// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Fixture} from "./Fixture.sol";
import {IERC20} from "../../contracts/base/interfaces/IERC20.sol";
import {VerdictLib} from "../../contracts/shared/VerdictLib.sol";
import {ProviderStake} from "../../contracts/base/ProviderStake.sol";

/// @notice Collateral mechanics.
///
/// @dev Most tests run against `bare`, a second `ProviderStake` whose escrow is
///      this test contract, so the escrow-only surface (`lock`, `slash`,
///      `disputeOpened`) can be driven directly without staging a whole job.
///      The freeze tests at the bottom use the fixture's real wiring instead,
///      because what they assert is precisely that the escrow pairs those calls
///      correctly across a full dispute.
contract ProviderStakeTest is Fixture {
    ProviderStake internal bare;

    bytes32 internal constant JOB = keccak256("job-1");
    bytes32 internal constant TRANSCRIPT = keccak256("transcript-1");

    function setUp() public override {
        super.setUp();
        bare = new ProviderStake(IERC20(address(token)), UNBONDING_DELAY);
        bare.setEscrow(address(this));

        vm.prank(provider);
        token.approve(address(bare), type(uint256).max);
    }

    function _bareStake(uint256 amount) internal {
        vm.prank(provider);
        bare.stake(amount);
    }

    // ---------------------------------------------------------------------
    // Construction and wiring
    // ---------------------------------------------------------------------

    /// @notice The delay floor is a safety property, not a default: a short
    ///         delay lets a provider withdraw before a dispute can resolve.
    function test_constructor_enforcesUnbondingFloor() public {
        vm.expectRevert(ProviderStake.UnbondingDelayTooShort.selector);
        new ProviderStake(IERC20(address(token)), uint64(21 days) - 1);

        ProviderStake ok = new ProviderStake(IERC20(address(token)), 21 days);
        assertEq(ok.unbondingDelay(), 21 days);
    }

    function test_constructor_rejectsZeroToken() public {
        vm.expectRevert(ProviderStake.ZeroAddress.selector);
        new ProviderStake(IERC20(address(0)), UNBONDING_DELAY);
    }

    function test_setEscrow_isOneShotAndNonZero() public {
        ProviderStake fresh = new ProviderStake(IERC20(address(token)), UNBONDING_DELAY);

        vm.expectRevert(ProviderStake.ZeroAddress.selector);
        fresh.setEscrow(address(0));

        fresh.setEscrow(address(this));
        vm.expectRevert(ProviderStake.EscrowAlreadySet.selector);
        fresh.setEscrow(outsider);
    }

    /// @notice Every escrow-only entry point must actually be escrow-only; one
    ///         unguarded function is a complete drain.
    function test_escrowOnlySurfaceIsClosed() public {
        _bareStake(1_000e6);

        vm.startPrank(outsider);
        vm.expectRevert(ProviderStake.NotEscrow.selector);
        bare.lock(provider, 1);
        vm.expectRevert(ProviderStake.NotEscrow.selector);
        bare.unlock(provider, 1);
        vm.expectRevert(ProviderStake.NotEscrow.selector);
        bare.slash(provider, 1, outsider);
        vm.expectRevert(ProviderStake.NotEscrow.selector);
        bare.disputeOpened(provider);
        vm.expectRevert(ProviderStake.NotEscrow.selector);
        bare.disputeClosed(provider);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Staking and availability
    // ---------------------------------------------------------------------

    function test_stake_pullsTokensAndCredits() public {
        uint256 before = token.balanceOf(provider);
        _bareStake(1_000e6);

        assertEq(bare.totalStaked(provider), 1_000e6);
        assertEq(bare.availableStake(provider), 1_000e6);
        assertEq(before - token.balanceOf(provider), 1_000e6);
        assertEq(token.balanceOf(address(bare)), 1_000e6);
    }

    function test_stake_rejectsZero() public {
        vm.prank(provider);
        vm.expectRevert(ProviderStake.ZeroAmount.selector);
        bare.stake(0);
    }

    function test_availableStake_nettsLockedAndUnbonding() public {
        _bareStake(1_000e6);
        bare.lock(provider, 400e6);
        assertEq(bare.availableStake(provider), 600e6);

        vm.prank(provider);
        bare.requestUnbond(250e6);
        assertEq(bare.availableStake(provider), 350e6);
        // Neither encumbrance moved the headline figure.
        assertEq(bare.totalStaked(provider), 1_000e6);
    }

    // ---------------------------------------------------------------------
    // Locking
    // ---------------------------------------------------------------------

    /// @notice Without this bound a provider could underwrite unlimited work
    ///         against a single job's worth of collateral.
    function test_lock_cannotExceedAvailable() public {
        _bareStake(1_000e6);
        bare.lock(provider, 600e6);

        vm.expectRevert(abi.encodeWithSelector(ProviderStake.InsufficientAvailableStake.selector, 500e6, 400e6));
        bare.lock(provider, 500e6);

        // Exactly the remainder is fine.
        bare.lock(provider, 400e6);
        assertEq(bare.locked(provider), 1_000e6);
        assertEq(bare.availableStake(provider), 0);
    }

    /// @notice Unbonding stake is not lockable: it is on its way out, and
    ///         lending it to a new job would warrant work with money the
    ///         provider is already entitled to withdraw.
    function test_lock_cannotReachUnbondingStake() public {
        _bareStake(1_000e6);
        vm.prank(provider);
        bare.requestUnbond(700e6);

        vm.expectRevert(abi.encodeWithSelector(ProviderStake.InsufficientAvailableStake.selector, 400e6, 300e6));
        bare.lock(provider, 400e6);
    }

    function test_unlock_boundedByLocked() public {
        _bareStake(1_000e6);
        bare.lock(provider, 400e6);

        vm.expectRevert(abi.encodeWithSelector(ProviderStake.InsufficientLockedStake.selector, 401e6, 400e6));
        bare.unlock(provider, 401e6);

        bare.unlock(provider, 400e6);
        assertEq(bare.locked(provider), 0);
        assertEq(bare.availableStake(provider), 1_000e6);
    }

    // ---------------------------------------------------------------------
    // Unbonding
    // ---------------------------------------------------------------------

    function test_requestUnbond_startsTheClock() public {
        _bareStake(1_000e6);
        vm.prank(provider);
        bare.requestUnbond(1_000e6);

        (uint256 amount, uint64 readyAt) = bare.unbonding(provider);
        assertEq(amount, 1_000e6);
        assertEq(readyAt, uint64(block.timestamp) + UNBONDING_DELAY);
    }

    function test_requestUnbond_rejectsZeroAndOverdraw() public {
        _bareStake(1_000e6);
        bare.lock(provider, 600e6);

        vm.prank(provider);
        vm.expectRevert(ProviderStake.ZeroAmount.selector);
        bare.requestUnbond(0);

        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(ProviderStake.InsufficientAvailableStake.selector, 401e6, 400e6));
        bare.requestUnbond(401e6);
    }

    /// @notice One request at a time, or a second request would silently
    ///         overwrite the first one's clock and reset the delay.
    function test_requestUnbond_rejectsSecondRequest() public {
        _bareStake(1_000e6);
        vm.startPrank(provider);
        bare.requestUnbond(100e6);
        vm.expectRevert(ProviderStake.UnbondingAlreadyPending.selector);
        bare.requestUnbond(100e6);
        vm.stopPrank();
    }

    function test_cancelUnbond_returnsStakeToActiveDuty() public {
        _bareStake(1_000e6);
        vm.startPrank(provider);
        bare.requestUnbond(1_000e6);
        assertEq(bare.availableStake(provider), 0);
        bare.cancelUnbond();
        vm.stopPrank();

        assertEq(bare.availableStake(provider), 1_000e6);
        (uint256 amount,) = bare.unbonding(provider);
        assertEq(amount, 0);

        // And the stake can immediately back new work again.
        bare.lock(provider, 1_000e6);
        assertEq(bare.locked(provider), 1_000e6);
    }

    function test_cancelUnbond_revertsWithoutRequest() public {
        vm.prank(provider);
        vm.expectRevert(ProviderStake.NoUnbondingRequest.selector);
        bare.cancelUnbond();
    }

    function test_withdraw_revertsBeforeReady() public {
        _bareStake(1_000e6);
        vm.prank(provider);
        bare.requestUnbond(1_000e6);
        (, uint64 readyAt) = bare.unbonding(provider);

        vm.warp(readyAt - 1);
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(ProviderStake.UnbondingNotReady.selector, readyAt));
        bare.withdraw();
    }

    function test_withdraw_revertsWithoutRequest() public {
        _bareStake(1_000e6);
        vm.prank(provider);
        vm.expectRevert(ProviderStake.NoUnbondingRequest.selector);
        bare.withdraw();
    }

    function test_withdraw_paysAndClearsRequest() public {
        _bareStake(1_000e6);
        vm.prank(provider);
        bare.requestUnbond(600e6);

        uint256 before = token.balanceOf(provider);
        vm.warp(block.timestamp + UNBONDING_DELAY);
        vm.prank(provider);
        bare.withdraw();

        assertEq(token.balanceOf(provider) - before, 600e6);
        assertEq(bare.totalStaked(provider), 400e6);
        (uint256 amount,) = bare.unbonding(provider);
        assertEq(amount, 0);
        // Withdrawing is not a second unbond: what stays is immediately free.
        assertEq(bare.availableStake(provider), 400e6);
    }

    /// @notice `requestUnbond` only proves no dispute was open when the clock
    ///         started. Without the second check in `withdraw`, a provider
    ///         could unbond pre-emptively on day 0 and walk out through a
    ///         dispute filed on day 1.
    function test_withdraw_blockedByDisputeOpenedAfterTheClockStarted() public {
        _bareStake(1_000e6);
        vm.prank(provider);
        bare.requestUnbond(1_000e6);

        bare.disputeOpened(provider);
        vm.warp(block.timestamp + UNBONDING_DELAY);

        vm.prank(provider);
        vm.expectRevert(ProviderStake.DisputeOpen.selector);
        bare.withdraw();

        // The request survives, so the provider is not forced to restart the
        // clock once the dispute clears.
        bare.disputeClosed(provider);
        vm.prank(provider);
        bare.withdraw();
        assertEq(bare.totalStaked(provider), 0);
    }

    function test_requestUnbond_blockedWhileDisputeOpen() public {
        _bareStake(1_000e6);
        bare.disputeOpened(provider);

        vm.prank(provider);
        vm.expectRevert(ProviderStake.DisputeOpen.selector);
        bare.requestUnbond(1_000e6);
    }

    /// @notice Concurrent disputes must all clear before the clock can start,
    ///         or the second dispute's collateral leaves with the first
    ///         dispute's resolution.
    function test_disputeCounter_requiresEveryDisputeToClose() public {
        _bareStake(1_000e6);
        bare.disputeOpened(provider);
        bare.disputeOpened(provider);
        bare.disputeClosed(provider);
        assertEq(bare.openDisputes(provider), 1);

        vm.prank(provider);
        vm.expectRevert(ProviderStake.DisputeOpen.selector);
        bare.requestUnbond(1_000e6);

        bare.disputeClosed(provider);
        vm.prank(provider);
        bare.requestUnbond(1_000e6);
    }

    /// @notice An unchecked decrement would underflow to `type(uint256).max`
    ///         and freeze the provider's stake permanently.
    function test_disputeClosed_doesNotUnderflowAtZero() public {
        bare.disputeClosed(provider);
        assertEq(bare.openDisputes(provider), 0);
    }

    // ---------------------------------------------------------------------
    // Slashing
    // ---------------------------------------------------------------------

    function test_slash_movesLockedCollateralAndReportsTheAmount() public {
        _bareStake(1_000e6);
        bare.lock(provider, 400e6);

        uint256 before = token.balanceOf(client);
        uint256 slashed = bare.slash(provider, 250e6, client);

        assertEq(slashed, 250e6);
        assertEq(token.balanceOf(client) - before, 250e6);
        assertEq(bare.locked(provider), 150e6);
        assertEq(bare.totalStaked(provider), 750e6);
        // Free stake is untouched: 750 total - 150 still locked.
        assertEq(bare.availableStake(provider), 600e6);
    }

    /// @notice The central collateral invariant: a verdict on one job can never
    ///         reach free stake, unbonding stake, or another job's collateral.
    function test_slash_cannotReachAnythingButLockedCollateral() public {
        _bareStake(1_000e6);
        bare.lock(provider, 300e6);
        vm.prank(provider);
        bare.requestUnbond(500e6);

        uint256 slashed = bare.slash(provider, 1_000e6, client);

        assertEq(slashed, 300e6, "slash is capped at locked collateral");
        assertEq(bare.locked(provider), 0);
        assertEq(bare.totalStaked(provider), 700e6);
        (uint256 unbondAmount,) = bare.unbonding(provider);
        assertEq(unbondAmount, 500e6, "unbonding request untouched");
        assertEq(bare.availableStake(provider), 200e6);
    }

    function test_slash_withNothingLockedIsANoOp() public {
        _bareStake(1_000e6);
        uint256 before = token.balanceOf(client);

        assertEq(bare.slash(provider, 500e6, client), 0);
        assertEq(token.balanceOf(client), before);
        assertEq(bare.totalStaked(provider), 1_000e6);
    }

    function test_slash_rejectsZeroRecipient() public {
        _bareStake(1_000e6);
        bare.lock(provider, 400e6);
        vm.expectRevert(ProviderStake.ZeroAddress.selector);
        bare.slash(provider, 100e6, address(0));
    }

    /// @notice Solvency: a full slash of locked collateral still leaves exactly
    ///         the unbonding request behind it, so the withdrawal clamp in
    ///         `withdraw` stays defensive rather than load-bearing.
    function test_slash_leavesUnbondingRequestFullyBacked() public {
        _bareStake(1_000e6);
        bare.lock(provider, 400e6);
        vm.prank(provider);
        bare.requestUnbond(600e6);

        bare.slash(provider, 400e6, client);
        assertEq(bare.totalStaked(provider), 600e6);

        vm.warp(block.timestamp + UNBONDING_DELAY);
        uint256 before = token.balanceOf(provider);
        vm.prank(provider);
        bare.withdraw();

        assertEq(token.balanceOf(provider) - before, 600e6);
        assertEq(bare.totalStaked(provider), 0);
        assertEq(token.balanceOf(address(bare)), 0, "contract fully drained, nothing stranded");
    }

    // ---------------------------------------------------------------------
    // Properties
    // ---------------------------------------------------------------------

    function testFuzz_slashNeverExceedsLockedCollateral(uint256 staked, uint256 lockAmount, uint256 slashAmount)
        public
    {
        staked = bound(staked, 1, 1_000_000e6);
        lockAmount = bound(lockAmount, 0, staked);

        _bareStake(staked);
        if (lockAmount != 0) bare.lock(provider, lockAmount);

        uint256 slashed = bare.slash(provider, slashAmount, client);

        assertLe(slashed, lockAmount, "slash exceeded locked collateral");
        assertLe(slashed, slashAmount, "slash exceeded the requested amount");
        assertEq(bare.totalStaked(provider), staked - slashed);
        assertEq(bare.locked(provider), lockAmount - slashed);
    }

    /// @notice Encumbrances can never sum past the stake behind them, so
    ///         `availableStake` is a real balance and not an accounting fiction.
    function testFuzz_encumbrancesNeverExceedStake(uint256 staked, uint256 lockAmount, uint256 unbondAmount) public {
        staked = bound(staked, 1, 1_000_000e6);
        lockAmount = bound(lockAmount, 0, staked);
        unbondAmount = bound(unbondAmount, 0, staked - lockAmount);

        _bareStake(staked);
        if (lockAmount != 0) bare.lock(provider, lockAmount);
        if (unbondAmount != 0) {
            vm.prank(provider);
            bare.requestUnbond(unbondAmount);
        }

        (uint256 pending,) = bare.unbonding(provider);
        assertLe(bare.locked(provider) + pending, bare.totalStaked(provider));
        assertEq(bare.availableStake(provider), staked - lockAmount - unbondAmount);
        assertEq(token.balanceOf(address(bare)), bare.totalStaked(provider));
    }

    // ---------------------------------------------------------------------
    // Integration: the freeze the escrow is responsible for pairing
    // ---------------------------------------------------------------------

    /// @notice Adversarial case from the plan: a provider tries to pull its
    ///         stake out from under a live dispute. Run against the real escrow
    ///         because the property under test is that the escrow opens and
    ///         closes the counter in matched pairs across a whole case.
    function test_providerCannotWithdrawStakeMidDispute() public {
        _stakeFor(provider, 1_000e6);
        _fund(JOB, JOB_AMOUNT);
        assertEq(stake.locked(provider), EXPECTED_STAKE_LOCK);

        // Clock started while everything was quiet.
        vm.prank(provider);
        stake.requestUnbond(1_000e6 - EXPECTED_STAKE_LOCK);

        _deliverBySig(JOB, TRANSCRIPT);
        bytes32 caseId = _dispute(JOB);
        assertEq(stake.openDisputes(provider), 1);

        vm.warp(block.timestamp + UNBONDING_DELAY);
        vm.prank(provider);
        vm.expectRevert(ProviderStake.DisputeOpen.selector);
        stake.withdraw();

        // Acquitted: the counter clears, collateral unlocks, stake is free.
        _postAndFinalize(caseId, VerdictLib.NO_BREACH, 0, 0);
        escrow.settle(JOB);

        assertEq(stake.openDisputes(provider), 0);
        assertEq(stake.locked(provider), 0);

        uint256 before = token.balanceOf(provider);
        vm.prank(provider);
        stake.withdraw();
        assertEq(token.balanceOf(provider) - before, 1_000e6 - EXPECTED_STAKE_LOCK);
    }

    /// @notice The counter must also clear on the paths that do slash, or an
    ///         adjudicated provider is frozen out of the protocol forever.
    function test_disputeCounterClearsOnABreachVerdictToo() public {
        // Deliberately over-staked: a maximal breach consumes this job's
        // collateral entirely, and stake left at zero would make the closing
        // assertion pass for the wrong reason.
        _stakeFor(provider, EXPECTED_STAKE_LOCK + 500e6);
        _fund(JOB, JOB_AMOUNT);
        _deliverBySig(JOB, TRANSCRIPT);
        bytes32 caseId = _dispute(JOB);

        _postAndFinalize(caseId, VerdictLib.SILENT_FAILURE, 10_000, 3);
        escrow.settle(JOB);

        assertEq(stake.openDisputes(provider), 0);
        assertEq(stake.locked(provider), 0, "no collateral left stranded");

        // Not frozen: the surviving stake can still start an unbonding clock.
        uint256 remaining = stake.availableStake(provider);
        assertGt(remaining, 0);
        vm.prank(provider);
        stake.requestUnbond(remaining);
    }
}
