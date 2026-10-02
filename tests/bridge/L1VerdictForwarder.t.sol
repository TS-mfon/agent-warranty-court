// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BridgeFixture} from "./BridgeFixture.sol";
import {VerdictLib} from "../../contracts/shared/VerdictLib.sol";
import {CanonicalVerdictReceiver} from "../../contracts/base/CanonicalVerdictReceiver.sol";
import {
    L1VerdictForwarder,
    L2Message,
    ICanonicalVerdictReceiver,
    IGenLayerMessageVerifier,
    IL1CrossDomainMessenger
} from "../../contracts/l1/L1VerdictForwarder.sol";

import {MockMessageVerifier, MockL1Bridge} from "./mocks/BridgeMocks.sol";

/// @notice The canonical backstop's Ethereum hop.
///
/// @dev What makes the optimistic path safe to use is that anyone can force the
///      real verdict through here, with an inclusion proof as the only
///      authorization. So the tests are mostly about what *cannot* be forwarded:
///      an unproven message, a message from some other L2 contract, a payload
///      with one byte changed, a proof made under another chain id, and a second
///      forward of a case already carried.
contract L1VerdictForwarderTest is BridgeFixture {
    MockMessageVerifier internal verifier;
    MockL1Bridge internal bridge;
    L1VerdictForwarder internal forwarder;

    address internal baseReceiver;
    address internal keeper;

    bytes32 internal constant CASE = keccak256("case-1");
    bytes32 internal constant HASH = keccak256("verdict-reasoning-1");

    uint256 internal constant BATCH = 9_001;
    uint256 internal constant INDEX = 4;
    uint16 internal constant TX_IN_BATCH = 7;

    function setUp() public override {
        super.setUp();

        baseReceiver = makeAddr("baseCanonicalReceiver");
        keeper = makeAddr("keeper");

        verifier = new MockMessageVerifier();
        bridge = new MockL1Bridge();

        forwarder = new L1VerdictForwarder(
            IGenLayerMessageVerifier(address(verifier)),
            IL1CrossDomainMessenger(address(bridge)),
            GENLAYER_CHAIN_ID,
            address(emitter),
            baseReceiver,
            BASE_GAS_LIMIT
        );
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _proof() internal pure returns (bytes32[] memory p) {
        p = new bytes32[](2);
        p[0] = keccak256("sibling-0");
        p[1] = keccak256("sibling-1");
    }

    /// @dev Payloads come from a real emitted verdict, never from a hand-written
    ///      byte string: a literal would keep passing after the emitter's
    ///      encoding changed, which is exactly the drift these tests exist to
    ///      catch.
    function _emitted(bytes32 caseId, bytes32 verdictHash, uint8 code, uint16 payoutBps, uint8 severity)
        internal
        returns (bytes memory)
    {
        _publish(caseId, verdictHash, code, payoutBps, severity);
        return l1Messenger.lastSent();
    }

    function _commit(bytes memory payload, uint256 batch, uint256 index, uint16 txInBatch, address sender) internal {
        verifier.commit(
            GENLAYER_CHAIN_ID,
            batch,
            index,
            L2Message({txNumberInBatch: txInBatch, sender: sender, data: payload}),
            _proof()
        );
    }

    function _commitHonest(bytes memory payload) internal {
        _commit(payload, BATCH, INDEX, TX_IN_BATCH, address(emitter));
    }

    function _forward(bytes memory payload) internal {
        vm.prank(keeper);
        forwarder.forwardVerdict(BATCH, INDEX, TX_IN_BATCH, payload, _proof());
    }

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    function test_constructor_storesEveryPin() public view {
        assertEq(address(forwarder.verifier()), address(verifier));
        assertEq(address(forwarder.baseMessenger()), address(bridge));
        assertEq(forwarder.genlayerChainId(), GENLAYER_CHAIN_ID);
        assertEq(forwarder.genlayerVerdictEmitter(), address(emitter));
        assertEq(forwarder.baseReceiver(), baseReceiver);
        assertEq(forwarder.baseGasLimit(), BASE_GAS_LIMIT);
    }

    function test_constructor_rejectsZeroVerifier() public {
        vm.expectRevert(L1VerdictForwarder.ZeroAddress.selector);
        new L1VerdictForwarder(
            IGenLayerMessageVerifier(address(0)),
            IL1CrossDomainMessenger(address(bridge)),
            GENLAYER_CHAIN_ID,
            address(emitter),
            baseReceiver,
            BASE_GAS_LIMIT
        );
    }

    function test_constructor_rejectsZeroBridge() public {
        vm.expectRevert(L1VerdictForwarder.ZeroAddress.selector);
        new L1VerdictForwarder(
            IGenLayerMessageVerifier(address(verifier)),
            IL1CrossDomainMessenger(address(0)),
            GENLAYER_CHAIN_ID,
            address(emitter),
            baseReceiver,
            BASE_GAS_LIMIT
        );
    }

    function test_constructor_rejectsZeroEmitter() public {
        vm.expectRevert(L1VerdictForwarder.ZeroAddress.selector);
        new L1VerdictForwarder(
            IGenLayerMessageVerifier(address(verifier)),
            IL1CrossDomainMessenger(address(bridge)),
            GENLAYER_CHAIN_ID,
            address(0),
            baseReceiver,
            BASE_GAS_LIMIT
        );
    }

    function test_constructor_rejectsZeroBaseReceiver() public {
        vm.expectRevert(L1VerdictForwarder.ZeroAddress.selector);
        new L1VerdictForwarder(
            IGenLayerMessageVerifier(address(verifier)),
            IL1CrossDomainMessenger(address(bridge)),
            GENLAYER_CHAIN_ID,
            address(emitter),
            address(0),
            BASE_GAS_LIMIT
        );
    }

    /// @notice A zero gas limit would make every Base delivery fail, and an OP
    ///         Stack replay cannot raise it — so the verdict would be permanently
    ///         unrelayable and every challenge would resolve by timeout instead.
    function test_constructor_rejectsZeroGasLimit() public {
        vm.expectRevert(L1VerdictForwarder.ZeroAddress.selector);
        new L1VerdictForwarder(
            IGenLayerMessageVerifier(address(verifier)),
            IL1CrossDomainMessenger(address(bridge)),
            GENLAYER_CHAIN_ID,
            address(emitter),
            baseReceiver,
            0
        );
    }

    function test_constructor_rejectsZeroChainId() public {
        vm.expectRevert(L1VerdictForwarder.ZeroChainId.selector);
        new L1VerdictForwarder(
            IGenLayerMessageVerifier(address(verifier)),
            IL1CrossDomainMessenger(address(bridge)),
            0,
            address(emitter),
            baseReceiver,
            BASE_GAS_LIMIT
        );
    }

    // ---------------------------------------------------------------------
    // The happy path
    // ---------------------------------------------------------------------

    function test_forwardVerdict_provesThenSendsToBase() public {
        bytes memory payload = _emitted(CASE, HASH, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);
        _commitHonest(payload);

        vm.expectEmit(true, false, false, true, address(forwarder));
        emit L1VerdictForwarder.VerdictForwarded(
            CASE, VerdictLib.DEAD_LINK_CITATION, 5_000, 2, BATCH, INDEX
        );
        _forward(payload);

        assertTrue(forwarder.forwarded(CASE));
        assertEq(bridge.sentCount(), 1);

        MockL1Bridge.Sent memory sent = bridge.lastSent();
        assertEq(sent.target, baseReceiver);
        assertEq(sent.gasLimit, BASE_GAS_LIMIT);
        assertEq(
            sent.message,
            abi.encodeCall(
                ICanonicalVerdictReceiver.deliverVerdict,
                (CASE, HASH, VerdictLib.DEAD_LINK_CITATION, uint16(5_000), uint8(2))
            )
        );
    }

    /// @notice No forwarder role, by design. The proof is the authorization, so a
    ///         caller who has one is merely relaying a fact GenLayer already
    ///         committed to. An access modifier here would recreate the exact
    ///         censorship point the backstop exists to remove.
    function test_forwardVerdict_isPermissionless() public {
        bytes memory payload = _emitted(CASE, HASH, VerdictLib.NO_BREACH, 0, 0);
        _commitHonest(payload);

        vm.prank(outsider);
        forwarder.forwardVerdict(BATCH, INDEX, TX_IN_BATCH, payload, _proof());

        assertTrue(forwarder.forwarded(CASE));
        assertEq(bridge.sentCount(), 1);
    }

    /// @notice An acquittal has to cross the bridge just as reliably as a breach:
    ///         the challenge path exists to establish what GenLayer decided, not
    ///         to collect payouts.
    function test_forwardVerdict_carriesAnAcquittal() public {
        bytes memory payload = _emitted(CASE, HASH, VerdictLib.NO_BREACH, 0, 0);
        _commitHonest(payload);
        _forward(payload);

        assertEq(
            bridge.lastSent().message,
            abi.encodeCall(
                ICanonicalVerdictReceiver.deliverVerdict, (CASE, HASH, VerdictLib.NO_BREACH, uint16(0), uint8(0))
            )
        );
    }

    // ---------------------------------------------------------------------
    // What cannot be forwarded
    // ---------------------------------------------------------------------

    function test_forwardVerdict_rejectsUnprovenMessage() public {
        bytes memory payload = _emitted(CASE, HASH, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);
        // Never committed.
        vm.prank(keeper);
        vm.expectRevert(L1VerdictForwarder.InvalidInclusionProof.selector);
        forwarder.forwardVerdict(BATCH, INDEX, TX_IN_BATCH, payload, _proof());

        assertEq(bridge.sentCount(), 0);
    }

    /// @notice The property that makes "it verified" mean something. Every ZK
    ///         Stack message is provable, so if `L2Message.sender` came from
    ///         calldata a caller could prove some other contract's message and
    ///         present it as a verdict. Pinning the sender is what makes the
    ///         proof specific — here the attacker's message is genuinely
    ///         committed and still cannot be forwarded.
    function test_forwardVerdict_cannotForgeTheL2Sender() public {
        address attacker = makeAddr("genlayerAttackerContract");
        bytes memory payload = emitter.encodeVerdict(CASE, HASH, VerdictLib.SILENT_FAILURE, 10_000, 3);

        _commit(payload, BATCH, INDEX, TX_IN_BATCH, attacker);

        vm.prank(attacker);
        vm.expectRevert(L1VerdictForwarder.InvalidInclusionProof.selector);
        forwarder.forwardVerdict(BATCH, INDEX, TX_IN_BATCH, payload, _proof());

        assertFalse(forwarder.forwarded(CASE));
        assertEq(bridge.sentCount(), 0);
    }

    /// @notice One flipped byte in the payload breaks verification, because the
    ///         payload is re-encoded into the proven message rather than trusted.
    function test_forwardVerdict_rejectsTamperedPayload() public {
        bytes memory payload = _emitted(CASE, HASH, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);
        _commitHonest(payload);

        bytes memory tampered = payload;
        // Last byte is `severity`; 2 → 3 escalates the slash.
        tampered[tampered.length - 1] = bytes1(uint8(3));

        vm.prank(keeper);
        vm.expectRevert(L1VerdictForwarder.InvalidInclusionProof.selector);
        forwarder.forwardVerdict(BATCH, INDEX, TX_IN_BATCH, tampered, _proof());
    }

    /// @notice The chain id is pinned, so a message committed on some other ZK
    ///         Stack chain — including a chain an attacker operates — does not
    ///         prove here.
    function test_forwardVerdict_rejectsProofFromAnotherChain() public {
        bytes memory payload = _emitted(CASE, HASH, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);
        verifier.commit(
            GENLAYER_CHAIN_ID + 1,
            BATCH,
            INDEX,
            L2Message({txNumberInBatch: TX_IN_BATCH, sender: address(emitter), data: payload}),
            _proof()
        );

        vm.prank(keeper);
        vm.expectRevert(L1VerdictForwarder.InvalidInclusionProof.selector);
        forwarder.forwardVerdict(BATCH, INDEX, TX_IN_BATCH, payload, _proof());
    }

    function test_forwardVerdict_rejectsWrongBatchIndexOrTxNumber() public {
        bytes memory payload = _emitted(CASE, HASH, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);
        _commitHonest(payload);

        vm.startPrank(keeper);
        vm.expectRevert(L1VerdictForwarder.InvalidInclusionProof.selector);
        forwarder.forwardVerdict(BATCH + 1, INDEX, TX_IN_BATCH, payload, _proof());

        vm.expectRevert(L1VerdictForwarder.InvalidInclusionProof.selector);
        forwarder.forwardVerdict(BATCH, INDEX + 1, TX_IN_BATCH, payload, _proof());

        vm.expectRevert(L1VerdictForwarder.InvalidInclusionProof.selector);
        forwarder.forwardVerdict(BATCH, INDEX, TX_IN_BATCH + 1, payload, _proof());
        vm.stopPrank();

        assertEq(bridge.sentCount(), 0);
    }

    /// @notice A proven message from the right sender is still not automatically
    ///         a verdict. If the emitter ever sends a second message type, a
    ///         forwarder that predates it must refuse to read it as one rather
    ///         than guess at the layout.
    function test_forwardVerdict_rejectsUnknownTag() public {
        bytes32 otherTag = keccak256("AgentWarrantyCourt.SomethingElse.v1");
        bytes memory payload = abi.encode(otherTag, CASE, HASH, VerdictLib.DEAD_LINK_CITATION, uint16(5_000), uint8(2));
        _commitHonest(payload);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(L1VerdictForwarder.UnknownMessageTag.selector, otherTag));
        forwarder.forwardVerdict(BATCH, INDEX, TX_IN_BATCH, payload, _proof());

        assertEq(bridge.sentCount(), 0);
    }

    function test_forwardVerdict_rejectsShortPayload() public {
        bytes memory payload = abi.encode(forwarder.VERDICT_MESSAGE_TAG(), CASE, HASH);
        _commitHonest(payload);

        vm.prank(keeper);
        vm.expectRevert(L1VerdictForwarder.MalformedPayload.selector);
        forwarder.forwardVerdict(BATCH, INDEX, TX_IN_BATCH, payload, _proof());
    }

    function test_forwardVerdict_rejectsLongPayload() public {
        bytes memory payload = abi.encode(
            forwarder.VERDICT_MESSAGE_TAG(), CASE, HASH, VerdictLib.DEAD_LINK_CITATION, uint16(5_000), uint8(2), uint256(1)
        );
        _commitHonest(payload);

        vm.prank(keeper);
        vm.expectRevert(L1VerdictForwarder.MalformedPayload.selector);
        forwarder.forwardVerdict(BATCH, INDEX, TX_IN_BATCH, payload, _proof());
    }

    function test_forwardVerdict_rejectsEmptyVerdictHash() public {
        bytes memory payload = abi.encode(
            forwarder.VERDICT_MESSAGE_TAG(), CASE, bytes32(0), VerdictLib.NO_BREACH, uint16(0), uint8(0)
        );
        _commitHonest(payload);

        vm.prank(keeper);
        vm.expectRevert(L1VerdictForwarder.EmptyVerdictHash.selector);
        forwarder.forwardVerdict(BATCH, INDEX, TX_IN_BATCH, payload, _proof());
    }

    /// @notice The grammar is re-checked here even though the emitter checked it,
    ///         so no single contract's correctness is load-bearing for the whole
    ///         pipeline. The payload below is one GenLayer's own emitter would
    ///         never produce — which is the point.
    function test_forwardVerdict_rejectsIncoherentVerdict() public {
        bytes memory payload = abi.encode(
            forwarder.VERDICT_MESSAGE_TAG(), CASE, HASH, VerdictLib.NO_BREACH, uint16(10_000), uint8(0)
        );
        _commitHonest(payload);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                L1VerdictForwarder.IncoherentVerdict.selector, VerdictLib.NO_BREACH, uint16(10_000), uint8(0)
            )
        );
        forwarder.forwardVerdict(BATCH, INDEX, TX_IN_BATCH, payload, _proof());

        assertEq(bridge.sentCount(), 0);
    }

    /// @notice One forward per case. A second is never useful: an OP Stack
    ///         message that fails on Base is replayable there with the same
    ///         parameters, so recovery never requires paying Ethereum gas twice.
    function test_forwardVerdict_replayGuard() public {
        bytes memory payload = _emitted(CASE, HASH, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);
        _commitHonest(payload);
        _forward(payload);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(L1VerdictForwarder.AlreadyForwarded.selector, CASE));
        forwarder.forwardVerdict(BATCH, INDEX, TX_IN_BATCH, payload, _proof());

        assertEq(bridge.sentCount(), 1, "the Base bridge must be paid for once");
    }

    /// @notice The guard is per case, not global: an unrelated verdict proven in
    ///         the same batch still gets through.
    function test_forwardVerdict_replayGuardIsPerCase() public {
        bytes32 second = keccak256("case-2");

        bytes memory a = _emitted(CASE, HASH, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);
        _commitHonest(a);
        _forward(a);

        bytes memory b = _emitted(second, keccak256("h2"), VerdictLib.NO_BREACH, 0, 0);
        _commit(b, BATCH, INDEX + 1, TX_IN_BATCH, address(emitter));

        vm.prank(keeper);
        forwarder.forwardVerdict(BATCH, INDEX + 1, TX_IN_BATCH, b, _proof());

        assertTrue(forwarder.forwarded(CASE));
        assertTrue(forwarder.forwarded(second));
        assertEq(bridge.sentCount(), 2);
    }

    // ---------------------------------------------------------------------
    // Grammar parity across the three chains
    // ---------------------------------------------------------------------

    /// @notice `ICanonicalVerdictReceiver` is declared locally in the forwarder
    ///         rather than imported, because a contract on Ethereum genuinely
    ///         does not depend on the Base deployment. This is the check that
    ///         keeps the two from drifting apart — the forwarder's own doc
    ///         comment promises it exists.
    function test_selectorMatchesTheBaseReceiver() public pure {
        assertEq(
            ICanonicalVerdictReceiver.deliverVerdict.selector,
            CanonicalVerdictReceiver.deliverVerdict.selector,
            "forwarder's local interface has drifted from the Base receiver"
        );
    }

    /// @notice The tag is duplicated as a constant in two contracts on two
    ///         chains. If they diverge, every verdict fails to forward.
    function test_messageTagMatchesTheEmitter() public view {
        assertEq(forwarder.VERDICT_MESSAGE_TAG(), emitter.VERDICT_MESSAGE_TAG());
    }

    function test_decodeVerdict_roundTripsTheEmittersEncoding() public {
        bytes memory payload = _emitted(CASE, HASH, VerdictLib.UNAUTHORIZED_TOOL_CALL, 7_500, 1);
        L1VerdictForwarder.ProvenVerdict memory v = forwarder.decodeVerdict(payload);

        assertEq(v.caseId, CASE);
        assertEq(v.verdictHash, HASH);
        assertEq(v.code, VerdictLib.UNAUTHORIZED_TOOL_CALL);
        assertEq(v.payoutBps, 7_500);
        assertEq(v.severity, 1);
    }

    /// @notice `decodeVerdict` is the keeper's pre-flight check, so it must reject
    ///         exactly what `forwardVerdict` would — otherwise a keeper could pass
    ///         its own check and still burn Ethereum gas on a revert.
    function test_decodeVerdict_rejectsWhatForwardingWouldReject() public {
        // Every payload is built up front. `expectRevert` binds to the very next
        // call, and `VERDICT_MESSAGE_TAG()` is an external staticcall — reading it
        // inline would absorb the expectation and the test would pass without
        // ever reaching `decodeVerdict`.
        bytes32 tag = forwarder.VERDICT_MESSAGE_TAG();
        bytes32 otherTag = keccak256("AgentWarrantyCourt.SomethingElse.v1");

        bytes memory short = abi.encode(tag, CASE);
        bytes memory wrongTag = abi.encode(otherTag, CASE, HASH, VerdictLib.NO_BREACH, uint16(0), uint8(0));
        bytes memory noHash = abi.encode(tag, CASE, bytes32(0), VerdictLib.NO_BREACH, uint16(0), uint8(0));
        bytes memory incoherent = abi.encode(tag, CASE, HASH, VerdictLib.SILENT_FAILURE, uint16(0), uint8(2));

        vm.expectRevert(L1VerdictForwarder.MalformedPayload.selector);
        forwarder.decodeVerdict(short);

        vm.expectRevert(abi.encodeWithSelector(L1VerdictForwarder.UnknownMessageTag.selector, otherTag));
        forwarder.decodeVerdict(wrongTag);

        vm.expectRevert(L1VerdictForwarder.EmptyVerdictHash.selector);
        forwarder.decodeVerdict(noHash);

        vm.expectRevert(
            abi.encodeWithSelector(
                L1VerdictForwarder.IncoherentVerdict.selector, VerdictLib.SILENT_FAILURE, uint16(0), uint8(2)
            )
        );
        forwarder.decodeVerdict(incoherent);
    }

    // ---------------------------------------------------------------------
    // Properties
    // ---------------------------------------------------------------------

    /// @notice End to end across two chains: whatever the court decided, a proven
    ///         message arrives on Base as exactly that verdict and nothing else.
    function testFuzz_provenVerdictsCrossIntact(bytes32 caseId, bytes32 verdictHash, uint256 seed) public {
        vm.assume(verdictHash != bytes32(0));
        (uint8 code, uint16 payoutBps, uint8 severity) = _coherentVerdict(seed);

        bytes memory payload = _emitted(caseId, verdictHash, code, payoutBps, severity);
        _commitHonest(payload);
        _forward(payload);

        assertEq(bridge.sentCount(), 1);
        assertEq(bridge.lastSent().target, baseReceiver);
        assertEq(
            bridge.lastSent().message,
            abi.encodeCall(
                ICanonicalVerdictReceiver.deliverVerdict, (caseId, verdictHash, code, payoutBps, severity)
            )
        );
    }

    /// @notice No caller, and no proof that was not committed for *this* emitter,
    ///         ever reaches the Base bridge.
    function testFuzz_uncommittedProofsNeverReachBase(
        address caller,
        uint256 batch,
        uint256 index,
        uint16 txInBatch,
        bytes32 caseId
    ) public {
        bytes memory payload = emitter.encodeVerdict(caseId, keccak256("h"), VerdictLib.NO_BREACH, 0, 0);

        vm.prank(caller);
        vm.expectRevert(L1VerdictForwarder.InvalidInclusionProof.selector);
        forwarder.forwardVerdict(batch, index, txInBatch, payload, _proof());

        assertFalse(forwarder.forwarded(caseId));
        assertEq(bridge.sentCount(), 0);
    }
}
