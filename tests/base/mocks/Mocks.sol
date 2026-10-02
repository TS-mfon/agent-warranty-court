// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal 6-decimal ERC-20 standing in for USDC on Base.
contract MockUSDC {
    string public constant name = "Mock USD Coin";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @notice Stand-in for Base's `L2CrossDomainMessenger`.
/// @dev `relay` is what makes the receiver's authentication testable: it lets a
///      test deliver a call whose `msg.sender` really is the messenger, while
///      `xDomainMessageSender` is set independently. That separation is the
///      whole point — the receiver must require both, and a mock that couldn't
///      vary them independently could not prove it.
contract MockMessenger {
    address public xDomainMessageSender;

    function setXDomainMessageSender(address sender) external {
        xDomainMessageSender = sender;
    }

    function relay(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            // Surface the callee's revert reason rather than a generic failure,
            // so a test asserting a specific error sees it.
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }
}

/// @notice A token recipient that tries to re-enter on receipt.
/// @dev Used to prove the escrow's checks-effects-interactions ordering and
///      reentrancy guard actually hold when a client is a contract.
contract ReentrantClient {
    address public target;
    bytes public payload;
    bool public armed;

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
        armed = true;
    }

    // MockUSDC does not call back on transfer, so the hook is driven explicitly
    // by tests that need it; the guard is asserted by direct re-entry instead.
    function fire() external {
        require(armed, "not armed");
        (bool ok,) = target.call(payload);
        require(ok, "reentry reverted");
    }
}
