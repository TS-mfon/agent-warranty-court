// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VerdictLib} from "../shared/VerdictLib.sol";

/// @title ReputationLog
/// @notice Append-only breach record for adjudicated cases.
///
/// @dev A stand-in for the ERC-8004 Reputation Registry, whose Base deployment
///      address was not confirmed during planning (Phase 0 item 4). It is
///      deliberately write-only and event-shaped: the moment the canonical
///      registry address is verified, the escrow can be pointed at it and the
///      history here remains readable from logs. Nothing in the settlement path
///      reads this contract, so swapping it cannot strand funds.
///
///      Known gap, carried from the plan and not a v1 blocker: records are
///      written only on an adjudicated breach, so a provider who quietly
///      refunds to avoid a verdict accrues no signal. That is exploitable over
///      time and deserves a settlement-side record once there is live data.
contract ReputationLog {
    address public escrow;

    /// @param caseId  The dispute, matching the GenLayer case and the inbox key.
    /// @param score   0-100, derived from severity. Higher is worse.
    /// @param dataUri Off-chain pointer to the verdict payload committed to by
    ///                `verdictHash`, so a reader can audit the reasoning rather
    ///                than trusting the score.
    event BreachRecorded(
        address indexed provider,
        address indexed client,
        bytes32 indexed caseId,
        uint256 erc8004TokenId,
        uint8 violationCode,
        uint8 severity,
        uint8 score,
        bytes32 verdictHash,
        string dataUri
    );

    event EscrowSet(address indexed escrow);

    error NotEscrow();
    error EscrowAlreadySet();
    error ZeroAddress();

    function setEscrow(address escrow_) external {
        if (escrow != address(0)) revert EscrowAlreadySet();
        if (escrow_ == address(0)) revert ZeroAddress();
        escrow = escrow_;
        emit EscrowSet(escrow_);
    }

    function recordBreach(
        address provider,
        address client,
        bytes32 caseId,
        uint256 erc8004TokenId,
        uint8 violationCode,
        uint8 severity,
        bytes32 verdictHash,
        string calldata dataUri
    ) external {
        if (msg.sender != escrow) revert NotEscrow();
        emit BreachRecorded(
            provider,
            client,
            caseId,
            erc8004TokenId,
            violationCode,
            severity,
            _score(severity),
            verdictHash,
            dataUri
        );
    }

    /// @dev Severity 1/2/3 maps onto the same 10/25/50 shape as the stake
    ///      slash, so a reader comparing reputation against collateral sees one
    ///      consistent scale rather than two unrelated ones.
    function _score(uint8 severity) private pure returns (uint8) {
        if (severity == 1) return 10;
        if (severity == 2) return 25;
        if (severity >= VerdictLib.MAX_SEVERITY) return 50;
        return 0;
    }
}
