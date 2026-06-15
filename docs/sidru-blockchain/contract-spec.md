# SIDRU Blockchain — Contract Spec (ChapaTuCripto / CTC)

## 1. Identidad del Token

| Parámetro | Valor |
|-----------|-------|
| Nombre | `Chapa Tu Cripto` |
| Símbolo | `CTC` |
| Decimales | `18` (default ERC20) |
| Estándar | ERC-20 + AccessControl (OpenZeppelin) |
| Solidity | `0.8.24` |
| Red MVP | Polygon Amoy (chainId `80002`, gas token POL) |
| Supply inicial | `0` (se mintea bajo demanda por sesión) |

---

## 2. Roles (AccessControl)

| Rol | Quién | Capacidades |
|-----|-------|-------------|
| `DEFAULT_ADMIN_ROLE` | Deployer (wallet backend en el deploy) | gestiona roles |
| `BACKEND_ROLE` = `keccak256("BACKEND_ROLE")` | Wallet del backend | `recordAndReward`, `withdrawTo`, `redeemFrom` |

```solidity
constructor(address backend) ERC20("Chapa Tu Cripto", "CTC") {
    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    _grantRole(BACKEND_ROLE, backend);
}
```

> En el MVP, el deployer y el `backend` son **la misma wallet** del backend (la que paga el gas y
> firma las operaciones). El parámetro de constructor permite separarlos en el futuro.

---

## 3. Estado

```solidity
/// @notice True once a sessionId has been rewarded (anti double-spend).
mapping(uint256 => bool) public sessionRecorded;
```

---

## 4. Eventos

```solidity
/// @notice Emitted when a valid recycling session is recorded and rewarded.
event SessionRecorded(
    uint256 indexed sessionId,
    address indexed user,
    bytes32 qrHash,
    uint256 amount,
    uint256 timestamp
);

/// @notice Emitted when CTC are minted to a citizen (backend listens for FCM).
event TokensMinted(address indexed user, uint256 amount, uint256 indexed sessionId);

/// @notice Emitted when custodial CTC are withdrawn to a citizen's own wallet.
event TokensWithdrawn(address indexed from, address indexed to, uint256 amount);

/// @notice Emitted when CTC are burned as part of a reward redemption.
event TokensRedeemed(address indexed from, uint256 amount, uint256 indexed rewardTxId);
```

---

## 5. Funciones

### 5.1. `recordAndReward` — mint por sesión (RF-17, anti-doble-canje)

```solidity
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
```

### 5.2. `withdrawTo` — retiro custodial (US-BC-06)

```solidity
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
```

### 5.3. `redeemFrom` — quema por canje de recompensa (RN-BC-08)

```solidity
/// @notice Burns CTC from a citizen's custody when a reward is redeemed.
/// @dev Keeps on-chain CTC in sync with the off-chain points deduction.
/// @param from       Citizen custodial address.
/// @param amount     CTC amount in wei (pointsCost * 10^18).
/// @param rewardTxId Off-chain reward transaction id (traceability).
function redeemFrom(address from, uint256 amount, uint256 rewardTxId)
    external
    onlyRole(BACKEND_ROLE)
{
    _burn(from, amount);
    emit TokensRedeemed(from, amount, rewardTxId);
}
```

> `balanceOf(address)` (heredado de ERC20) es la fuente de verdad del saldo del ciudadano (US-25 AC3).

---

## 6. Conversión Puntos → CTC (coherencia con el backend)

### Cadena completa de conversión (peso → puntos → CTC → soles ref.)

```
1) peso (g)        ──►  weightKg            = weightGrams / 1000
2) puntos          ──►  estimatedValueSoles = weightKg * price-per-kg-soles   // 4.00
                        pointsEarned        = round(estimatedValueSoles * points-per-sol)  // 100
                                            = round(weightGrams * 0.4)
3) CTC (1:1)       ──►  amount_wei          = pointsEarned * 10^18            // 18 decimales
4) soles ref.      ──►  soles_ref           = balanceCTC / points-per-sol     // 1 CTC ≈ S/ 0.01 (informativo)
```

> **Coherencia exacta (obligatoria):** el monto minteado on-chain debe **coincidir exactamente** con
> `pointsEarned` del backend, escalado a 18 decimales: `amount = pointsEarned * 10^18`. No se redondea
> ni se reescala en el contrato. La prueba off-chain/on-chain de coherencia (test #10) es **obligatoria**
> y debe pasar en CI antes de cerrar la Fase 3.

El backend calcula los puntos por **peso** (`RecyclingSessionCommandServiceImpl`):

```
weightKg            = weightGrams / 1000
estimatedValueSoles = weightKg * price-per-kg-soles      // 4.00
pointsEarned        = round(estimatedValueSoles * points-per-sol)   // 100
                    = round(weightGrams * 0.4)
```

**Regla de conversión (RN-BC-01): 1 punto = 1 CTC.**

```
amount_wei = pointsEarned × 10^18
```

En el backend (Web3j):

```java
BigInteger amount = BigInteger.valueOf(session.getPointsEarned())
                              .multiply(BigInteger.TEN.pow(18));
```

### Equivalencia referencial en soles (solo informativa, sin valor fiat)

```
1 sol  = points-per-sol = 100 puntos = 100 CTC
1 CTC  ≈ S/ 0.01   →   soles_ref = balanceCTC / 100
```

La app muestra esta equivalencia **etiquetada como estimada**. No implica conversión real.

### `qrHash`

```java
byte[] qrHash = org.web3j.crypto.Hash.sha3(session.getQrToken().getBytes(StandardCharsets.UTF_8));
// bytes32 → keccak256(qrToken)
```

### `sessionId`

```java
BigInteger sessionId = BigInteger.valueOf(session.getId()); // Long → uint256
```

---

## 7. Requisitos / Invariantes (asserts del contrato)

| Invariante | Mecanismo |
|-----------|-----------|
| Una `sessionId` se recompensa una sola vez | `require(!sessionRecorded[sessionId])` |
| Solo el backend mintea/retira/quema | `onlyRole(BACKEND_ROLE)` |
| No overflow en montos | Solidity 0.8.24 (checks nativos) |
| Destino de retiro no nulo | `require(to != address(0))` |
| Saldo suficiente en retiro/quema | `_transfer`/`_burn` revierten si falta saldo |

---

## 8. Configuración de Compilación / Deploy

| Parámetro | Valor |
|-----------|-------|
| Compiler | `solc 0.8.24` |
| Optimizer | `enabled: true, runs: 200` |
| Red | `amoy` — chainId `80002`, RPC `${AMOY_RPC_URL}` |
| Cuenta deploy | `${DEPLOYER_PRIVATE_KEY}` (wallet backend) |
| Constructor arg | `backend` = dirección de la wallet del backend |
| Verificación | Etherscan **V2** con `${ETHERSCAN_API_KEY}` (key multichain) |
| Explorer | `https://amoy.polygonscan.com` |

`hardhat.config.ts` (esquema):

```ts
networks: {
  amoy: { url: process.env.AMOY_RPC_URL, chainId: 80002, accounts: [process.env.DEPLOYER_PRIVATE_KEY] }
},
etherscan: { apiKey: process.env.ETHERSCAN_API_KEY }, // V2 multichain
solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 } } }
```

> **Secretos:** `AMOY_RPC_URL`, `DEPLOYER_PRIVATE_KEY`, `ETHERSCAN_API_KEY` viven solo en
> `sidru-contracts/.env` (gitignored). `.env.example` documenta los nombres con valores ficticios.

### Artefactos a exportar (`sidru-contracts/deployments/`)

- `amoy/ChapaTuCripto.json` — ABI.
- `amoy/address.json` — `{ "address": "0x...", "deployedAt": "...", "txHash": "0x..." }`.
- La dirección alimenta `BLOCKCHAIN_CONTRACT_ADDRESS` del backend (Fase 5).

---

## 9. Casos de Test del Contrato (resumen; detalle en tasks.md Fase 3)

| # | Test | Espera |
|---|------|--------|
| 1 | `recordAndReward` desde `BACKEND_ROLE` | mintea `amount`, `balanceOf(user)` correcto |
| 2 | `recordAndReward` desde cuenta sin rol | revert AccessControl |
| 3 | `recordAndReward` con `sessionId` duplicada | revert "session already recorded" |
| 4 | Emisión de `TokensMinted` y `SessionRecorded` | eventos con args correctos |
| 5 | `withdrawTo` mueve saldo a destino | `balanceOf(from)→0`, `balanceOf(to)` ↑, evento `TokensWithdrawn` |
| 6 | `withdrawTo` con destino `address(0)` | revert "invalid destination" |
| 7 | `withdrawTo` sin saldo suficiente | revert (ERC20InsufficientBalance) |
| 8 | `redeemFrom` quema saldo | `totalSupply` ↓, `balanceOf(from)` ↓, evento `TokensRedeemed` |
| 9 | `withdrawTo`/`redeemFrom` sin rol | revert AccessControl |
| 10 | **(OBLIGATORIO)** Coherencia: `pointsEarned` puntos → `pointsEarned·10^18` wei (caso 280) | `balanceOf == 280 ether`; el monto on-chain coincide exactamente con el off-chain |
