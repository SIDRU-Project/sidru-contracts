// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title ChapaTuCriptoRestricted (CTC) — transferable between people, never tradable
/// @notice ERC-20 incentive token for SIDRU. Citizens can move their CTC to their own
///         wallet and send it to other registered citizens, but no secondary market can
///         form — which is what keeps 100 CTC = S/ 1.00 true without holding any reserve.
/// @dev Permissioned-transfer pattern (the idea behind ERC-1404 / ERC-3643): a transfer
///      initiated by a holder only succeeds if BOTH ends are on the allowlist. Since an
///      AMM pool, an exchange deposit address or an arbitrary counterparty will never be
///      allowlisted, CTC cannot be traded, so there is no floating price to defend.
///
///      Mints, burns and backend-initiated custodial moves bypass the check:
///        - `recordAndReward` : mint, `from == address(0)`
///        - `redeemFrom`      : burn, `to == address(0)`
///        - `withdrawTo`      : backend is `msg.sender`, so a citizen's own MetaMask can
///                              receive the withdrawal without being allowlisted first.
///
///      The allowlist therefore only governs citizen-to-citizen transfers between external
///      wallets. 1 point = 1 CTC = 10^18 wei = S/ 0.01.
contract ChapaTuCriptoRestricted is ERC20, AccessControl {
    /// @notice Role granted to the backend wallet; gates privileged and allowlist operations.
    bytes32 public constant BACKEND_ROLE = keccak256("BACKEND_ROLE");

    /// @notice Addresses cleared to send and receive CTC on their own initiative.
    mapping(address => bool) public transferAllowed;

    /// @notice True once a sessionId has been rewarded (anti double-spend).
    mapping(uint256 => bool) public sessionRecorded;

    /// @notice True once a rewardTxId has been redeemed (anti double-redeem).
    mapping(uint256 => bool) public rewardRedeemed;

    event SessionRecorded(
        uint256 indexed sessionId,
        address indexed user,
        bytes32 qrHash,
        uint256 amount,
        uint256 timestamp
    );
    event TokensMinted(address indexed user, uint256 amount, uint256 indexed sessionId);
    event TokensWithdrawn(address indexed from, address indexed to, uint256 amount);
    event TokensRedeemed(address indexed from, uint256 amount, uint256 indexed rewardTxId);

    /// @notice Emitted when an address is cleared for (or barred from) holder transfers.
    event TransferAllowanceSet(address indexed account, bool allowed);

    /// @notice Thrown when a holder transfer touches an address that is not allowlisted.
    error TransferNotAllowed(address account);

    /// @param backend Address granted BACKEND_ROLE (the backend wallet).
    constructor(address backend) ERC20("Chapa Tu Cripto", "CTC") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(BACKEND_ROLE, backend);
    }

    // ---------------------------------------------------------------------
    // Allowlist
    // ---------------------------------------------------------------------

    /// @notice Clears (or bars) an address for holder-initiated transfers.
    /// @dev Called by the backend when a citizen registers an external wallet, after the
    ///      EIP-55 checksum validation the app already performs.
    function setTransferAllowed(address account, bool allowed) external onlyRole(BACKEND_ROLE) {
        require(account != address(0), "invalid account");
        transferAllowed[account] = allowed;
        emit TransferAllowanceSet(account, allowed);
    }

    /// @notice Batch variant, to seed or revoke many addresses in a single transaction.
    function setTransferAllowedBatch(address[] calldata accounts, bool allowed)
        external
        onlyRole(BACKEND_ROLE)
    {
        for (uint256 i = 0; i < accounts.length; i++) {
            address account = accounts[i];
            require(account != address(0), "invalid account");
            transferAllowed[account] = allowed;
            emit TransferAllowanceSet(account, allowed);
        }
    }

    /// @dev Permissioned-transfer guard. Mints, burns and backend-initiated custodial moves
    ///      pass through; a transfer a holder starts requires both ends on the allowlist.
    ///      This is what makes a secondary market impossible, and the parity structural.
    function _update(address from, address to, uint256 value) internal override {
        bool isMintOrBurn = from == address(0) || to == address(0);
        if (!isMintOrBurn && !hasRole(BACKEND_ROLE, _msgSender())) {
            if (!transferAllowed[from]) revert TransferNotAllowed(from);
            if (!transferAllowed[to]) revert TransferNotAllowed(to);
        }
        super._update(from, to, value);
    }

    // ---------------------------------------------------------------------
    // SIDRU operations
    // ---------------------------------------------------------------------

    /// @notice Records a confirmed recycling session and mints its CTC reward.
    function recordAndReward(address user, uint256 sessionId, bytes32 qrHash, uint256 amount)
        external
        onlyRole(BACKEND_ROLE)
    {
        require(!sessionRecorded[sessionId], "session already recorded");
        sessionRecorded[sessionId] = true;
        _mint(user, amount);
        emit SessionRecorded(sessionId, user, qrHash, amount, block.timestamp);
        emit TokensMinted(user, amount, sessionId);
    }

    /// @notice Moves a citizen's custodial CTC to their own external wallet.
    /// @dev The backend is `msg.sender`, so the destination does not need to be allowlisted
    ///      beforehand — the withdrawal works on the first try. Allowlist the destination
    ///      too if the citizen should be able to send it onward from that wallet.
    function withdrawTo(address from, address to, uint256 amount)
        external
        onlyRole(BACKEND_ROLE)
    {
        require(to != address(0), "invalid destination");
        _transfer(from, to, amount);
        emit TokensWithdrawn(from, to, amount);
    }

    /// @notice Burns CTC from a citizen's custody when a catalog reward is redeemed.
    function redeemFrom(address from, uint256 amount, uint256 rewardTxId)
        external
        onlyRole(BACKEND_ROLE)
    {
        require(!rewardRedeemed[rewardTxId], "reward already redeemed");
        rewardRedeemed[rewardTxId] = true;
        _burn(from, amount);
        emit TokensRedeemed(from, amount, rewardTxId);
    }
}
