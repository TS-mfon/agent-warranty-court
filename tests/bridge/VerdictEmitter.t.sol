// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BridgeFixture} from "./BridgeFixture.sol";
import {VerdictLib} from "../../contracts/shared/VerdictLib.sol";
import {VerdictEmitter} from "../../contracts/genlayer-evm/VerdictEmitter.sol";

/// @notice The Intelligent Contract's foot on GenLayer's EVM side.
///
/// @dev Two things are load-bearing here and neither is obvious from the code:
///      the L1 message must be sent on *every* verdict (it cannot be
///      manufactured later, when a challenge appears), and a duplicate must
///      behave asymmetrically — identical values are a clean no-op, conflicting
///      values revert. Both are tested directly rather than assumed.
contract VerdictEmitterTest is BridgeFixture {
    bytes32 internal constant CASE = keccak256("case-1");
    bytes32 internal constant HASH = keccak256("verdict-reasoning-1");

    // ---------------------------------------------------------------------
    // Construction and wiring
    // ---------------------------------------------------------------------

    function test_constructor_rejectsZeroCourt() public {
        vm.expectRevert(VerdictEmitter.ZeroAddress.selector);
        new VerdictEmitter(address(0));
    }

    function test_constructor_pinsTheCourt() public view {
        assertEq(emitter.court(), court);
    }

    /// @notice The messenger address is a ZK Stack protocol constant, not a
    ///         configuration choice. Reading it back guards against a typo that
    ///         would silently send verdicts nowhere.
    function test_l1MessengerIsTheZkStackSystemAddress() public view {
        assertEq(address(emitter.L1_MESSENGER()), L1_MESSENGER_ADDR);
    }

    function test_unpublishedCaseReadsAsEmpty() public view {
        assertFalse(emitter.isPublished(CASE));
        VerdictEmitter.Verdict memory v = emitter.verdictOf(CASE);
        assertEq(v.verdictHash, bytes32(0));
        assertEq(v.code, 0);
        assertEq(v.payoutBps, 0);
        assertEq(v.severity, 0);
        assertFalse(v.published);
    }

    // ---------------------------------------------------------------------
    // Authentication
    // ---------------------------------------------------------------------

    /// @notice The whole authentication story: GenLayer routes external messages
    ///         through the IC's ghost, and ghost and IC share one address, so a
    ///         single equality is the check. If it were missing, anyone on
    ///         GenLayer's EVM side could mint verdicts for the Ethereum backstop.
    function test_publishVerdict_onlyCourtMayPublish() public {
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(VerdictEmitter.NotCourt.selector, outsider));
        emitter.publishVerdict(CASE, HASH, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);

        assertEq(l1Messenger.sentCount(), 0, "a rejected caller must not reach Ethereum");
    }

    // ---------------------------------------------------------------------
    // The happy path
    // ---------------------------------------------------------------------

    function test_publishVerdict_storesEmitsAndSendsToL1() public {
        bytes memory expectedPayload =
            emitter.encodeVerdict(CASE, HASH, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);
        bytes32 expectedHandle = keccak256(expectedPayload);

        vm.expectEmit(true, false, false, true, address(emitter));
        emit VerdictEmitter.VerdictFinalized(
            CASE, HASH, VerdictLib.DEAD_LINK_CITATION, 5_000, 2, expectedHandle
        );
        bytes32 handle = _publish(CASE, HASH, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);

        assertEq(handle, expectedHandle);

        VerdictEmitter.Verdict memory v = emitter.verdictOf(CASE);
        assertTrue(v.published);
        assertEq(v.verdictHash, HASH);
        assertEq(v.code, VerdictLib.DEAD_LINK_CITATION);
        assertEq(v.payoutBps, 5_000);
        assertEq(v.severity, 2);
        assertTrue(emitter.isPublished(CASE));

        assertEq(l1Messenger.sentCount(), 1);
        assertEq(l1Messenger.lastSent(), expectedPayload);
    }

    /// @notice The design decision the contract's docstring argues for: the
    ///         Ethereum message goes out on every verdict, not only on contested
    ///         ones. An L2→L1 message is a log committed inside its own batch and
    ///         cannot be created retroactively, so a challenge-triggered send
    ///         would have no proof material to work with.
    function test_publishVerdict_sendsToL1EvenWithNoBreach() public {
        _publish(CASE, HASH, VerdictLib.NO_BREACH, 0, 0);
        assertEq(l1Messenger.sentCount(), 1, "an uncontested acquittal still needs proof material");
        assertEq(l1Messenger.lastSent(), emitter.encodeVerdict(CASE, HASH, VerdictLib.NO_BREACH, 0, 0));
    }

    function test_publishVerdict_sendsOneMessagePerCase() public {
        _publish(keccak256("a"), keccak256("ha"), VerdictLib.NO_BREACH, 0, 0);
        _publish(keccak256("b"), keccak256("hb"), VerdictLib.SILENT_FAILURE, 10_000, 3);
        _publish(keccak256("c"), keccak256("hc"), VerdictLib.EVIDENCE_UNAVAILABLE, 0, 0);
        assertEq(l1Messenger.sentCount(), 3);
    }

    // ---------------------------------------------------------------------
    // The grammar gate
    // ---------------------------------------------------------------------

    function test_publishVerdict_rejectsEmptyVerdictHash() public {
        vm.prank(court);
        vm.expectRevert(VerdictEmitter.EmptyVerdictHash.selector);
        emitter.publishVerdict(CASE, bytes32(0), VerdictLib.NO_BREACH, 0, 0);
        assertEq(l1Messenger.sentCount(), 0);
    }

    /// @notice The shape a half-successful prompt injection produces: every field
    ///         individually legal, incoherent together. Stopping it here means
    ///         the Ethereum forwarder and the Base inbox are never asked to
    ///         reason about a malformed verdict at all.
    function test_publishVerdict_rejectsNoBreachWithPayout() public {
        _expectIncoherent(VerdictLib.NO_BREACH, 10_000, 0);
    }

    function test_publishVerdict_rejectsBreachWithoutPayout() public {
        _expectIncoherent(VerdictLib.SILENT_FAILURE, 0, 2);
    }

    function test_publishVerdict_rejectsBreachWithoutSeverity() public {
        _expectIncoherent(VerdictLib.SILENT_FAILURE, 5_000, 0);
    }

    function test_publishVerdict_rejectsNonBucketPayout() public {
        _expectIncoherent(VerdictLib.DEAD_LINK_CITATION, 6_347, 2);
    }

    function test_publishVerdict_rejectsPayoutBelowBreachFloor() public {
        _expectIncoherent(VerdictLib.DEAD_LINK_CITATION, 1_000, 1);
    }

    function test_publishVerdict_rejectsOffEnumCode() public {
        _expectIncoherent(VerdictLib.MAX_CODE + 1, 5_000, 2);
    }

    function test_publishVerdict_rejectsSeverityAboveMax() public {
        _expectIncoherent(VerdictLib.SILENT_FAILURE, 5_000, VerdictLib.MAX_SEVERITY + 1);
    }

    /// @notice Evidence unavailable is a status, not a finding of fault. A payout
    ///         attached to it would turn an unreachable transcript host into a
    ///         way to extract money from a provider who may have done nothing
    ///         wrong.
    function test_publishVerdict_rejectsEvidenceUnavailableWithPayout() public {
        _expectIncoherent(VerdictLib.EVIDENCE_UNAVAILABLE, 2_500, 1);
    }

    function _expectIncoherent(uint8 code, uint16 payoutBps, uint8 severity) internal {
        vm.prank(court);
        vm.expectRevert(
            abi.encodeWithSelector(VerdictEmitter.IncoherentVerdict.selector, code, payoutBps, severity)
        );
        emitter.publishVerdict(CASE, HASH, code, payoutBps, severity);

        assertFalse(emitter.isPublished(CASE), "a rejected verdict must not be stored");
        assertEq(l1Messenger.sentCount(), 0, "a rejected verdict must not reach Ethereum");
    }

    // ---------------------------------------------------------------------
    // Idempotency, and why it is asymmetric
    // ---------------------------------------------------------------------

    /// @notice A repeat of the same verdict is a no-op that returns cleanly.
    ///         Reverting would be worse than useless: the caller is GenLayer's
    ///         ghost via `handleOp()`, where a revert turns a harmless duplicate
    ///         into a stuck message.
    function test_publishVerdict_identicalDuplicateIsACleanNoOp() public {
        _publish(CASE, HASH, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);

        vm.expectEmit(true, false, false, false, address(emitter));
        emit VerdictEmitter.DuplicateIgnored(CASE);
        bytes32 handle = _publish(CASE, HASH, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);

        assertEq(handle, bytes32(0), "a duplicate produces no new L1 handle");
        assertEq(l1Messenger.sentCount(), 1, "a duplicate must not send a second L1 message");

        // And the stored verdict is untouched.
        VerdictEmitter.Verdict memory v = emitter.verdictOf(CASE);
        assertEq(v.verdictHash, HASH);
        assertEq(v.payoutBps, 5_000);
    }

    /// @notice A *different* verdict for a published case reverts. This should be
    ///         unreachable — the IC decides a case once, and external messages
    ///         only fire after finalization — but the alternative to failing
    ///         loudly is silently accepting a rewritten verdict.
    function test_publishVerdict_conflictingVerdictHashReverts() public {
        _publish(CASE, HASH, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);
        _expectConflict(keccak256("different reasoning"), VerdictLib.DEAD_LINK_CITATION, 5_000, 2);
    }

    function test_publishVerdict_conflictingCodeReverts() public {
        _publish(CASE, HASH, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);
        _expectConflict(HASH, VerdictLib.SILENT_FAILURE, 5_000, 2);
    }

    function test_publishVerdict_conflictingPayoutReverts() public {
        _publish(CASE, HASH, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);
        _expectConflict(HASH, VerdictLib.DEAD_LINK_CITATION, 10_000, 2);
    }

    function test_publishVerdict_conflictingSeverityReverts() public {
        _publish(CASE, HASH, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);
        _expectConflict(HASH, VerdictLib.DEAD_LINK_CITATION, 5_000, 3);
    }

    function _expectConflict(bytes32 verdictHash, uint8 code, uint16 payoutBps, uint8 severity) internal {
        vm.prank(court);
        vm.expectRevert(abi.encodeWithSelector(VerdictEmitter.VerdictConflict.selector, CASE));
        emitter.publishVerdict(CASE, verdictHash, code, payoutBps, severity);

        assertEq(l1Messenger.sentCount(), 1, "a conflicting rewrite must not reach Ethereum");
    }

    // ---------------------------------------------------------------------
    // The payload
    // ---------------------------------------------------------------------

    /// @notice The tag is what stops a future second message type from this same
    ///         address being read as a verdict by a forwarder that predates it.
    function test_encodeVerdict_isTaggedAndDecodable() public view {
        bytes memory payload = emitter.encodeVerdict(CASE, HASH, VerdictLib.DEAD_LINK_CITATION, 5_000, 2);
        assertEq(payload.length, 6 * 32, "six fixed words");

        (bytes32 tag, bytes32 caseId, bytes32 verdictHash, uint8 code, uint16 payoutBps, uint8 severity) =
            abi.decode(payload, (bytes32, bytes32, bytes32, uint8, uint16, uint8));

        assertEq(tag, emitter.VERDICT_MESSAGE_TAG());
        assertEq(tag, keccak256("AgentWarrantyCourt.Verdict.v1"));
        assertEq(caseId, CASE);
        assertEq(verdictHash, HASH);
        assertEq(code, VerdictLib.DEAD_LINK_CITATION);
        assertEq(payoutBps, 5_000);
        assertEq(severity, 2);
    }

    /// @notice Distinct cases produce distinct payloads, so an inclusion proof
    ///         for one verdict can never be replayed as a proof for another.
    function test_encodeVerdict_isInjectiveOverCases() public view {
        bytes memory a = emitter.encodeVerdict(keccak256("a"), HASH, VerdictLib.NO_BREACH, 0, 0);
        bytes memory b = emitter.encodeVerdict(keccak256("b"), HASH, VerdictLib.NO_BREACH, 0, 0);
        assertTrue(keccak256(a) != keccak256(b));
    }

    // ---------------------------------------------------------------------
    // Properties
    // ---------------------------------------------------------------------

    function testFuzz_anyCoherentVerdictPublishesAndRoundTrips(bytes32 caseId, bytes32 verdictHash, uint256 seed)
        public
    {
        vm.assume(verdictHash != bytes32(0));
        (uint8 code, uint16 payoutBps, uint8 severity) = _coherentVerdict(seed);

        assertEq(_publish(caseId, verdictHash, code, payoutBps, severity), keccak256(l1Messenger.lastSent()));
        assertEq(l1Messenger.sentCount(), 1);

        // The bytes on the wire are exactly what the pure encoder produces. That
        // equality is the one that matters: an inclusion proof is built against
        // `encodeVerdict`'s output, so if the two ever diverged every proof would
        // be constructed for a message that was never sent.
        assertEq(l1Messenger.lastSent(), emitter.encodeVerdict(caseId, verdictHash, code, payoutBps, severity));

        VerdictEmitter.Verdict memory stored = emitter.verdictOf(caseId);
        assertTrue(stored.published);
        assertEq(stored.verdictHash, verdictHash);
        assertEq(stored.code, code);
        assertEq(stored.payoutBps, payoutBps);
        assertEq(stored.severity, severity);
    }

    /// @notice Whatever the inputs, a caller that is not the court never moves
    ///         anything — no storage, no Ethereum message.
    function testFuzz_nonCourtCallerNeverPublishes(address caller, bytes32 caseId, bytes32 verdictHash, uint256 seed)
        public
    {
        vm.assume(caller != court);
        (uint8 code, uint16 payoutBps, uint8 severity) = _coherentVerdict(seed);

        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(VerdictEmitter.NotCourt.selector, caller));
        emitter.publishVerdict(caseId, verdictHash, code, payoutBps, severity);

        assertFalse(emitter.isPublished(caseId));
        assertEq(l1Messenger.sentCount(), 0);
    }
}
