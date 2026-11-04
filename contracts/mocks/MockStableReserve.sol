// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockStableReserve
/// @notice Minimal 6-decimal ERC-20 standing in for USDC in tests and on Amoy demos.
/// @dev Test/demo only. Freely mintable on purpose so the reserve can be funded without
///      acquiring real USDC. Never deploy this to mainnet as a reserve asset.
contract MockStableReserve is ERC20 {
    constructor() ERC20("Mock Stable Reserve", "mUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
