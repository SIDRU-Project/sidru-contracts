// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title ChapaTuCripto (CTC)
/// @notice ERC-20 incentive token for the SIDRU urban recycling system, deployed
///         on Polygon Amoy. CTC is a testnet reward token with no fiat value.
/// @dev Custodial trust model: only the backend (BACKEND_ROLE) mints, transfers
///      and burns tokens on behalf of citizens' custodial addresses. Those
///      addresses never sign transactions nor pay gas. 1 point = 1 CTC = 10^18 wei.
contract ChapaTuCripto is ERC20, AccessControl {
    /// @notice Role granted to the backend wallet; gates all privileged operations.
    bytes32 public constant BACKEND_ROLE = keccak256("BACKEND_ROLE");

    /// @notice True once a sessionId has been rewarded (anti double-spend).
    mapping(uint256 => bool) public sessionRecorded;

    /// @notice True once a rewardTxId has been redeemed (anti double-redeem). Makes
    ///         redeemFrom idempotent so a backend retry/reconciliation is always safe.
    mapping(uint256 => bool) public rewardRedeemed;

    /// @notice Emitted when a valid recycling session is recorded and rewarded.
    /// @param sessionId Off-chain session id (unique).
    /// @param user      Citizen custodial address that received the reward.
    /// @param qrHash    keccak256 of the session QR token (traceability).
    /// @param amount    CTC amount in wei minted for the session.
    /// @param timestamp Block timestamp at which the session was recorded.
    event SessionRecorded(
        uint256 indexed sessionId,
        address indexed user,
        bytes32 qrHash,
        uint256 amount,
        uint256 timestamp
    );

    /// @notice Emitted when CTC are minted to a citizen (backend listens for FCM).
    /// @param user      Citizen custodial address that received the tokens.
    /// @param amount    CTC amount in wei that was minted.
    /// @param sessionId Off-chain session id linked to the mint.
    event TokensMinted(address indexed user, uint256 amount, uint256 indexed sessionId);

    /// @notice Emitted when custodial CTC are withdrawn to a citizen's own wallet.
    /// @param from   Citizen custodial address the tokens were moved from.
    /// @param to     Citizen external wallet the tokens were moved to.
    /// @param amount CTC amount in wei that was transferred.
    event TokensWithdrawn(address indexed from, address indexed to, uint256 amount);

    /// @notice Emitted when CTC are burned as part of a reward redemption.
    /// @param from       Citizen custodial address the tokens were burned from.
    /// @param amount     CTC amount in wei that was burned.
    /// @param rewardTxId Off-chain reward transaction id (traceability).
    event TokensRedeemed(address indexed from, uint256 amount, uint256 indexed rewardTxId);

    /// @notice Deploys the CTC token and wires up the access-control roles.
    /// @dev The deployer receives DEFAULT_ADMIN_ROLE (role management); the
    ///      `backend` address receives BACKEND_ROLE (privileged operations).
    ///      In the MVP the deployer and `backend` are the same backend wallet.
    /// @param backend Address granted BACKEND_ROLE (the backend wallet).
    constructor(address backend) ERC20("Chapa Tu Cripto", "CTC") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(BACKEND_ROLE, backend);
    }

    /// @notice Records a confirmed recycling session and mints its CTC reward.
    /// @dev Reverts if the sessionId was already recorded (anti double-spend).
    /// @param user      Citizen custodial address (resolved by the backend).
    /// @param sessionId Off-chain session id (unique).
    /// @param qrHash    keccak256 of the session QR token (traceability).
    /// @param amount    CTC amount in wei (pointsEarned * 10^18).
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
    /// @dev Privileged custodial transfer: the backend (msg.sender) pays gas; the
    ///      custodial address never signs. Reverts if balance < amount.
    /// @param from   Citizen custodial address.
    /// @param to     Citizen external wallet (validated EIP-55 off-chain).
    /// @param amount CTC amount in wei (typically the full balance).
    function withdrawTo(address from, address to, uint256 amount)
        external
        onlyRole(BACKEND_ROLE)
    {
        require(to != address(0), "invalid destination");
        _transfer(from, to, amount);
        emit TokensWithdrawn(from, to, amount);
    }

    /// @notice Burns CTC from a citizen's custody when a reward is redeemed.
    /// @dev Keeps on-chain CTC in sync with the off-chain points deduction. Reverts if
    ///      the rewardTxId was already redeemed (anti double-redeem) so a backend
    ///      retry/reconciliation is idempotent and safe.
    /// @param from       Citizen custodial address.
    /// @param amount     CTC amount in wei (pointsCost * 10^18).
    /// @param rewardTxId Off-chain reward transaction id (unique; idempotency key).
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
