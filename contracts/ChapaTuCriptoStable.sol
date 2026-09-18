// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title ChapaTuCriptoStable (CTC) — fully reserved, freely transferable
/// @notice ERC-20 incentive token for SIDRU with a hard 100 CTC = S/ 1.00 parity.
/// @dev The parity is NOT declared, it is enforced by a two-sided redemption window
///      against a reserve held by this contract (a currency-board design):
///
///        - `purchase`  : anyone deposits reserve and receives CTC at par  -> price CEILING
///        - `redeem`    : anyone burns CTC and receives reserve at par     -> price FLOOR
///
///      Because both windows are permissionless and always open, arbitrage pins the
///      market price to par: below par it is profitable to buy and redeem, above par
///      it is profitable to purchase and sell. The token stays freely transferable.
///
///      Full reserve is a structural invariant: `recordAndReward` reverts if the mint
///      would push totalSupply beyond what the reserve can back, and the admin can only
///      withdraw the surplus above `requiredReserve()`. It is therefore impossible for
///      this contract to issue an unbacked CTC.
///
///      1 CTC = 1 sol cent. `centsPerReserveUnit` states how many sol cents one whole
///      unit of the reserve token is worth (e.g. 337 => 1 USDC = S/ 3.37).
contract ChapaTuCriptoStable is ERC20, AccessControl {
    using SafeERC20 for IERC20;

    /// @notice Role granted to the backend wallet; gates the custodial operations.
    bytes32 public constant BACKEND_ROLE = keccak256("BACKEND_ROLE");

    /// @notice Reserve asset backing every CTC in circulation (e.g. USDC on Polygon).
    IERC20 public immutable reserveToken;

    /// @notice Cents of sol backed by one whole reserve unit (e.g. 360 => 1 USDC = S/ 3.60).
    ///         Mutable: the admin tracks the PEN/USD rate without redeploying. Every change is
    ///         guarded so circulating CTC never becomes under-collateralized.
    uint256 public centsPerReserveUnit;

    /// @dev 10 ** reserveToken.decimals(), cached to avoid a call per conversion.
    uint256 private immutable reserveScale;

    /// @dev 10 ** 18: one CTC, i.e. one sol cent.
    uint256 private constant CTC_UNIT = 1e18;

    /// @notice True once a sessionId has been rewarded (anti double-spend).
    mapping(uint256 => bool) public sessionRecorded;

    /// @notice True once a rewardTxId has been redeemed (anti double-redeem).
    mapping(uint256 => bool) public rewardRedeemed;

    /// @notice Withdrawal ids already settled, either by mint or by reserve payout.
    ///         One id, one outcome: the backend's idempotency key.
    mapping(uint256 => bool) public withdrawalProcessed;

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

    /// @notice Emitted when someone buys CTC at par by depositing reserve (price ceiling).
    event Purchased(address indexed buyer, uint256 reserveIn, uint256 ctcOut);
    /// @notice Emitted when someone burns CTC and takes reserve at par (price floor).
    event RedeemedForReserve(address indexed holder, uint256 ctcIn, uint256 reserveOut);
    /// @notice Emitted when SIDRU tops up the reserve to back recycling rewards.
    event ReserveFunded(address indexed funder, uint256 reserveIn);
    /// @notice Emitted when the admin takes out reserve above the full-reserve requirement.
    event ExcessReserveWithdrawn(address indexed to, uint256 reserveOut);

    event WithdrawalMinted(address indexed to, uint256 indexed withdrawalId, uint256 amount);
    event ReservePaidOut(address indexed to, uint256 indexed withdrawalId, uint256 ctcAmount, uint256 reserveOut);
    event ParityUpdated(uint256 oldCents, uint256 newCents);

    error InsufficientReserve(uint256 required, uint256 available);
    error AmountTooSmall();
    error WouldBreakFullReserve();
    error WithdrawalAlreadyProcessed(uint256 withdrawalId);
    error ParityWouldUnderCollateralize(uint256 capacity, uint256 supply);

    /// @param backend              Address granted BACKEND_ROLE (the backend wallet).
    /// @param reserveToken_        Reserve asset (e.g. USDC).
    /// @param reserveDecimals_     Decimals of the reserve asset (6 for USDC).
    /// @param centsPerReserveUnit_ Sol cents per whole reserve unit (337 => S/ 3.37 per USDC).
    constructor(
        address backend,
        IERC20 reserveToken_,
        uint8 reserveDecimals_,
        uint256 centsPerReserveUnit_
    ) ERC20("Chapa Tu Cripto", "CTC") {
        require(address(reserveToken_) != address(0), "invalid reserve token");
        require(centsPerReserveUnit_ > 0, "invalid parity");
        reserveToken = reserveToken_;
        centsPerReserveUnit = centsPerReserveUnit_;
        reserveScale = 10 ** reserveDecimals_;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(BACKEND_ROLE, backend);
    }

    // ---------------------------------------------------------------------
    // Parity conversions (1 CTC = 1 sol cent)
    // ---------------------------------------------------------------------

    /// @notice CTC (wei) that a given raw amount of reserve backs, at par.
    function ctcForReserve(uint256 reserveRaw) public view returns (uint256) {
        return (reserveRaw * centsPerReserveUnit * CTC_UNIT) / reserveScale;
    }

    /// @notice Raw reserve owed for a given amount of CTC (wei), at par. Rounds down.
    function reserveForCtc(uint256 ctcWei) public view returns (uint256) {
        return (ctcWei * reserveScale) / (centsPerReserveUnit * CTC_UNIT);
    }

    /// @notice Reserve currently held by this contract.
    function reserveBalance() public view returns (uint256) {
        return reserveToken.balanceOf(address(this));
    }

    /// @notice Maximum CTC the current reserve can fully back.
    function reserveCapacity() public view returns (uint256) {
        return ctcForReserve(reserveBalance());
    }

    /// @notice Reserve needed to back the whole circulating supply. Rounds UP so the
    ///         contract never considers itself solvent by a rounding artifact.
    function requiredReserve() public view returns (uint256) {
        uint256 denominator = centsPerReserveUnit * CTC_UNIT;
        return (totalSupply() * reserveScale + denominator - 1) / denominator;
    }

    /// @notice Collateralization in basis points (10000 = exactly 100%). For proof of reserves.
    function collateralizationBps() external view returns (uint256) {
        uint256 required = requiredReserve();
        if (required == 0) return type(uint256).max;
        return (reserveBalance() * 10000) / required;
    }

    // ---------------------------------------------------------------------
    // The two-sided window that defends the peg
    // ---------------------------------------------------------------------

    /// @notice Deposit reserve, receive CTC at par. Permissionless — this is the price ceiling:
    ///         nobody pays more than par on a market when they can always mint at par here.
    function purchase(uint256 reserveRaw) external returns (uint256 ctcOut) {
        ctcOut = ctcForReserve(reserveRaw);
        if (ctcOut == 0) revert AmountTooSmall();
        // Reserve lands before the mint, so the full-reserve invariant is never broken.
        reserveToken.safeTransferFrom(msg.sender, address(this), reserveRaw);
        _mint(msg.sender, ctcOut);
        emit Purchased(msg.sender, reserveRaw, ctcOut);
    }

    /// @notice Burn CTC, receive reserve at par. Permissionless — this is the price floor:
    ///         nobody sells below par on a market when they can always redeem at par here.
    function redeem(uint256 ctcWei) external returns (uint256 reserveOut) {
        reserveOut = reserveForCtc(ctcWei);
        if (reserveOut == 0) revert AmountTooSmall();
        _burn(msg.sender, ctcWei);
        reserveToken.safeTransfer(msg.sender, reserveOut);
        emit RedeemedForReserve(msg.sender, ctcWei, reserveOut);
    }

    // ---------------------------------------------------------------------
    // Reserve management
    // ---------------------------------------------------------------------

    /// @notice Top up the reserve without minting. This is how SIDRU pre-funds the CTC it is
    ///         about to hand out for recycling: every reward must be backed before it exists.
    function fundReserve(uint256 reserveRaw) external {
        reserveToken.safeTransferFrom(msg.sender, address(this), reserveRaw);
        emit ReserveFunded(msg.sender, reserveRaw);
    }

    /// @notice Withdraw only the reserve that exceeds the full-reserve requirement. Surplus
    ///         appears when CTC is burned by a catalog redemption (`redeemFrom`), which
    ///         destroys the token and releases the reserve that was backing it.
    function withdrawExcessReserve(address to, uint256 reserveRaw)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (reserveBalance() < requiredReserve() + reserveRaw) revert WouldBreakFullReserve();
        reserveToken.safeTransfer(to, reserveRaw);
        emit ExcessReserveWithdrawn(to, reserveRaw);
    }

    // ---------------------------------------------------------------------
    // SIDRU operations (unchanged semantics from ChapaTuCripto)
    // ---------------------------------------------------------------------

    /// @notice Records a confirmed recycling session and mints its CTC reward.
    /// @dev Reverts if the reserve cannot back the new supply — the peg can never be
    ///      diluted by recycling rewards. Fund the reserve first via `fundReserve`.
    function recordAndReward(address user, uint256 sessionId, bytes32 qrHash, uint256 amount)
        external
        onlyRole(BACKEND_ROLE)
    {
        require(!sessionRecorded[sessionId], "session already recorded");
        uint256 capacity = reserveCapacity();
        uint256 newSupply = totalSupply() + amount;
        if (newSupply > capacity) revert InsufficientReserve(newSupply, capacity);
        sessionRecorded[sessionId] = true;
        _mint(user, amount);
        emit SessionRecorded(sessionId, user, qrHash, amount, block.timestamp);
        emit TokensMinted(user, amount, sessionId);
    }

    /// @notice Moves a citizen's custodial CTC to their own external wallet.
    function withdrawTo(address from, address to, uint256 amount)
        external
        onlyRole(BACKEND_ROLE)
    {
        require(to != address(0), "invalid destination");
        _transfer(from, to, amount);
        emit TokensWithdrawn(from, to, amount);
    }

    /// @notice Burns CTC from a citizen's custody when a catalog reward is redeemed.
    /// @dev Burning frees the reserve that was backing those tokens; SIDRU recovers it
    ///      through `withdrawExcessReserve` to pay for the physical reward.
    function redeemFrom(address from, uint256 amount, uint256 rewardTxId)
        external
        onlyRole(BACKEND_ROLE)
    {
        require(!rewardRedeemed[rewardTxId], "reward already redeemed");
        rewardRedeemed[rewardTxId] = true;
        _burn(from, amount);
        emit TokensRedeemed(from, amount, rewardTxId);
    }

    // ---------------------------------------------------------------------
    // Withdrawal: CTC only comes into existence when a citizen withdraws points
    // ---------------------------------------------------------------------

    /// @notice Mints CTC straight to a citizen's own wallet when they withdraw app points.
    /// @dev Idempotent per withdrawalId. Reverts if the reserve cannot back the new supply.
    ///      Off-chain the backend has already debited the points; this is the on-chain leg.
    /// @param to           Citizen's external wallet (EIP-55 validated off-chain; non-zero here)
    /// @param withdrawalId Backend-generated random id, unique per withdrawal (never a DB sequence)
    /// @param amount       CTC in wei (points × 1e18)
    function mintWithdrawal(address to, uint256 withdrawalId, uint256 amount)
        external
        onlyRole(BACKEND_ROLE)
    {
        require(to != address(0), "invalid recipient");
        require(amount > 0, "zero amount");
        if (withdrawalProcessed[withdrawalId]) revert WithdrawalAlreadyProcessed(withdrawalId);
        uint256 capacity = reserveCapacity();
        uint256 newSupply = totalSupply() + amount;
        if (newSupply > capacity) revert InsufficientReserve(newSupply, capacity);
        withdrawalProcessed[withdrawalId] = true;
        _mint(to, amount);
        emit WithdrawalMinted(to, withdrawalId, amount);
    }

    /// @notice Pays a citizen in reserve asset (USDC) at par instead of minting CTC —
    ///         the path to custodial exchanges that do not list CTC.
    /// @dev Idempotent per withdrawalId. Never dips into the reserve that backs circulating
    ///      CTC: only the surplus above requiredReserve() can be paid out. totalSupply is
    ///      unchanged, so collateralization of existing holders is unaffected.
    /// @param withdrawalId Backend-generated random id, unique per withdrawal (never a DB sequence)
    /// @param ctcAmount CTC-equivalent in wei (points × 1e18); converted at current parity
    /// @return reserveOut Reserve units transferred (6 decimals for USDC), floor-rounded
    function payoutReserve(address to, uint256 withdrawalId, uint256 ctcAmount)
        external
        onlyRole(BACKEND_ROLE)
        returns (uint256 reserveOut)
    {
        require(to != address(0), "invalid recipient");
        require(ctcAmount > 0, "zero amount");
        if (withdrawalProcessed[withdrawalId]) revert WithdrawalAlreadyProcessed(withdrawalId);
        reserveOut = reserveForCtc(ctcAmount);
        require(reserveOut > 0, "amount below reserve precision");
        uint256 surplus = reserveBalance() - requiredReserve();
        if (reserveOut > surplus) revert InsufficientReserve(reserveOut, surplus);
        withdrawalProcessed[withdrawalId] = true;
        reserveToken.safeTransfer(to, reserveOut);
        emit ReservePaidOut(to, withdrawalId, ctcAmount, reserveOut);
    }

    /// @notice Admin-only parity update to follow the PEN/USD rate.
    /// @dev Reverts if the new parity would leave circulating CTC under-collateralized.
    ///      Lowering cents-per-unit raises the reserve each CTC needs; the guard is what keeps
    ///      this from ever creating unbacked supply.
    function setCentsPerReserveUnit(uint256 newCents) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(newCents > 0, "invalid parity");
        uint256 old = centsPerReserveUnit;
        centsPerReserveUnit = newCents;
        uint256 capacity = reserveCapacity();
        if (capacity < totalSupply()) revert ParityWouldUnderCollateralize(capacity, totalSupply());
        emit ParityUpdated(old, newCents);
    }
}
