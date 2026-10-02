// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "./interfaces/IERC20.sol";
import {SafeTransfer} from "./libraries/SafeTransfer.sol";

/// @title ProviderStake
/// @notice Collateral that makes a warranty enforceable rather than advisory.
///
/// @dev The contract has no owner and no admin path to move funds. Every
///      balance-changing entry point is either the staker acting on their own
///      position or the escrow acting under a finalized verdict.
///
///      Two separate freezes, because they answer different questions:
///
///      * `locked` is per-job collateral. It stops a provider from taking on
///        more warranted work than its stake can cover, and it is the pool a
///        slash is drawn from.
///      * `openDisputes` is a counter. It stops the unbonding clock entirely
///        while a dispute is live.
///
///      Locking alone is not enough: unbonding takes longer than a job, so a
///      provider whose only open job is disputed would otherwise start the
///      clock and walk away with everything not locked to that one case. And a
///      counter alone is not enough either: without per-job locking, a provider
///      could accept a hundred jobs against one job's worth of stake.
contract ProviderStake {
    using SafeTransfer for IERC20;

    /// @notice Floor on the unbonding delay.
    /// @dev Must exceed the worst-case life of a dispute: the GenLayer appeal
    ///      window (governance-managed, pauses during appeal voting, and reset
    ///      by a won appeal — so it has no constant upper bound) plus the Base
    ///      challenge window plus the canonical-bridge timeout. 21 days is a
    ///      margin over the ~3h canonical path and the 14d canonical timeout,
    ///      not a derived bound; it is a floor precisely because no derived
    ///      bound exists.
    uint64 public constant MIN_UNBONDING_DELAY = 21 days;

    struct Unbonding {
        uint256 amount;
        uint64 readyAt;
    }

    IERC20 public immutable token;
    uint64 public immutable unbondingDelay;

    address public escrow;

    mapping(address => uint256) public totalStaked;
    mapping(address => uint256) public locked;
    mapping(address => uint256) public openDisputes;
    mapping(address => Unbonding) public unbonding;

    event EscrowSet(address indexed escrow);
    event Staked(address indexed provider, uint256 amount, uint256 total);
    event UnbondRequested(address indexed provider, uint256 amount, uint64 readyAt);
    event UnbondCancelled(address indexed provider, uint256 amount);
    event Withdrawn(address indexed provider, uint256 amount);
    event Locked(address indexed provider, uint256 amount, uint256 totalLocked);
    event Unlocked(address indexed provider, uint256 amount, uint256 totalLocked);
    event Slashed(address indexed provider, uint256 amount, address indexed recipient);
    event DisputeOpened(address indexed provider, uint256 open);
    event DisputeClosed(address indexed provider, uint256 open);

    error NotEscrow();
    error EscrowAlreadySet();
    error ZeroAddress();
    error ZeroAmount();
    error UnbondingDelayTooShort();
    error InsufficientAvailableStake(uint256 requested, uint256 available);
    error InsufficientLockedStake(uint256 requested, uint256 locked);
    error DisputeOpen();
    error NoUnbondingRequest();
    error UnbondingNotReady(uint64 readyAt);
    error UnbondingAlreadyPending();

    modifier onlyEscrow() {
        if (msg.sender != escrow) revert NotEscrow();
        _;
    }

    constructor(IERC20 token_, uint64 unbondingDelay_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        if (unbondingDelay_ < MIN_UNBONDING_DELAY) revert UnbondingDelayTooShort();
        token = token_;
        unbondingDelay = unbondingDelay_;
    }

    /// @notice Wire the escrow exactly once.
    /// @dev The escrow needs this contract's address at construction and this
    ///      contract needs the escrow's, so one of the two must be set after
    ///      deployment. Making it one-shot and permanently locked confines the
    ///      trust to the deployment transaction: once set, no party — deployer
    ///      included — can repoint it at a contract that would drain stake.
    function setEscrow(address escrow_) external {
        if (escrow != address(0)) revert EscrowAlreadySet();
        if (escrow_ == address(0)) revert ZeroAddress();
        escrow = escrow_;
        emit EscrowSet(escrow_);
    }

    /// @notice Stake that is neither committed to a job nor already unbonding.
    function availableStake(address provider) public view returns (uint256) {
        uint256 total = totalStaked[provider];
        uint256 encumbered = locked[provider] + unbonding[provider].amount;
        // Slashing reduces `totalStaked` and `locked` together, so this cannot
        // underflow; the clamp is belt-and-braces against a future edit that
        // breaks that pairing.
        return total > encumbered ? total - encumbered : 0;
    }

    function stake(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        totalStaked[msg.sender] += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount, totalStaked[msg.sender]);
    }

    /// @notice Start the unbonding clock on unencumbered stake.
    function requestUnbond(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (openDisputes[msg.sender] != 0) revert DisputeOpen();
        if (unbonding[msg.sender].amount != 0) revert UnbondingAlreadyPending();

        uint256 available = availableStake(msg.sender);
        if (amount > available) revert InsufficientAvailableStake(amount, available);

        uint64 readyAt = uint64(block.timestamp) + unbondingDelay;
        unbonding[msg.sender] = Unbonding({amount: amount, readyAt: readyAt});
        emit UnbondRequested(msg.sender, amount, readyAt);
    }

    /// @notice Abandon a pending unbonding request and return the stake to
    ///         active duty, so a provider is not locked out of new work for the
    ///         full delay after changing its mind.
    function cancelUnbond() external {
        uint256 amount = unbonding[msg.sender].amount;
        if (amount == 0) revert NoUnbondingRequest();
        delete unbonding[msg.sender];
        emit UnbondCancelled(msg.sender, amount);
    }

    /// @notice Withdraw unbonded stake.
    /// @dev The dispute check is repeated here on purpose. `requestUnbond`
    ///      only proves no dispute was open when the clock *started*; this
    ///      proves none is open when the money actually leaves. Without the
    ///      second check, a provider could unbond pre-emptively and withdraw
    ///      straight through a dispute filed the next day.
    function withdraw() external {
        Unbonding memory req = unbonding[msg.sender];
        if (req.amount == 0) revert NoUnbondingRequest();
        if (block.timestamp < req.readyAt) revert UnbondingNotReady(req.readyAt);
        if (openDisputes[msg.sender] != 0) revert DisputeOpen();

        // A slash during unbonding can leave the request larger than the
        // balance behind it; pay what actually exists.
        uint256 amount = req.amount;
        uint256 total = totalStaked[msg.sender];
        if (amount > total) amount = total;

        delete unbonding[msg.sender];
        totalStaked[msg.sender] = total - amount;

        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Escrow-only
    // ---------------------------------------------------------------------

    function lock(address provider, uint256 amount) external onlyEscrow {
        uint256 available = availableStake(provider);
        if (amount > available) revert InsufficientAvailableStake(amount, available);
        locked[provider] += amount;
        emit Locked(provider, amount, locked[provider]);
    }

    function unlock(address provider, uint256 amount) external onlyEscrow {
        uint256 current = locked[provider];
        if (amount > current) revert InsufficientLockedStake(amount, current);
        locked[provider] = current - amount;
        emit Unlocked(provider, amount, locked[provider]);
    }

    /// @notice Slash locked collateral to a recipient under a finalized verdict.
    /// @dev Drawn strictly from `locked`, never from free or unbonding stake,
    ///      so a verdict on one job can never reach collateral committed to
    ///      another. Returns the amount actually taken: the escrow needs the
    ///      real figure to unlock the remainder correctly.
    function slash(address provider, uint256 amount, address recipient)
        external
        onlyEscrow
        returns (uint256 slashed)
    {
        if (recipient == address(0)) revert ZeroAddress();

        uint256 lockedAmount = locked[provider];
        slashed = amount > lockedAmount ? lockedAmount : amount;
        if (slashed == 0) return 0;

        locked[provider] = lockedAmount - slashed;
        totalStaked[provider] -= slashed;

        token.safeTransfer(recipient, slashed);
        emit Slashed(provider, slashed, recipient);
    }

    function disputeOpened(address provider) external onlyEscrow {
        uint256 open = openDisputes[provider] + 1;
        openDisputes[provider] = open;
        emit DisputeOpened(provider, open);
    }

    function disputeClosed(address provider) external onlyEscrow {
        uint256 open = openDisputes[provider];
        // Defensive: the escrow pairs these calls, but an unchecked decrement
        // here would underflow into a permanent freeze on the provider.
        if (open != 0) {
            open -= 1;
            openDisputes[provider] = open;
        }
        emit DisputeClosed(provider, open);
    }
}
