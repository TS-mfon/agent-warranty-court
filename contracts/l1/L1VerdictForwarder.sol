// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VerdictLib} from "../shared/VerdictLib.sol";

/// @notice ZK Stack's arbitrary-length L2→L1 message, as committed in a batch.
/// @dev Field order and types are load-bearing: this struct is ABI-encoded into
///      the call to GenLayer's message verifier and must match era-contracts'
///      `L2Message` exactly.
struct L2Message {
    uint16 txNumberInBatch;
    address sender;
    bytes data;
}

/// @notice GenLayer Chain's L2→L1 message verification surface on Ethereum.
///
/// @dev **Pin this to GenLayer's protocol version before deploying.** ZK Stack
///      has two generations of this call and they are not interchangeable:
///
///      * Gateway-era (current era-contracts `main`), used here:
///        `proveL2MessageInclusionShared(chainId, batchNumber, index, message, proof)`
///        on the shared message-verification surface.
///      * Legacy per-chain diamond:
///        `proveL2MessageInclusion(batchNumber, index, message, proof)` on that
///        chain's own `IMailbox`, with no `chainId` argument.
///
///      Phase 0 could not resolve which one GenLayer runs — the signatures are
///      absent from the ZKsync docs and GenLayer's protocol version is not
///      published — so this is the one interface in the protocol that is
///      version-sensitive by construction. It is deliberately isolated in its
///      own declaration, and `L1VerdictForwarder` touches it in exactly one
///      place, so re-pointing it is a two-line change rather than a redesign.
///
///      The deployment checklist item is: confirm GenLayer exposes `L1Messenger`
///      at `0x8008` and posts proofs to Ethereum at all. A chain running
///      proof-less has no trustless backstop to build on, and the honest
///      response would be to widen `canonicalTimeout` and say so, not to deploy
///      this contract against a verifier that cannot verify.
interface IGenLayerMessageVerifier {
    function proveL2MessageInclusionShared(
        uint256 _chainId,
        uint256 _blockOrBatchNumber,
        uint256 _index,
        L2Message calldata _message,
        bytes32[] calldata _proof
    ) external view returns (bool);
}

/// @notice Ethereum-side entry point of the Base canonical bridge.
interface IL1CrossDomainMessenger {
    function sendMessage(address _target, bytes calldata _message, uint32 _minGasLimit) external;
}

/// @notice The Base receiver's entry point, declared locally.
/// @dev Not imported from `contracts/base`: this contract lives on Ethereum and
///      genuinely does not depend on the Base deployment, so an import would
///      state a relationship that is not there. The risk that the two drift
///      apart is handled by a test that asserts the selectors match, which is a
///      check rather than a coincidence.
interface ICanonicalVerdictReceiver {
    function deliverVerdict(bytes32 caseId, bytes32 verdictHash, uint8 code, uint16 payoutBps, uint8 severity)
        external;
}

/// @title L1VerdictForwarder
/// @notice Carries a proven GenLayer verdict across Ethereum to Base.
///
/// @dev This is the contract that makes the optimistic path safe to use. A
///      relayer posting to Base can be wrong or malicious; what bounds the
///      damage is that anyone can force the real verdict through here, and the
///      proof — not a signature, a bond, or an operator — is what authorizes it.
///
///      ## Permissionless by design
///
///      There is no forwarder role. The inclusion proof *is* the authorization:
///      a caller who cannot produce one cannot move anything, and a caller who
///      can is merely relaying a fact GenLayer already committed to. Adding an
///      access-control modifier here would create exactly the censorship point
///      the backstop exists to remove — the challenge path would depend on one
///      operator staying online and honest, which is the assumption the fast
///      path already declines to make.
///
///      ## Why the L2 sender is immutable rather than a parameter
///
///      `L2Message.sender` is filled in from `genlayerVerdictEmitter`, never
///      from calldata. Taking it as an argument would let a caller prove the
///      inclusion of some *other* contract's L2→L1 message and present it as a
///      verdict; every ZK Stack message is provable, so "it verified" would stop
///      meaning anything. Pinning the sender is what makes the proof specific.
contract L1VerdictForwarder {
    /// @notice A decoded, validated verdict.
    /// @dev A struct rather than a five-value tuple return. The tuple form put
    ///      the decoded fields on the stack alongside `abi.decode`'s six outputs
    ///      and `forwardVerdict`'s five calldata parameters, which overflows
    ///      solc's stack slots. Grouping them into memory is the fix that does
    ///      not require turning on `viaIR` for the whole project.
    struct ProvenVerdict {
        bytes32 caseId;
        bytes32 verdictHash;
        uint8 code;
        uint16 payoutBps;
        uint8 severity;
    }

    /// @notice Must match `VerdictEmitter.VERDICT_MESSAGE_TAG`.
    bytes32 public constant VERDICT_MESSAGE_TAG = keccak256("AgentWarrantyCourt.Verdict.v1");

    IGenLayerMessageVerifier public immutable verifier;
    IL1CrossDomainMessenger public immutable baseMessenger;

    /// @notice GenLayer Chain's chain id, as the shared verifier indexes it.
    uint256 public immutable genlayerChainId;

    /// @notice The only L2 contract whose messages this forwarder will carry.
    address public immutable genlayerVerdictEmitter;

    /// @notice `CanonicalVerdictReceiver` on Base.
    address public immutable baseReceiver;

    /// @notice Gas budget for the Base-side execution.
    /// @dev Immutable, and deliberately generous. If it were too low the Base
    ///      message would fail, and although OP Stack messages are replayable,
    ///      a replay cannot raise the gas limit — the verdict would be
    ///      permanently unrelayable and the challenge would resolve by timeout
    ///      instead, defeating the backstop for that case.
    uint32 public immutable baseGasLimit;

    /// @dev One forward per case. A second is never useful: an OP Stack message
    ///      that fails on Base is replayable there with the same parameters, so
    ///      recovery never requires paying Ethereum gas twice.
    mapping(bytes32 => bool) public forwarded;

    event VerdictForwarded(
        bytes32 indexed caseId, uint8 code, uint16 payoutBps, uint8 severity, uint256 batchNumber, uint256 index
    );

    error ZeroAddress();
    error ZeroChainId();
    error InvalidInclusionProof();
    error UnknownMessageTag(bytes32 tag);
    error MalformedPayload();
    error IncoherentVerdict(uint8 code, uint16 payoutBps, uint8 severity);
    error EmptyVerdictHash();
    error AlreadyForwarded(bytes32 caseId);

    constructor(
        IGenLayerMessageVerifier verifier_,
        IL1CrossDomainMessenger baseMessenger_,
        uint256 genlayerChainId_,
        address genlayerVerdictEmitter_,
        address baseReceiver_,
        uint32 baseGasLimit_
    ) {
        if (
            address(verifier_) == address(0) || address(baseMessenger_) == address(0)
                || genlayerVerdictEmitter_ == address(0) || baseReceiver_ == address(0) || baseGasLimit_ == 0
        ) revert ZeroAddress();
        if (genlayerChainId_ == 0) revert ZeroChainId();

        verifier = verifier_;
        baseMessenger = baseMessenger_;
        genlayerChainId = genlayerChainId_;
        genlayerVerdictEmitter = genlayerVerdictEmitter_;
        baseReceiver = baseReceiver_;
        baseGasLimit = baseGasLimit_;
    }

    /// @notice Prove a GenLayer verdict was committed to Ethereum, then forward
    ///         it to Base.
    ///
    /// @param batchNumber     GenLayer batch containing the message.
    /// @param index           Index of the message in that batch's log tree.
    /// @param txNumberInBatch Position of the emitting transaction in the batch.
    /// @param payload         Exactly the bytes `VerdictEmitter.encodeVerdict`
    ///                        produced. Re-encoded into the proven message, so
    ///                        a single altered byte fails verification.
    /// @param proof           Merkle proof of inclusion in the batch log tree.
    function forwardVerdict(
        uint256 batchNumber,
        uint256 index,
        uint16 txNumberInBatch,
        bytes calldata payload,
        bytes32[] calldata proof
    ) external {
        // Verify first. Nothing is decoded, trusted, or acted on until the
        // proof establishes that GenLayer actually committed these bytes.
        L2Message memory message =
            L2Message({txNumberInBatch: txNumberInBatch, sender: genlayerVerdictEmitter, data: payload});

        if (!verifier.proveL2MessageInclusionShared(genlayerChainId, batchNumber, index, message, proof)) {
            revert InvalidInclusionProof();
        }

        ProvenVerdict memory v = _decode(payload);

        if (forwarded[v.caseId]) revert AlreadyForwarded(v.caseId);
        forwarded[v.caseId] = true;

        baseMessenger.sendMessage(
            baseReceiver,
            abi.encodeCall(
                ICanonicalVerdictReceiver.deliverVerdict, (v.caseId, v.verdictHash, v.code, v.payoutBps, v.severity)
            ),
            baseGasLimit
        );

        emit VerdictForwarded(v.caseId, v.code, v.payoutBps, v.severity, batchNumber, index);
    }

    /// @notice Decode and validate a verdict payload.
    /// @dev Public so a keeper can check a payload before spending Ethereum gas
    ///      on a proof that would revert at the last step.
    function decodeVerdict(bytes calldata payload) external pure returns (ProvenVerdict memory) {
        return _decode(payload);
    }

    function _decode(bytes calldata payload) private pure returns (ProvenVerdict memory) {
        // Six fixed 32-byte words. A shorter payload would make `abi.decode`
        // revert without a reason string, which is a worse diagnostic than
        // saying so.
        if (payload.length != 6 * 32) revert MalformedPayload();

        (bytes32 tag, bytes32 caseId, bytes32 verdictHash, uint8 code, uint16 payoutBps, uint8 severity) =
            abi.decode(payload, (bytes32, bytes32, bytes32, uint8, uint16, uint8));

        // The emitter may one day send a second kind of message from the same
        // address. A forwarder that predates it must refuse to read that
        // message as a verdict rather than guess at its layout.
        if (tag != VERDICT_MESSAGE_TAG) revert UnknownMessageTag(tag);

        if (verdictHash == bytes32(0)) revert EmptyVerdictHash();

        // Re-checked even though the emitter checked it. The grammar is enforced
        // independently at every hop precisely so that no single contract's
        // correctness is load-bearing for the whole pipeline.
        if (!VerdictLib.isCoherent(code, payoutBps, severity)) {
            revert IncoherentVerdict(code, payoutBps, severity);
        }

        return ProvenVerdict({
            caseId: caseId,
            verdictHash: verdictHash,
            code: code,
            payoutBps: payoutBps,
            severity: severity
        });
    }
}
