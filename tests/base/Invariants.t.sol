// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {IERC20} from "../../contracts/base/interfaces/IERC20.sol";
import {VerdictLib} from "../../contracts/shared/VerdictLib.sol";
import {ProviderStake} from "../../contracts/base/ProviderStake.sol";
import {VerdictInbox} from "../../contracts/base/VerdictInbox.sol";
import {ReputationLog} from "../../contracts/base/ReputationLog.sol";
import {WarrantyEscrow} from "../../contracts/base/WarrantyEscrow.sol";

import {MockUSDC} from "./mocks/Mocks.sol";

/// @notice Drives the protocol through random but well-formed action sequences.
///
/// @dev The handler exists because the properties worth testing here are about
///      the machine as a whole, not any single call: solvency across interleaved
///      jobs, collateral that survives concurrent disputes, terminal states that
///      stay terminal once time has moved on. A stateless fuzzer cannot reach
///      those — it has no history.
///
///      Actions are bounded to *plausible* inputs rather than valid ones. A
///      handler that only ever makes legal calls tests the happy path with extra
///      steps; the interesting sequences are the ones where a settle lands on a
///      released job, or a withdrawal races a dispute. `fail_on_revert = false`
///      lets those reverts stand as the correct outcome.
contract EscrowHandler is Test {
    MockUSDC internal immutable token;
    ProviderStake internal immutable stakeVault;
    VerdictInbox internal immutable inbox;
    WarrantyEscrow internal immutable escrow;

    address internal immutable relayer;

    /// @dev Never acts, never transacts, never receives. The stateful form of
    ///      "a verdict can never pay a non-participant".
    address public immutable bystander;

    address[3] public clients;
    address[3] public providers;

    bytes32[] public jobIds;
    mapping(bytes32 => bool) public known;

    /// @dev The escrow each job was funded with, recorded at funding so the
    ///      invariants have an independent figure to check against rather than
    ///      reading the contract's own accounting back to itself.
    mapping(bytes32 => uint256) public fundedEscrow;

    /// @dev Jobs observed in a terminal state, with the state they landed in.
    bytes32[] public terminalJobs;
    mapping(bytes32 => WarrantyEscrow.State) public terminalState;
    mapping(bytes32 => bool) public isTerminal;

    // Coverage counters — a handler whose actions all silently revert would
    // make every invariant pass vacuously.
    uint256 public funded;
    uint256 public delivered;
    uint256 public released;
    uint256 public refunded;
    uint256 public disputed;
    uint256 public settled;
    uint256 public curesOpened;
    uint256 public curesSettled;
    uint256 public slashes;

    constructor(MockUSDC token_, ProviderStake stakeVault_, VerdictInbox inbox_, WarrantyEscrow escrow_) {
        token = token_;
        stakeVault = stakeVault_;
        inbox = inbox_;
        escrow = escrow_;

        relayer = makeAddr("handlerRelayer");
        bystander = makeAddr("bystander");

        for (uint256 i = 0; i < 3; i++) {
            clients[i] = makeAddr(string.concat("handlerClient", vm.toString(i)));
            providers[i] = makeAddr(string.concat("handlerProvider", vm.toString(i)));
            _fundActor(clients[i]);
            _fundActor(providers[i]);

            // Seed collateral so providers can take work from step one.
            vm.prank(providers[i]);
            stakeVault.stake(500_000e6);
        }
        _fundActor(relayer);
    }

    function _fundActor(address who) private {
        token.mint(who, 10_000_000e6);
        vm.startPrank(who);
        token.approve(address(escrow), type(uint256).max);
        token.approve(address(stakeVault), type(uint256).max);
        token.approve(address(inbox), type(uint256).max);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Actions
    // ---------------------------------------------------------------------

    function fundJob(uint256 clientSeed, uint256 providerSeed, uint256 amount, uint256 windowSeed) external {
        address client = clients[clientSeed % 3];
        address provider = providers[providerSeed % 3];
        amount = bound(amount, 1e6, 5_000e6);
        uint64 window = uint64(bound(windowSeed, 1 hours, 30 days));

        bytes32 jobId = keccak256(abi.encode("job", jobIds.length, client, provider, amount));
        if (known[jobId]) return;

        vm.prank(client);
        try escrow.fundJob(jobId, provider, amount, window, jobIds.length) {
            jobIds.push(jobId);
            known[jobId] = true;
            fundedEscrow[jobId] = escrow.jobOf(jobId).escrowed;
            funded++;
        } catch {}
    }

    function deliver(uint256 jobSeed, bytes32 digest) external {
        bytes32 jobId = _pickJob(jobSeed);
        if (jobId == bytes32(0)) return;
        if (digest == bytes32(0)) digest = keccak256(abi.encode("transcript", jobId));

        vm.prank(escrow.jobOf(jobId).provider);
        try escrow.submitDelivery(jobId, digest, 0, bytes32(0), bytes32(0)) {
            delivered++;
        } catch {}
        _recordIfTerminal(jobId);
    }

    function release(uint256 jobSeed) external {
        bytes32 jobId = _pickJob(jobSeed);
        if (jobId == bytes32(0)) return;

        try escrow.release(jobId) {
            released++;
        } catch {}
        _recordIfTerminal(jobId);
    }

    function refundStale(uint256 jobSeed) external {
        bytes32 jobId = _pickJob(jobSeed);
        if (jobId == bytes32(0)) return;

        try escrow.refundStale(jobId) {
            refunded++;
        } catch {}
        _recordIfTerminal(jobId);
    }

    function openDispute(uint256 jobSeed) external {
        bytes32 jobId = _pickJob(jobSeed);
        if (jobId == bytes32(0)) return;

        vm.prank(escrow.jobOf(jobId).client);
        try escrow.openDispute(jobId) returns (bytes32) {
            disputed++;
        } catch {}
        _recordIfTerminal(jobId);
    }

    /// @dev Post a coherent verdict, let the challenge window lapse, finalize,
    ///      and settle — the whole uncontested relay path in one action, since
    ///      the intermediate states are the inbox's business and are covered by
    ///      its own suite.
    function resolveCase(uint256 jobSeed, uint256 codeSeed, uint256 payoutSeed, uint256 sevSeed) external {
        bytes32 jobId = _pickJob(jobSeed);
        if (jobId == bytes32(0)) return;

        WarrantyEscrow.Job memory job = escrow.jobOf(jobId);
        if (job.state != WarrantyEscrow.State.Disputed) return;
        if (job.disputesUsed == 0) return;

        bytes32 caseId = escrow.caseIdFor(jobId, job.disputesUsed - 1);
        if (inbox.statusOf(caseId) != VerdictInbox.Status.None) return;

        (uint8 code, uint16 payoutBps, uint8 severity) = _coherentVerdict(codeSeed, payoutSeed, sevSeed);

        vm.prank(relayer);
        try inbox.postVerdict(caseId, keccak256(abi.encode(caseId, code)), code, payoutBps, severity, caseId) {}
        catch {
            return;
        }

        vm.warp(block.timestamp + 2 hours);
        inbox.finalizeVerdict(caseId);

        uint256 stakedBefore = stakeVault.totalStaked(job.provider);
        try escrow.settle(jobId) {
            settled++;
            if (code == VerdictLib.EVIDENCE_UNAVAILABLE) {
                curesOpened++;
            } else if (VerdictLib.isBreach(code) && stakeVault.totalStaked(job.provider) < stakedBefore) {
                slashes++;
            }
        } catch {}
        _recordIfTerminal(jobId);
    }

    function settleAfterCure(uint256 jobSeed) external {
        bytes32 jobId = _pickJob(jobSeed);
        if (jobId == bytes32(0)) return;

        try escrow.settleAfterCure(jobId) {
            curesSettled++;
        } catch {}
        _recordIfTerminal(jobId);
    }

    function stakeMore(uint256 providerSeed, uint256 amount) external {
        address provider = providers[providerSeed % 3];
        amount = bound(amount, 1, 100_000e6);
        vm.prank(provider);
        try stakeVault.stake(amount) {} catch {}
    }

    function requestUnbond(uint256 providerSeed, uint256 amount) external {
        address provider = providers[providerSeed % 3];
        uint256 available = stakeVault.availableStake(provider);
        if (available == 0) return;
        amount = bound(amount, 1, available);
        vm.prank(provider);
        try stakeVault.requestUnbond(amount) {} catch {}
    }

    function withdrawStake(uint256 providerSeed) external {
        vm.prank(providers[providerSeed % 3]);
        try stakeVault.withdraw() {} catch {}
    }

    /// @dev Time is an input to this system, so the fuzzer has to be able to
    ///      move it. Without this action every window-gated branch is dead code.
    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1 hours, 10 days));
    }

    // ---------------------------------------------------------------------
    // Internals and views
    // ---------------------------------------------------------------------

    function _pickJob(uint256 seed) internal view returns (bytes32) {
        if (jobIds.length == 0) return bytes32(0);
        return jobIds[seed % jobIds.length];
    }

    function _coherentVerdict(uint256 codeSeed, uint256 payoutSeed, uint256 sevSeed)
        internal
        pure
        returns (uint8 code, uint16 payoutBps, uint8 severity)
    {
        // casting to 'uint8' is safe because `% 7` bounds the value to 0..6,
        // which is exactly the verdict code enum's range.
        // forge-lint: disable-next-line(unsafe-typecast)
        code = uint8(codeSeed % 7);
        if (code == VerdictLib.NO_BREACH || code == VerdictLib.EVIDENCE_UNAVAILABLE) {
            return (code, 0, 0);
        }
        uint16[4] memory buckets = [2_500, 5_000, 7_500, 10_000];
        payoutBps = buckets[payoutSeed % 4];
        severity = uint8((sevSeed % 3) + 1);
    }

    function _recordIfTerminal(bytes32 jobId) internal {
        if (isTerminal[jobId]) return;
        WarrantyEscrow.State state = escrow.stateOf(jobId);
        if (
            state == WarrantyEscrow.State.Released || state == WarrantyEscrow.State.Settled
                || state == WarrantyEscrow.State.Refunded
        ) {
            isTerminal[jobId] = true;
            terminalState[jobId] = state;
            terminalJobs.push(jobId);
        }
    }

    function jobCount() external view returns (uint256) {
        return jobIds.length;
    }

    function terminalCount() external view returns (uint256) {
        return terminalJobs.length;
    }

    function providerCount() external pure returns (uint256) {
        return 3;
    }
}

/// @notice Stateful invariants for the money contracts.
contract EscrowInvariantTest is Test {
    MockUSDC internal token;
    ProviderStake internal stakeVault;
    VerdictInbox internal inbox;
    WarrantyEscrow internal escrow;
    EscrowHandler internal handler;

    address internal warrantyVault;
    uint256 internal bystanderStart;

    function setUp() public {
        warrantyVault = makeAddr("invariantVault");

        token = new MockUSDC();
        IERC20 erc20 = IERC20(address(token));

        stakeVault = new ProviderStake(erc20, 21 days);
        inbox = new VerdictInbox(erc20, 100e6, 100e6, 2 hours, 14 days);
        ReputationLog reputation = new ReputationLog();

        escrow = new WarrantyEscrow(erc20, stakeVault, inbox, reputation, warrantyVault, 500, 5_000, 3 days, 3 days);

        stakeVault.setEscrow(address(escrow));
        reputation.setEscrow(address(escrow));
        inbox.setCanonicalReceiver(makeAddr("invariantReceiver"));

        vm.warp(1_700_000_000);

        handler = new EscrowHandler(token, stakeVault, inbox, escrow);
        bystanderStart = token.balanceOf(handler.bystander());

        targetContract(address(handler));
    }

    /// @notice Solvency, as an equality rather than an inequality. The premium
    ///         is paid out at funding, so the escrow's balance is exactly the
    ///         sum of live per-job escrow — any rounding leak, double-pay, or
    ///         missed decrement breaks this immediately.
    function invariant_escrowBalanceEqualsLiveEscrow() public view {
        assertEq(token.balanceOf(address(escrow)), escrow.totalEscrowed());
    }

    /// @notice Stake solvency: the vault holds exactly what it says providers
    ///         own, across slashes, locks and partial withdrawals.
    function invariant_stakeVaultIsFullyBacked() public view {
        uint256 sum;
        for (uint256 i = 0; i < 3; i++) {
            sum += stakeVault.totalStaked(handler.providers(i));
        }
        assertEq(token.balanceOf(address(stakeVault)), sum);
    }

    /// @notice Encumbrances can never sum past the stake behind them, so no
    ///         job is warranted by collateral that is already spoken for.
    function invariant_encumbrancesNeverExceedStake() public view {
        for (uint256 i = 0; i < 3; i++) {
            address provider = handler.providers(i);
            (uint256 pending,) = stakeVault.unbonding(provider);
            assertLe(stakeVault.locked(provider) + pending, stakeVault.totalStaked(provider));
        }
    }

    /// @notice The stateful form of "a verdict can never pay a non-participant":
    ///         an address that never touches the protocol never gains from it,
    ///         no matter what sequence of verdicts and settlements ran.
    function invariant_nonParticipantNeverGains() public view {
        assertEq(token.balanceOf(handler.bystander()), bystanderStart);
    }

    /// @notice Terminal states are terminal. Once a job has paid out, no later
    ///         verdict, cure window or settlement can move it again — which is
    ///         also what makes double-settlement unreachable.
    function invariant_terminalJobsStayTerminal() public view {
        uint256 n = handler.terminalCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 jobId = handler.terminalJobs(i);
            assertEq(uint8(escrow.stateOf(jobId)), uint8(handler.terminalState(jobId)), "terminal state changed");
            assertEq(escrow.jobOf(jobId).escrowed, 0, "terminal job still holds escrow");
        }
    }

    /// @notice Live jobs are backed and terminal jobs are drained, so the
    ///         solvency equality above cannot be satisfied by a job that zeroed
    ///         its balance without transitioning.
    function invariant_escrowBalancesMatchJobStates() public view {
        uint256 n = handler.jobCount();
        uint256 live;
        for (uint256 i = 0; i < n; i++) {
            bytes32 jobId = handler.jobIds(i);
            WarrantyEscrow.Job memory job = escrow.jobOf(jobId);
            if (
                job.state == WarrantyEscrow.State.Funded || job.state == WarrantyEscrow.State.Delivered
                    || job.state == WarrantyEscrow.State.Disputed
            ) {
                assertGt(job.escrowed, 0, "live job holds no escrow");
                live += job.escrowed;
            } else {
                assertEq(job.escrowed, 0, "closed job still holds escrow");
            }
        }
        assertEq(live, escrow.totalEscrowed());
    }

    /// @notice A job's escrow is a closed system: it holds exactly what was
    ///         funded, or nothing at all. Anything in between means a split
    ///         stranded dust or a payout drew from a neighbouring job.
    function invariant_jobEscrowIsAllOrNothing() public view {
        uint256 n = handler.jobCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 jobId = handler.jobIds(i);
            uint256 held = escrow.jobOf(jobId).escrowed;
            uint256 fundedAmount = handler.fundedEscrow(jobId);
            assertTrue(held == 0 || held == fundedAmount, "job escrow drifted from its funded amount");
        }
    }

    /// @notice A guard against vacuous success: invariants over a machine that
    ///         never moved prove nothing, and every handler action swallows its
    ///         own reverts, so a handler bug would look like a clean campaign.
    ///
    /// @dev Deliberately deterministic rather than an `afterInvariant` hook.
    ///      The hook runs after every run, and no single 64-call random sequence
    ///      is guaranteed to thread fund → deliver → dispute → resolve in order,
    ///      so asserting coverage there would flake. This drives each path
    ///      explicitly and proves the actions are reachable at all.
    function test_everyHandlerPathIsReachable() public {
        // Breach: funded → delivered → disputed → settled, with a slash.
        handler.fundJob(0, 0, 1_000e6, 7 days);
        handler.deliver(0, keccak256("t0"));
        handler.openDispute(0);
        handler.resolveCase(0, VerdictLib.UNSUPPORTED_FACT_HALLUCINATION, 3, 2);
        assertEq(handler.funded(), 1);
        assertEq(handler.delivered(), 1);
        assertEq(handler.disputed(), 1);
        assertEq(handler.settled(), 1);
        assertEq(handler.slashes(), 1, "a breach verdict did not slash");

        // Undisputed release.
        handler.fundJob(1, 0, 1_000e6, 7 days);
        handler.deliver(1, keccak256("t1"));
        handler.warp(4 days);
        handler.release(1);
        assertEq(handler.released(), 1);

        // Provider never delivered.
        handler.fundJob(2, 1, 1_000e6, 1 hours);
        handler.warp(2 days);
        handler.refundStale(2);
        assertEq(handler.refunded(), 1);

        // Evidence unavailable → cure window → release, no slash.
        handler.fundJob(0, 2, 1_000e6, 7 days);
        handler.deliver(3, keccak256("t3"));
        handler.openDispute(3);
        uint256 slashesBefore = handler.slashes();
        handler.resolveCase(3, VerdictLib.EVIDENCE_UNAVAILABLE, 0, 0);
        assertEq(handler.curesOpened(), 1, "evidence-unavailable did not open a cure window");
        handler.warp(4 days);
        handler.settleAfterCure(3);
        assertEq(handler.curesSettled(), 1);
        assertEq(handler.slashes(), slashesBefore, "unreadable evidence must never slash");

        assertEq(handler.jobCount(), 4);
        assertEq(handler.terminalCount(), 4, "every job reached a terminal state");
    }
}
