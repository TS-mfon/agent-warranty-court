// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "../interfaces/IERC20.sol";

/// @notice ERC-20 transfers that tolerate non-standard return data.
/// @dev USDC returns a bool, but its implementation is upgradeable and the
///      protocol may later be pointed at a token that returns nothing. Treating
///      "no return data plus a successful call" as success is the standard
///      handling; anything else reverts rather than silently continuing, which
///      is what turns a failed transfer into a phantom settlement.
library SafeTransfer {
    error TransferFailed();

    function safeTransfer(IERC20 token, address to, uint256 amount) internal {
        _call(address(token), abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    function safeTransferFrom(IERC20 token, address from, address to, uint256 amount) internal {
        _call(address(token), abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
    }

    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
