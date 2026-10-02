// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {VerdictLib} from "../../contracts/shared/VerdictLib.sol";
import {VerdictEmitter} from "../../contracts/genlayer-evm/VerdictEmitter.sol";

import {MockL1Messenger} from "./mocks/BridgeMocks.sol";

/// @notice Shared setup for the two chains the bridge spans.
///
/// @dev Both suites need a `VerdictEmitter` and both need the ZK Stack messenger
///      to exist at its system address — the forwarder suite because it derives
///      its payloads from a real emitted verdict rather than from a hand-written
///      byte string. Deriving them is the point: a hand-written payload would
///      still pass every forwarder test after the emitter's encoding changed.
abstract contract BridgeFixture is Test {
    /// @dev The ZK Stack `L1Messenger` system address, matching the constant
    ///      compiled into `VerdictEmitter`.
    address internal constant L1_MESSENGER_ADDR = 0x0000000000000000000000000000000000008008;

    /// @dev A fixture value, not a protocol constant. Phase 0 did not resolve
    ///      GenLayer Chain's id, and no test here depends on the real number —
    ///      only on the forwarder pinning *some* id and refusing proofs made
    ///      under any other.
    uint256 internal constant GENLAYER_CHAIN_ID = 424_242;

    uint32 internal constant BASE_GAS_LIMIT = 500_000;

    MockL1Messenger internal l1Messenger;
    VerdictEmitter internal emitter;

    /// @dev Stands in for the Intelligent Contract's ghost. On GenLayer the ghost
    ///      and the IC share one address, so a plain EOA under `vm.prank` is a
    ///      faithful model of the only caller the emitter will ever accept.
    address internal court;
    address internal outsider;

    function setUp() public virtual {
        court = makeAddr("genlayerCourt");
        outsider = makeAddr("outsider");

        MockL1Messenger template = new MockL1Messenger();
        vm.etch(L1_MESSENGER_ADDR, address(template).code);
        l1Messenger = MockL1Messenger(L1_MESSENGER_ADDR);

        emitter = new VerdictEmitter(court);
    }

    function _publish(bytes32 caseId, bytes32 verdictHash, uint8 code, uint16 payoutBps, uint8 severity)
        internal
        returns (bytes32)
    {
        vm.prank(court);
        return emitter.publishVerdict(caseId, verdictHash, code, payoutBps, severity);
    }

    /// @dev The same generator the escrow invariants use, so every layer of the
    ///      pipeline is fuzzed against one shared notion of a legal verdict.
    ///
    ///      Takes a single seed rather than one per field. Three separate fuzz
    ///      parameters, plus the three values they produce, plus a payload and a
    ///      decoded struct is enough live locals to overflow solc's stack in the
    ///      calling test — and `viaIR` is a heavy answer to a problem that a
    ///      narrower signature solves outright.
    function _coherentVerdict(uint256 seed) internal pure returns (uint8 code, uint16 payoutBps, uint8 severity) {
        // casting to 'uint8' is safe because `% 7` bounds the value to 0..6,
        // which is exactly the verdict code enum's range.
        // forge-lint: disable-next-line(unsafe-typecast)
        code = uint8(seed % 7);
        if (code == VerdictLib.NO_BREACH || code == VerdictLib.EVIDENCE_UNAVAILABLE) {
            return (code, 0, 0);
        }
        uint16[4] memory buckets = [2_500, 5_000, 7_500, 10_000];
        payoutBps = buckets[(seed >> 8) % 4];
        severity = uint8(((seed >> 16) % 3) + 1);
    }
}
