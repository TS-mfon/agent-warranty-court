// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "./interfaces/IERC20.sol";
import {SafeTransfer} from "./libraries/SafeTransfer.sol";
import {VerdictLib} from "../shared/VerdictLib.sol";
import {ProviderStake} from "./ProviderStake.sol";
import {VerdictInbox} from "./VerdictInbox.sol";
import {ReputationLog} from "./ReputationLog.sol";

/// @title WarrantyEscrow
/// @notice Holds the job fee and settles it against a finalized GenLayer verdict.
///
/// @dev This contract is the reason the design is safe to run without a human
///      in the release path. The court decides *whether* a breach occurred; the
///      rules a verdict can never bend live here, in Solidity:
///
///      1. A payout recipient is only ever `job.client` or `job.provider`. No
///         address is an input to settlement, so no verdict — however it was
///         reached, and however thoroughly the model was injected — can name a
///         new one.
///      2. `refund + providerCut == job.escrowed`, exactly. Per-case funds are
///         a closed system.
///      3. `payoutBps` is re-checked against the closed bucket set.
///      4. Terminal states are terminal. A settled job cannot settle again.
///      5. Slashed collateral is drawn only from stake locked to *this* job.
///
///      A fully compromised relayer, therefore, has a blast radius bounded by
///      "moves this job's own escrow between this job's own two parties".
///
///      ## Identity of a case
///
///      `caseId = keccak256(jobId, disputeIndex)` rather than `caseId == jobId`.
///      The inbox stores one verdict per case forever, so reusing the jobId
///      would make the cure-window re-dispute unpostable — the second verdict
///      would collide with the first and the client's second bite would be
///      silently impossible.
contract WarrantyEscrow {
    using SafeTransfer for IERC20;

    enum State {
        None,
        Funded,
        Delivered,
        Disputed,
        Released,
        Settled,
        Refunded
    }

    struct Job {
        address client;
        address provider;
        uint256 escrowed;
        uint256 stakeLocked;
        uint256 erc8004TokenId;
        bytes32 transcriptDigest;
        uint64 deliveryDeadline;
        uint64 acceptanceDeadline;
        uint64 cureDeadline;
        uint8 disputesUsed;
        State state;
    }

    /// @dev Domain-separates the delivery signature by chain and deployment, so
    ///      a signature harvested from a testnet or an earlier deployment
    ///      cannot be replayed here.
    bytes32 public constant DELIVERY_TYPEHASH =
        keccak256("AgentWarrantyCourtDelivery(uint256 chainId,address escrow,bytes32 jobId,bytes32 transcriptDigest)");

    /// @dev Initial dispute plus exactly one re-dispute inside the cure window.
    uint8 public constant MAX_DISPUTES = 2;

    IERC20 public immutable token;
    ProviderStake public immutable stakeVault;
    VerdictInbox public immutable inbox;
    ReputationLog public immutable reputation;

    /// @notice Where the warranty premium accrues.
    /// @dev Paid out at funding time and never held here, so this contract's
    ///      token balance is exactly the sum of live per-job escrow. That makes
    ///      the solvency invariant an equality rather than an inequality, and
    ///      an equality is a thing a fuzzer can actually break.
    address public immutable warrantyVault;

    uint16 public immutable premiumBps;
    uint16 public immutable requiredStakeBps;
    uint64 public immutable acceptanceWindow;
    uint64 public immutable cureWindow;

    mapping(bytes32 => Job) private _jobs;
    uint256 public totalEscrowed;

    uint256 private _reentrancyGuard = 1;

    event JobFunded(
        bytes32 indexed jobId,
        address indexed client,
        address indexed provider,
        uint256 escrowed,
        uint256 premium,
        uint256 stakeLocked,
        uint64 deliveryDeadline
    );
    event DeliverySubmitted(bytes32 indexed jobId, bytes32 transcriptDigest, uint64 acceptanceDeadline);
    event JobReleased(bytes32 indexed jobId, address indexed provider, uint256 amount);
    event JobRefunded(bytes32 indexed jobId, address indexed client, uint256 amount);
    event DisputeOpened(bytes32 indexed jobId, bytes32 indexed caseId, uint8 disputeIndex);
    event CureWindowOpened(bytes32 indexed jobId, uint64 cureDeadline);
    event JobSettled(
        bytes32 indexed jobId,
        bytes32 indexed caseId,
        uint8 code,
        uint16 payoutBps,
        uint256 refund,
        uint256 providerCut,
        uint256 slashed
    );

    error ZeroAddress();
    error ZeroAmount();
    error JobExists();
    error UnknownJob();
    error WrongState(State actual, State expected);
    error NotClient();
    error NotProvider();
    error BadSignature();
    error DeliveryWindowTooShort();
    error DeliveryWindowPassed();
    error AcceptanceWindowOpen(uint64 closesAt);
    error AcceptanceWindowClosed(uint64 closedAt);
    error DeliveryDeadlineNotPassed(uint64 deadline);
    error CureWindowOpen(uint64 closesAt);
    error NoCureWindow();
    error CureWindowClosed(uint64 closedAt);
    error DisputeLimitReached();
    error PremiumTooHigh();
    error StakeRequirementTooLow();
    error InsufficientPayoutBucket(uint16 payoutBps);
    error Reentrancy();

    modifier nonReentrant() {
        if (_reentrancyGuard != 1) revert Reentrancy();
        _reentrancyGuard = 2;
        _;
        _reentrancyGuard = 1;
    }

    constructor(
        IERC20 token_,
        ProviderStake stakeVault_,
        VerdictInbox inbox_,
        ReputationLog reputation_,
        address warrantyVault_,
        uint16 premiumBps_,
        uint16 requiredStakeBps_,
        uint64 acceptanceWindow_,
        uint64 cureWindow_
    ) {
        if (
            address(token_) == address(0) || address(stakeVault_) == address(0) || address(inbox_) == address(0)
                || address(reputation_) == address(0) || warrantyVault_ == address(0)
        ) revert ZeroAddress();

        // The premium is the client's insurance cost, not a protocol rake.
        if (premiumBps_ > 1_000) revert PremiumTooHigh();

        // Locked collateral must cover the worst slash this contract can order,
        // or a severity-3 breach would slash less than the verdict called for
        // and quietly under-compensate the client.
        if (requiredStakeBps_ < VerdictLib.slashBpsFor(VerdictLib.MAX_SEVERITY)) {
            revert StakeRequirementTooLow();
        }

        token = token_;
        stakeVault = stakeVault_;
        inbox = inbox_;
        reputation = reputation_;
        warrantyVault = warrantyVault_;
        premiumBps = premiumBps_;
        requiredStakeBps = requiredStakeBps_;
        acceptanceWindow = acceptanceWindow_;
        cureWindow = cureWindow_;
    }

    // ---------------------------------------------------------------------
    // Funding and delivery
    // ---------------------------------------------------------------------

    /// @notice Fund a job. The client pays `amount`; the premium is split out
    ///         and the provider's collateral is locked in the same transaction.
    /// @dev Locking collateral here, not at delivery, is what makes the
    ///      warranty real: a provider cannot accept work it could not be
    ///      slashed for.
    function fundJob(
        bytes32 jobId,
        address provider,
        uint256 amount,
        uint64 deliveryWindow,
        uint256 erc8004TokenId
    ) external nonReentrant {
        if (_jobs[jobId].state != State.None) revert JobExists();
        if (provider == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (deliveryWindow == 0) revert DeliveryWindowTooShort();

        uint256 premium = (amount * premiumBps) / VerdictLib.BPS_DENOMINATOR;
        uint256 escrowed = amount - premium;
        uint256 required = (escrowed * requiredStakeBps) / VerdictLib.BPS_DENOMINATOR;
        uint64 deadline = uint64(block.timestamp) + deliveryWindow;

        _jobs[jobId] = Job({
            client: msg.sender,
            provider: provider,
            escrowed: escrowed,
            stakeLocked: required,
            erc8004TokenId: erc8004TokenId,
            transcriptDigest: bytes32(0),
            deliveryDeadline: deadline,
            acceptanceDeadline: 0,
            cureDeadline: 0,
            disputesUsed: 0,
            state: State.Funded
        });
        totalEscrowed += escrowed;

        // Reverts if the provider lacks free collateral, which is the intended
        // gate on accepting the job at all.
        stakeVault.lock(provider, required);

        token.safeTransferFrom(msg.sender, address(this), amount);
        if (premium != 0) token.safeTransfer(warrantyVault, premium);

        emit JobFunded(jobId, msg.sender, provider, escrowed, premium, required, deadline);
    }

    /// @notice Record the delivered transcript and open the acceptance window.
    ///
    /// @dev Two callers are allowed, and the distinction matters for agentic
    ///      commerce: the provider may call directly, where `msg.sender` is
    ///      itself the proof of authorship, or anyone may relay a delivery the
    ///      provider signed off-chain. The second path is the common one — a
    ///      provider agent completing hundreds of jobs should not need a Base
    ///      transaction per job — and it is exactly why the signature exists
    ///      rather than relying on `msg.sender` alone.
    ///
    ///      The digest recorded here is what the client must dispute against,
    ///      so a client cannot fabricate evidence against an innocent provider:
    ///      it can only point the court at bytes the provider committed to.
    function submitDelivery(bytes32 jobId, bytes32 transcriptDigest, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
    {
        Job storage job = _jobs[jobId];
        if (job.state != State.Funded) revert WrongState(job.state, State.Funded);
        if (block.timestamp > job.deliveryDeadline) revert DeliveryWindowPassed();
        if (transcriptDigest == bytes32(0)) revert BadSignature();

        if (msg.sender != job.provider) {
            _requireProviderSignature(jobId, transcriptDigest, job.provider, v, r, s);
        }

        job.transcriptDigest = transcriptDigest;
        job.acceptanceDeadline = uint64(block.timestamp) + acceptanceWindow;
        job.state = State.Delivered;

        emit DeliverySubmitted(jobId, transcriptDigest, job.acceptanceDeadline);
    }

    /// @notice Pay the provider once the acceptance window closes undisputed.
    ///         Permissionless: no party can withhold another's settlement.
    function release(bytes32 jobId) external nonReentrant {
        Job storage job = _jobs[jobId];
        if (job.state != State.Delivered) revert WrongState(job.state, State.Delivered);
        if (block.timestamp < job.acceptanceDeadline) revert AcceptanceWindowOpen(job.acceptanceDeadline);

        _releaseToProvider(jobId, job);
    }

    /// @notice Refund a client whose provider never delivered.
    /// @dev One of the paths that makes "every case terminates" true: without
    ///      it, a provider that simply vanishes leaves the escrow locked for
    ///      good.
    function refundStale(bytes32 jobId) external nonReentrant {
        Job storage job = _jobs[jobId];
        if (job.state != State.Funded) revert WrongState(job.state, State.Funded);
        if (block.timestamp <= job.deliveryDeadline) revert DeliveryDeadlineNotPassed(job.deliveryDeadline);

        uint256 amount = job.escrowed;
        address client = job.client;

        job.state = State.Refunded;
        job.escrowed = 0;
        totalEscrowed -= amount;

        stakeVault.unlock(job.provider, job.stakeLocked);
        job.stakeLocked = 0;

        token.safeTransfer(client, amount);
        emit JobRefunded(jobId, client, amount);
    }

    // ---------------------------------------------------------------------
    // Disputes
    // ---------------------------------------------------------------------

    /// @notice The case identifier the relayer must use on the inbox.
    function caseIdFor(bytes32 jobId, uint8 disputeIndex) public pure returns (bytes32) {
        return keccak256(abi.encode(jobId, disputeIndex));
    }

    /// @notice Open a dispute against a delivered job.
    /// @dev Callable twice: once inside the acceptance window, and once more
    ///      inside the cure window if the court could not read the evidence.
    ///      The second is not generosity — an `EVIDENCE_UNAVAILABLE` verdict is
    ///      explicitly *not* a finding, so a client with no second bite would
    ///      be defeated by a transcript host that happened to be down.
    function openDispute(bytes32 jobId) external nonReentrant returns (bytes32 caseId) {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.client) revert NotClient();
        if (job.disputesUsed >= MAX_DISPUTES) revert DisputeLimitReached();

        if (job.state == State.Delivered) {
            if (block.timestamp > job.acceptanceDeadline) revert AcceptanceWindowClosed(job.acceptanceDeadline);
            // Counted once for the whole dispute lifecycle, including a cure
            // re-dispute, and cleared once at the terminal state. Counting per
            // dispute would need two decrements and a mismatched pair would
            // freeze the provider's stake permanently.
            stakeVault.disputeOpened(job.provider);
        } else if (job.state == State.Disputed) {
            if (job.cureDeadline == 0) revert NoCureWindow();
            if (block.timestamp > job.cureDeadline) revert CureWindowClosed(job.cureDeadline);
        } else {
            revert WrongState(job.state, State.Delivered);
        }

        caseId = caseIdFor(jobId, job.disputesUsed);
        job.disputesUsed += 1;
        job.state = State.Disputed;
        job.cureDeadline = 0;

        emit DisputeOpened(jobId, caseId, job.disputesUsed - 1);
    }

    /// @notice Settle a dispute against the finalized verdict in the inbox.
    ///
    /// @dev Pull, not push: the inbox never calls into this contract. A verdict
    ///      landing on Base therefore cannot re-enter settlement, and the
    ///      inbox needs no knowledge of the escrow at all.
    function settle(bytes32 jobId) external nonReentrant {
        Job storage job = _jobs[jobId];
        if (job.state != State.Disputed) revert WrongState(job.state, State.Disputed);

        bytes32 caseId = caseIdFor(jobId, job.disputesUsed - 1);
        // Reverts unless the verdict is final, so an in-window or contested
        // verdict cannot move money.
        (uint8 code, uint16 payoutBps, uint8 severity, bytes32 verdictHash) = inbox.finalVerdictOf(caseId);

        // Re-checked even though the inbox checked it on the way in: this is
        // the last gate before funds move, and it is cheap.
        if (!VerdictLib.isBucket(payoutBps)) revert InsufficientPayoutBucket(payoutBps);

        if (code == VerdictLib.EVIDENCE_UNAVAILABLE) {
            _openCureWindow(jobId, job);
            return;
        }

        _applyVerdict(jobId, caseId, job, code, payoutBps, severity, verdictHash);
    }

    /// @notice Release to the provider after an unanswered cure window.
    /// @dev The hinge of the whole evidence design. Evidence that cannot be
    ///      read is not proof of breach, so this path never slashes. If it did,
    ///      taking a provider's transcript host offline would become an attack
    ///      on the provider, and keeping it offline an attack on the client.
    function settleAfterCure(bytes32 jobId) external nonReentrant {
        Job storage job = _jobs[jobId];
        if (job.state != State.Disputed) revert WrongState(job.state, State.Disputed);
        if (job.cureDeadline == 0) revert NoCureWindow();
        if (block.timestamp <= job.cureDeadline) revert CureWindowOpen(job.cureDeadline);

        stakeVault.disputeClosed(job.provider);
        _releaseToProvider(jobId, job);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _openCureWindow(bytes32 jobId, Job storage job) private {
        uint64 deadline = uint64(block.timestamp) + cureWindow;
        job.cureDeadline = deadline;
        emit CureWindowOpened(jobId, deadline);
    }

    function _applyVerdict(
        bytes32 jobId,
        bytes32 caseId,
        Job storage job,
        uint8 code,
        uint16 payoutBps,
        uint8 severity,
        bytes32 verdictHash
    ) private {
        uint256 escrowed = job.escrowed;

        // Invariant 2: the split is exact by construction. `providerCut` is a
        // subtraction, never a second multiplication, so rounding cannot mint
        // or strand a wei.
        uint256 refund = (escrowed * payoutBps) / VerdictLib.BPS_DENOMINATOR;
        uint256 providerCut = escrowed - refund;

        // Effects before interactions.
        job.state = State.Settled;
        job.escrowed = 0;
        job.cureDeadline = 0;
        totalEscrowed -= escrowed;

        uint256 slashed = _resolveCollateral(caseId, job, code, severity, escrowed, verdictHash);

        // Invariant 1: both recipients are read from the job, never from the
        // verdict. There is no code path that transfers escrow elsewhere.
        if (refund != 0) token.safeTransfer(job.client, refund);
        if (providerCut != 0) token.safeTransfer(job.provider, providerCut);

        emit JobSettled(jobId, caseId, code, payoutBps, refund, providerCut, slashed);
    }

    /// @dev Split out from `_applyVerdict` to keep each function's accounting
    ///      legible on its own: escrow money there, collateral here.
    function _resolveCollateral(
        bytes32 caseId,
        Job storage job,
        uint8 code,
        uint8 severity,
        uint256 escrowed,
        bytes32 verdictHash
    ) private returns (uint256 slashed) {
        address provider = job.provider;
        address client = job.client;
        uint256 stakeLocked = job.stakeLocked;
        job.stakeLocked = 0;

        bool breach = VerdictLib.isBreach(code);
        if (breach) {
            uint256 target = (escrowed * VerdictLib.slashBpsFor(severity)) / VerdictLib.BPS_DENOMINATOR;
            // Invariant 5: `slash` draws only from collateral locked to this
            // job and returns what it actually took, so the unlock below cannot
            // over-credit the provider.
            slashed = stakeVault.slash(provider, target, client);
        }
        if (stakeLocked > slashed) stakeVault.unlock(provider, stakeLocked - slashed);
        stakeVault.disputeClosed(provider);

        if (breach) {
            reputation.recordBreach(provider, client, caseId, job.erc8004TokenId, code, severity, verdictHash, "");
        }
    }

    function _releaseToProvider(bytes32 jobId, Job storage job) private {
        uint256 amount = job.escrowed;
        address provider = job.provider;
        uint256 stakeLocked = job.stakeLocked;

        job.state = State.Released;
        job.escrowed = 0;
        job.stakeLocked = 0;
        job.cureDeadline = 0;
        totalEscrowed -= amount;

        if (stakeLocked != 0) stakeVault.unlock(provider, stakeLocked);

        token.safeTransfer(provider, amount);
        emit JobReleased(jobId, provider, amount);
    }

    function _requireProviderSignature(
        bytes32 jobId,
        bytes32 transcriptDigest,
        address provider,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) private view {
        // Reject the upper-half `s` and any `v` outside {27, 28}: ECDSA admits
        // a second valid signature for every message, and accepting both would
        // let the same delivery be presented twice under different bytes.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert BadSignature();
        }
        if (v != 27 && v != 28) revert BadSignature();

        bytes32 structHash =
            keccak256(abi.encode(DELIVERY_TYPEHASH, block.chainid, address(this), jobId, transcriptDigest));
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", structHash));

        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0) || signer != provider) revert BadSignature();
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function jobOf(bytes32 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }

    function stateOf(bytes32 jobId) external view returns (State) {
        return _jobs[jobId].state;
    }

    /// @notice The digest a client must dispute against.
    function deliveryDigestFor(bytes32 jobId, bytes32 transcriptDigest) external view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19Ethereum Signed Message:\n32",
                keccak256(abi.encode(DELIVERY_TYPEHASH, block.chainid, address(this), jobId, transcriptDigest))
            )
        );
    }
}
