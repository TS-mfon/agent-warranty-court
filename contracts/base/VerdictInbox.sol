// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "./interfaces/IERC20.sol";
import {SafeTransfer} from "./libraries/SafeTransfer.sol";
import {VerdictLib} from "../shared/VerdictLib.sol";

/// @title VerdictInbox
/// @notice The optimistic endpoint where a GenLayer verdict lands on Base.
///
/// @dev The relayer is the only merely-bonded party in the protocol, so this
///      contract is built around a single claim: **a relayer can delay
///      settlement but never steal it.**
///
///      Three things enforce that. The verdict grammar is re-derived here, so
///      a relayer cannot post a verdict GenLayer would not have produced. Any
///      address can challenge, so a relayer must be wrong in public. And a
///      challenge is resolved by GenLayer's own finalized state arriving over
///      the canonical bridge, not by a vote or an operator.
///
///      ## Why the challenge window does not race the GenLayer appeal window
///
///      The obvious design makes `challengeWindow >= GenLayer appeal window`.
///      That is unsafe: the appeal window is governance-managed, *pauses*
///      during appeal voting, and a won appeal grants a brand-new window, so
///      no constant chosen here can bound it.
///
///      Instead the two are decoupled. A relayer may only post verdicts
///      already `Finalized` on GenLayer (status 7, no longer appealable), and
///      `genlayerTxId` is stored so a challenger can verify that status
///      independently. The window here therefore covers exactly one question —
///      *does this verdict match the finalized GenLayer state?* — which is
///      bounded and checkable. GenLayer appeal timing becomes irrelevant to
///      Base, and `challengeWindow` drops from a correctness hinge to a free
///      latency parameter.
contract VerdictInbox {
    using SafeTransfer for IERC20;

    enum Status {
        None,
        Posted,
        Challenged,
        Final
    }

    struct Verdict {
        bytes32 verdictHash;
        bytes32 genlayerTxId;
        address relayer;
        address challenger;
        uint64 postedAt;
        uint64 challengedAt;
        uint16 payoutBps;
        uint8 code;
        uint8 severity;
        Status status;
        bool overturned;
    }

    IERC20 public immutable token;
    uint256 public immutable relayerBond;
    uint256 public immutable challengeBond;
    uint64 public immutable challengeWindow;

    /// @notice How long a challenge waits for the canonical bridge before the
    ///         posted verdict stands by default.
    /// @dev The healthy canonical path is roughly 3 hours (ZK batch formation,
    ///      ~1h proving, ~3h execution delay, then Ethereum->Base messaging).
    ///      This is set far beyond that, so reaching it means the bridge itself
    ///      is down rather than that the challenge was close.
    uint64 public immutable canonicalTimeout;

    address public canonicalReceiver;

    mapping(bytes32 => Verdict) private _verdicts;

    event CanonicalReceiverSet(address indexed receiver);
    event VerdictPosted(
        bytes32 indexed caseId,
        address indexed relayer,
        bytes32 verdictHash,
        uint8 code,
        uint16 payoutBps,
        uint8 severity,
        bytes32 genlayerTxId
    );
    event VerdictChallenged(bytes32 indexed caseId, address indexed challenger);
    event VerdictFinalized(bytes32 indexed caseId, uint8 code, uint16 payoutBps, uint8 severity, bool overturned);
    event ChallengeTimedOut(bytes32 indexed caseId, address indexed challenger, address indexed relayer);

    error NotCanonicalReceiver();
    error ReceiverAlreadySet();
    error ZeroAddress();
    error CaseAlreadyPosted();
    error UnknownCase();
    error IncoherentVerdict(uint8 code, uint16 payoutBps, uint8 severity);
    error EmptyVerdictHash();
    error EmptyGenlayerTxId();
    error NotChallengeable(Status status);
    error ChallengeWindowClosed();
    error ChallengeWindowOpen(uint64 closesAt);
    error NotChallenged(Status status);
    error CanonicalStillPending(uint64 timesOutAt);
    error VerdictNotFinal(Status status);
    error WindowTooShort();

    modifier onlyCanonicalReceiver() {
        if (msg.sender != canonicalReceiver) revert NotCanonicalReceiver();
        _;
    }

    constructor(
        IERC20 token_,
        uint256 relayerBond_,
        uint256 challengeBond_,
        uint64 challengeWindow_,
        uint64 canonicalTimeout_
    ) {
        if (address(token_) == address(0)) revert ZeroAddress();
        // A challenger must have time to read GenLayer's finalized state and
        // act; a canonical timeout shorter than the ~3h healthy bridge latency
        // would resolve challenges by default while the answer was in flight.
        if (challengeWindow_ < 30 minutes || canonicalTimeout_ < 1 days) revert WindowTooShort();

        token = token_;
        relayerBond = relayerBond_;
        challengeBond = challengeBond_;
        challengeWindow = challengeWindow_;
        canonicalTimeout = canonicalTimeout_;
    }

    /// @dev One-shot for the same reason as `ProviderStake.setEscrow`: the
    ///      receiver and this contract each need the other's address, and a
    ///      mutable pointer here would let whoever holds it forge any verdict.
    function setCanonicalReceiver(address receiver) external {
        if (canonicalReceiver != address(0)) revert ReceiverAlreadySet();
        if (receiver == address(0)) revert ZeroAddress();
        canonicalReceiver = receiver;
        emit CanonicalReceiverSet(receiver);
    }

    // ---------------------------------------------------------------------
    // Optimistic path
    // ---------------------------------------------------------------------

    /// @notice Post a GenLayer verdict that has reached `Finalized` there.
    /// @param verdictHash Commitment to the full verdict payload, reasoning
    ///        included. The numeric fields alone are derivable from the
    ///        arguments and would commit to nothing; the hash is what lets the
    ///        canonical path prove the relayer altered the narrative as well as
    ///        the numbers.
    /// @param genlayerTxId The GenLayer transaction whose finalized state this
    ///        claims to reflect, so a challenger can check it independently.
    function postVerdict(
        bytes32 caseId,
        bytes32 verdictHash,
        uint8 code,
        uint16 payoutBps,
        uint8 severity,
        bytes32 genlayerTxId
    ) external {
        if (_verdicts[caseId].status != Status.None) revert CaseAlreadyPosted();
        if (verdictHash == bytes32(0)) revert EmptyVerdictHash();
        if (genlayerTxId == bytes32(0)) revert EmptyGenlayerTxId();
        if (!VerdictLib.isCoherent(code, payoutBps, severity)) {
            revert IncoherentVerdict(code, payoutBps, severity);
        }

        _verdicts[caseId] = Verdict({
            verdictHash: verdictHash,
            genlayerTxId: genlayerTxId,
            relayer: msg.sender,
            challenger: address(0),
            postedAt: uint64(block.timestamp),
            challengedAt: 0,
            payoutBps: payoutBps,
            code: code,
            severity: severity,
            status: Status.Posted,
            overturned: false
        });

        if (relayerBond != 0) token.safeTransferFrom(msg.sender, address(this), relayerBond);

        emit VerdictPosted(caseId, msg.sender, verdictHash, code, payoutBps, severity, genlayerTxId);
    }

    /// @notice Dispute a posted verdict. Permissionless, bonded.
    function challenge(bytes32 caseId) external {
        Verdict storage v = _verdicts[caseId];
        if (v.status != Status.Posted) revert NotChallengeable(v.status);
        if (block.timestamp >= v.postedAt + challengeWindow) revert ChallengeWindowClosed();

        v.status = Status.Challenged;
        v.challenger = msg.sender;
        v.challengedAt = uint64(block.timestamp);

        if (challengeBond != 0) token.safeTransferFrom(msg.sender, address(this), challengeBond);

        emit VerdictChallenged(caseId, msg.sender);
    }

    /// @notice Finalize an unchallenged verdict. Permissionless.
    function finalizeVerdict(bytes32 caseId) external {
        Verdict storage v = _verdicts[caseId];
        if (v.status != Status.Posted) revert NotChallengeable(v.status);

        uint64 closesAt = v.postedAt + challengeWindow;
        if (block.timestamp < closesAt) revert ChallengeWindowOpen(closesAt);

        v.status = Status.Final;
        address relayer = v.relayer;

        if (relayerBond != 0) token.safeTransfer(relayer, relayerBond);

        emit VerdictFinalized(caseId, v.code, v.payoutBps, v.severity, false);
    }

    // ---------------------------------------------------------------------
    // Canonical backstop
    // ---------------------------------------------------------------------

    /// @notice Resolve a challenge with GenLayer's own finalized state,
    ///         delivered over the canonical bridge via Ethereum.
    /// @dev The canonical values are authoritative and overwrite whatever was
    ///      posted. The bond flow is the incentive that makes the optimistic
    ///      path honest: whoever was right takes both bonds.
    function resolveChallenge(
        bytes32 caseId,
        bytes32 verdictHash,
        uint8 code,
        uint16 payoutBps,
        uint8 severity
    ) external onlyCanonicalReceiver {
        Verdict storage v = _verdicts[caseId];
        if (v.status != Status.Challenged) revert NotChallenged(v.status);
        if (!VerdictLib.isCoherent(code, payoutBps, severity)) {
            revert IncoherentVerdict(code, payoutBps, severity);
        }

        bool matches =
            v.verdictHash == verdictHash && v.code == code && v.payoutBps == payoutBps && v.severity == severity;

        address relayer = v.relayer;
        address challenger = v.challenger;

        v.status = Status.Final;
        if (!matches) {
            v.verdictHash = verdictHash;
            v.code = code;
            v.payoutBps = payoutBps;
            v.severity = severity;
            v.overturned = true;
        }

        address winner = matches ? relayer : challenger;
        uint256 pot = relayerBond + challengeBond;
        if (pot != 0) token.safeTransfer(winner, pot);

        emit VerdictFinalized(caseId, code, payoutBps, severity, !matches);
    }

    /// @notice Settle a challenge the canonical bridge never answered.
    ///
    /// @dev Someone must be able to break the tie or the escrow locks forever,
    ///      which violates the protocol's "every case terminates" invariant.
    ///      Two candidate defaults, and the choice is not obvious:
    ///
    ///      Refunding the client is *not* neutral — a client who lost a dispute
    ///      could challenge through a second address and reach a full refund by
    ///      waiting, which is strictly better than accepting the verdict.
    ///
    ///      So the posted verdict stands and the challenger forfeits its bond
    ///      to the relayer. Reaching this point means the bridge was down for
    ///      `canonicalTimeout` — a protocol-wide outage, not a fact about this
    ///      case — and the posted verdict is the only claim anyone actually
    ///      bonded. The cost is real and worth stating plainly: an honest
    ///      challenger loses its bond to an outage it did not cause. That is
    ///      the deliberate trade for denying the griefing path above, and it is
    ///      why `canonicalTimeout` is set far beyond the healthy bridge
    ///      latency rather than close to it.
    function timeoutChallenge(bytes32 caseId) external {
        Verdict storage v = _verdicts[caseId];
        if (v.status != Status.Challenged) revert NotChallenged(v.status);

        uint64 timesOutAt = v.challengedAt + canonicalTimeout;
        if (block.timestamp < timesOutAt) revert CanonicalStillPending(timesOutAt);

        v.status = Status.Final;
        address relayer = v.relayer;
        address challenger = v.challenger;

        uint256 pot = relayerBond + challengeBond;
        if (pot != 0) token.safeTransfer(relayer, pot);

        emit ChallengeTimedOut(caseId, challenger, relayer);
        emit VerdictFinalized(caseId, v.code, v.payoutBps, v.severity, false);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function verdictOf(bytes32 caseId) external view returns (Verdict memory) {
        return _verdicts[caseId];
    }

    function statusOf(bytes32 caseId) external view returns (Status) {
        return _verdicts[caseId].status;
    }

    /// @notice The settlement read. Reverts unless the verdict is final, so the
    ///         escrow cannot act on a contested or in-window verdict.
    function finalVerdictOf(bytes32 caseId)
        external
        view
        returns (uint8 code, uint16 payoutBps, uint8 severity, bytes32 verdictHash)
    {
        Verdict storage v = _verdicts[caseId];
        if (v.status != Status.Final) revert VerdictNotFinal(v.status);
        return (v.code, v.payoutBps, v.severity, v.verdictHash);
    }
}
