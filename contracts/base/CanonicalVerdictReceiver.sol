// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VerdictInbox} from "./VerdictInbox.sol";

/// @notice The Base (OP Stack) L2 messenger surface used by the backstop.
interface ICrossDomainMessenger {
    function xDomainMessageSender() external view returns (address);
}

/// @title CanonicalVerdictReceiver
/// @notice Terminus of the trustless backstop: GenLayer -> Ethereum L1 -> Base.
///
/// @dev Only ever touched when a challenge is raised, so the L1 gas is
///      amortized across the rare contested case and never appears on the happy
///      path. End-to-end latency is on the order of hours — ZK batch formation,
///      roughly an hour of proving, a multi-hour execution delay to Ethereum,
///      then Ethereum->Base messaging — which is why it resolves disputes
///      rather than carrying every verdict.
///
///      ## Both authentication checks are mandatory
///
///      `msg.sender == messenger` alone proves only that *some* L1 contract
///      sent this message, and any address on L1 can call the messenger. So it
///      would let anyone forge a verdict. `xDomainMessageSender() == forwarder`
///      alone is worse: read outside a real cross-domain call it returns stale
///      or zero data, and a direct caller controls `msg.sender` entirely.
///      Together they establish that the L1 forwarder, specifically, is
///      speaking. Either one on its own is a complete authentication bypass.
contract CanonicalVerdictReceiver {
    VerdictInbox public immutable inbox;
    ICrossDomainMessenger public immutable messenger;

    /// @notice The L1 contract that receives GenLayer's canonical L2->L1
    ///         message and forwards it to Base. Immutable: a settable value
    ///         here would be equivalent to an owner who can rewrite verdicts.
    address public immutable l1Forwarder;

    event CanonicalVerdictDelivered(bytes32 indexed caseId, uint8 code, uint16 payoutBps, uint8 severity);

    error ZeroAddress();
    error NotMessenger(address caller);
    error NotL1Forwarder(address xDomainSender);

    constructor(VerdictInbox inbox_, ICrossDomainMessenger messenger_, address l1Forwarder_) {
        if (address(inbox_) == address(0) || address(messenger_) == address(0) || l1Forwarder_ == address(0)) {
            revert ZeroAddress();
        }
        inbox = inbox_;
        messenger = messenger_;
        l1Forwarder = l1Forwarder_;
    }

    /// @notice Deliver GenLayer's finalized verdict and resolve the challenge.
    function deliverVerdict(bytes32 caseId, bytes32 verdictHash, uint8 code, uint16 payoutBps, uint8 severity)
        external
    {
        if (msg.sender != address(messenger)) revert NotMessenger(msg.sender);

        address xSender = messenger.xDomainMessageSender();
        if (xSender != l1Forwarder) revert NotL1Forwarder(xSender);

        inbox.resolveChallenge(caseId, verdictHash, code, payoutBps, severity);
        emit CanonicalVerdictDelivered(caseId, code, payoutBps, severity);
    }
}
