// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VerdictLib} from "../shared/VerdictLib.sol";

/// @notice ZK Stack system contract that turns an L2 call into an L2→L1 message.
/// @dev Fixed at `0x0000000000000000000000000000000000008008` on every ZK Stack
///      chain. The operator supplies the message preimage when the batch is
///      committed, and Ethereum verifies it against the batch's log tree — which
///      is what makes the backstop trustless rather than merely bonded.
interface IL1Messenger {
    function sendToL1(bytes calldata _message) external returns (bytes32);
}

/// @title VerdictEmitter
/// @notice The Intelligent Contract's foot on the EVM side of GenLayer Chain.
///
/// @dev Two jobs, and they serve the protocol's two settlement paths:
///
///      1. **Emit an event** the relayer can watch, so the fast path has a
///         cheap trigger and does not have to poll contract state.
///      2. **Send the verdict to Ethereum** via the ZK Stack `L1Messenger`, so
///         the canonical backstop has proof material to work with later.
///
///      ## Why the L1 message is sent on every verdict, not only on a challenge
///
///      An L2→L1 message cannot be created retroactively: it is a log committed
///      inside the batch that contained the transaction. If this contract only
///      sent one when a challenge appeared on Base, the proof material for the
///      disputed verdict would not exist, and manufacturing it would need a
///      fresh GenLayer transaction — a new liveness dependency on the exact
///      path that exists because the fast path already failed.
///
///      So the message is always sent. The cost asymmetry still holds: sending
///      is a cheap log on GenLayer's L2, while *proving* it costs Ethereum gas
///      and is only ever paid on a contested case.
///
///      ## Authentication
///
///      `msg.sender` is the Intelligent Contract's own address. GenLayer routes
///      external messages through the contract's ghost, `handleOp()` forwards
///      the call, and the ghost and the IC share one address — so a single
///      immutable equality check is the whole authentication story.
///
///      ## On-finalization is a protocol guarantee here, not a convention
///
///      GenLayer permits `on='accepted'` for internal messages but *not* for
///      external ones: EVM-bound messages are finalized-only. That closes the
///      fund-loss hole the design was most exposed to — a verdict settling on
///      Base that a later successful appeal overturns — and closes it in the
///      protocol rather than in a keeper's configuration, where it could be got
///      wrong. This contract therefore never needs to inspect appeal state.
contract VerdictEmitter {
    /// @dev The ZK Stack messenger's fixed system address.
    IL1Messenger public constant L1_MESSENGER = IL1Messenger(0x0000000000000000000000000000000000008008);

    /// @notice Schema tag on the L1 payload.
    /// @dev The forwarder on Ethereum accepts any message whose `sender` is this
    ///      contract. A tag makes the payload self-describing, so a future
    ///      second message type from this same address cannot be mistaken for a
    ///      verdict by a forwarder that predates it.
    bytes32 public constant VERDICT_MESSAGE_TAG = keccak256("AgentWarrantyCourt.Verdict.v1");

    /// @notice The Intelligent Contract whose verdicts this contract publishes.
    /// @dev Immutable. A settable court address would be a rewrite key for
    ///      every future verdict, which is the one thing the whole optimistic
    ///      design is built to deny anyone.
    address public immutable court;

    struct Verdict {
        bytes32 verdictHash;
        uint8 code;
        uint16 payoutBps;
        uint8 severity;
        bool published;
    }

    mapping(bytes32 => Verdict) private _verdicts;

    /// @notice What the Base relayer watches.
    event VerdictFinalized(
        bytes32 indexed caseId, bytes32 verdictHash, uint8 code, uint16 payoutBps, uint8 severity, bytes32 l1MessageHash
    );

    /// @notice A duplicate delivery of an already-published, identical verdict.
    /// @dev Emitted rather than reverted. See `publishVerdict`.
    event DuplicateIgnored(bytes32 indexed caseId);

    error NotCourt(address caller);
    error ZeroAddress();
    error EmptyVerdictHash();
    error IncoherentVerdict(uint8 code, uint16 payoutBps, uint8 severity);
    error VerdictConflict(bytes32 caseId);

    constructor(address court_) {
        if (court_ == address(0)) revert ZeroAddress();
        court = court_;
    }

    /// @notice Publish a finalized verdict to the event log and to Ethereum.
    ///
    /// @dev Idempotent on purpose, and asymmetrically so:
    ///
    ///      * A repeat of a verdict already published, with identical values, is
    ///        a no-op that returns cleanly. Reverting would be worse — the
    ///        caller is GenLayer's ghost via `handleOp()`, and a revert there
    ///        turns a harmless duplicate into a stuck message.
    ///      * A *different* verdict for a case already published reverts. This
    ///        should be unreachable, since the IC decides a case once and
    ///        external messages only fire after finalization. If it ever
    ///        happens, something is badly wrong upstream, and the alternative to
    ///        failing loudly is silently accepting a rewritten verdict.
    function publishVerdict(bytes32 caseId, bytes32 verdictHash, uint8 code, uint16 payoutBps, uint8 severity)
        external
        returns (bytes32 l1MessageHash)
    {
        if (msg.sender != court) revert NotCourt(msg.sender);
        if (verdictHash == bytes32(0)) revert EmptyVerdictHash();

        // The first Solidity gate in the pipeline. A malformed verdict stops
        // here and never becomes an Ethereum message, so the forwarder and the
        // Base inbox are never asked to reason about one.
        if (!VerdictLib.isCoherent(code, payoutBps, severity)) {
            revert IncoherentVerdict(code, payoutBps, severity);
        }

        Verdict storage stored = _verdicts[caseId];
        if (stored.published) {
            bool identical = stored.verdictHash == verdictHash && stored.code == code
                && stored.payoutBps == payoutBps && stored.severity == severity;
            if (!identical) revert VerdictConflict(caseId);
            emit DuplicateIgnored(caseId);
            return bytes32(0);
        }

        _verdicts[caseId] = Verdict({
            verdictHash: verdictHash,
            code: code,
            payoutBps: payoutBps,
            severity: severity,
            published: true
        });

        l1MessageHash = L1_MESSENGER.sendToL1(encodeVerdict(caseId, verdictHash, code, payoutBps, severity));

        emit VerdictFinalized(caseId, verdictHash, code, payoutBps, severity, l1MessageHash);
    }

    /// @notice The exact bytes sent to Ethereum for a verdict.
    /// @dev Public and pure so the L1 forwarder's tests, the keeper, and anyone
    ///      constructing an inclusion proof all derive the payload the same way.
    ///      `abi.encode` rather than `encodePacked`: the forwarder decodes this,
    ///      and packed encoding of a tagged struct is ambiguous to decode.
    function encodeVerdict(bytes32 caseId, bytes32 verdictHash, uint8 code, uint16 payoutBps, uint8 severity)
        public
        pure
        returns (bytes memory)
    {
        return abi.encode(VERDICT_MESSAGE_TAG, caseId, verdictHash, code, payoutBps, severity);
    }

    function verdictOf(bytes32 caseId) external view returns (Verdict memory) {
        return _verdicts[caseId];
    }

    function isPublished(bytes32 caseId) external view returns (bool) {
        return _verdicts[caseId].published;
    }
}
