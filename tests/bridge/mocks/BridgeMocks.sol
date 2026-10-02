// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {L2Message} from "../../../contracts/l1/L1VerdictForwarder.sol";

/// @notice Stand-in for the ZK Stack `L1Messenger` system contract.
///
/// @dev Etched over `0x...8008` by the fixture, because `VerdictEmitter` holds
///      that address as a constant and a call to an empty address would return
///      success with no returndata — the emitter would then fail decoding its
///      `bytes32`, and the test would be measuring the wrong thing.
///
///      Returning `keccak256(message)` is not arbitrary: that is the `value` the
///      real system contract writes into the L2→L1 log, so a test asserting on
///      the returned handle is asserting on the same commitment Ethereum will
///      later verify a preimage against.
contract MockL1Messenger {
    bytes[] internal _sent;

    function sendToL1(bytes calldata message) external returns (bytes32) {
        _sent.push(message);
        return keccak256(message);
    }

    function sentCount() external view returns (uint256) {
        return _sent.length;
    }

    function sentAt(uint256 i) external view returns (bytes memory) {
        return _sent[i];
    }

    function lastSent() external view returns (bytes memory) {
        return _sent[_sent.length - 1];
    }
}

/// @notice Stand-in for GenLayer's L2→L1 message verifier on Ethereum.
///
/// @dev Deliberately not a settable `bool accept`. A pass/fail switch would let
///      every forwarder test succeed for the wrong reason: the properties worth
///      proving are that a *specific* `(chainId, batch, index, message, proof)`
///      tuple is what verifies, and that changing any part of it — above all
///      `message.sender` — makes verification fail. So this mock models the real
///      semantics: `commit` records exactly one tuple, and nothing else ever
///      proves.
contract MockMessageVerifier {
    mapping(bytes32 => bool) private _committed;

    function commit(
        uint256 chainId,
        uint256 batchNumber,
        uint256 index,
        L2Message calldata message,
        bytes32[] calldata proof
    ) external {
        _committed[_key(chainId, batchNumber, index, message, proof)] = true;
    }

    function proveL2MessageInclusionShared(
        uint256 _chainId,
        uint256 _blockOrBatchNumber,
        uint256 _index,
        L2Message calldata _message,
        bytes32[] calldata _proof
    ) external view returns (bool) {
        return _committed[_key(_chainId, _blockOrBatchNumber, _index, _message, _proof)];
    }

    function _key(
        uint256 chainId,
        uint256 batchNumber,
        uint256 index,
        L2Message calldata message,
        bytes32[] calldata proof
    ) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                chainId, batchNumber, index, message.txNumberInBatch, message.sender, keccak256(message.data), proof
            )
        );
    }
}

/// @notice Stand-in for Ethereum's `L1CrossDomainMessenger` for Base.
/// @dev Records rather than delivers. What the forwarder's tests need to assert
///      is the exact calldata and gas limit handed to the bridge; actually
///      executing it on the Base side is `VerdictInbox`'s own suite, which drives
///      the receiver through `MockMessenger` instead.
contract MockL1Bridge {
    struct Sent {
        address target;
        bytes message;
        uint32 gasLimit;
    }

    Sent[] internal _sent;

    function sendMessage(address _target, bytes calldata _message, uint32 _minGasLimit) external {
        _sent.push(Sent({target: _target, message: _message, gasLimit: _minGasLimit}));
    }

    function sentCount() external view returns (uint256) {
        return _sent.length;
    }

    function lastSent() external view returns (Sent memory) {
        return _sent[_sent.length - 1];
    }
}
