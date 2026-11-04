// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockConfigurableReserve
/// @notice Minimal ERC-20 with a name, symbol and decimals set at deploy time.
/// @dev Test only, used solely by test/deploy-stable.script.test.ts to exercise
///      scripts/deploy-stable.ts's reserve-token validation (symbol == "USDC" &&
///      decimals == 6, and on polygon the native-USDC name()/address check) on the
///      simulated Polygon mainnet path, both when it passes (a real Polygon deploy
///      needs a valid backend/parity to test independently of the reserve check) and
///      when it should abort (wrong decimals, or a name()/address that looks like
///      bridged USDC.e). Never deploy this to any real network.
contract MockConfigurableReserve is ERC20 {
    uint8 private immutable _decimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
