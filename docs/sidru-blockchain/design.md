# SIDRU Blockchain — Design Spec

## 1. Visión General

El módulo blockchain atraviesa los tres subproyectos del monorepo:

```
sidru-contracts/  → ChapaTuCripto.sol (ERC20 + AccessControl) en Polygon Amoy
       ▲ ABI + address (deployments/)
       │
sidru-api/        → contexto `blockchain`: Web3jBlockchainAdapter (impl. del puerto),
       │            derivación de direcciones custodiales, persistencia, listener, retiro
       ▲ REST (/api/v1, JWT)
       │
sidru_mobile/     → WalletScreen → WalletProvider → WalletRepository → ApiClient
```

**Principio rector:** el contexto `sessions` **no conoce blockchain**. Solo depende del puerto
`BlockchainPort.recordSession(RecyclingSession)`. Toda la lógica Web3j, las direcciones custodiales
y la red viven en el contexto `blockchain`. La app nunca habla con la blockchain directamente:
consume el backend vía el `ApiClient`/`JwtInterceptor` existentes.

> **Semántica de CTC.** CTC ("Chapa Tu Cripto") es un **token de incentivo en la testnet Polygon
> Amoy, sin valor fiat**. No es dinero. "Retirar" significa **mover los tokens dentro de Amoy** a la
> wallet propia del ciudadano (MetaMask), **no** convertirlos a soles. La equivalencia en soles que
> muestra la app es **referencial/educativa** (deriva de `points-per-sol`), no un tipo de cambio.

---

## 2. Modelo de Custodia (Híbrido)

### 2.1. Custodia por usuario (base)

- El contexto `blockchain` deriva una **dirección EVM determinística por ciudadano** desde un
  **seed maestro** (`WALLET_MASTER_SEED`) usando una ruta HD con índice = `userId`
  (p. ej. `m/44'/60'/0'/0/{userId}`).
- La dirección se **persiste** en la tabla aditiva `user_wallet_addresses` (`user_id` único,
  `address`, `derivation_index`, timestamps). Esta tabla vive en el contexto `blockchain` y **no
  modifica** `iam` ni `users`.
- Los CTC de cada sesión confirmada se **mintean a esa dirección custodial** y permanecen on-chain.
- `balanceOf(direcciónCustodial)` es el **saldo real del ciudadano** → cumple US-25 AC3.
- **Cero fricción:** el ciudadano gana CTC sin instalar wallet ni tener POL.

### 2.2. Retiro on-demand (self-custody)

- El ciudadano pulsa **"Retirar a mi wallet"** y pega su dirección MetaMask.
- La app valida **formato + checksum EIP-55** antes de enviar nada.
- El backend ejecuta `withdrawTo(custodial, destino, monto)` —función `onlyRole(BACKEND_ROLE)`—
  donde **`msg.sender` y pagador del gas es la wallet del backend**. La dirección custodial **no
  firma ni gasta POL**.
- Por defecto retira **el saldo completo**. Es **idempotente** (estados `EN_PROCESO`/`COMPLETADO`/
  `FALLIDO`); maneja **retiro sin saldo** y **sin wallet de destino**.

### 2.3. Modelo de gas y firmas

| Acción | Firma / paga gas | Mecanismo |
|--------|------------------|-----------|
| Mint por sesión | Wallet backend (`BACKEND_ROLE`) | `recordAndReward` |
| Retiro a MetaMask | Wallet backend | `withdrawTo` (`_transfer` privilegiado) |
| Canje de recompensa | Wallet backend | `redeemFrom` (`_burn` privilegiado) |
| Direcciones por usuario | **Nunca firman, nunca pagan gas** | Solo reciben/mantienen CTC |

> Las funciones `withdrawTo`/`redeemFrom` son privilegiadas porque las direcciones custodiales no
> pueden firmar (no tienen POL y, por diseño, el sistema no expone sus llaves para firmar tx). El
> backend, con `BACKEND_ROLE`, mueve/quema los tokens en nombre de la custodia. Es el trust model
> custodial explícito del MVP.

---

## 3. Diseño del Contrato (resumen; detalle en contract-spec.md)

`ChapaTuCripto is ERC20, AccessControl`

```solidity
bytes32 public constant BACKEND_ROLE = keccak256("BACKEND_ROLE");
mapping(uint256 => bool) public sessionRecorded;

event SessionRecorded(uint256 indexed sessionId, address indexed user, bytes32 qrHash, uint256 amount, uint256 timestamp);
event TokensMinted(address indexed user, uint256 amount, uint256 indexed sessionId);
event TokensWithdrawn(address indexed from, address indexed to, uint256 amount);
event TokensRedeemed(address indexed from, uint256 amount, uint256 indexed rewardTxId);

constructor(address backend); // DEFAULT_ADMIN_ROLE → deployer; BACKEND_ROLE → backend

function recordAndReward(address user, uint256 sessionId, bytes32 qrHash, uint256 amount) external onlyRole(BACKEND_ROLE);
function withdrawTo(address from, address to, uint256 amount) external onlyRole(BACKEND_ROLE);
function redeemFrom(address from, uint256 amount, uint256 rewardTxId) external onlyRole(BACKEND_ROLE);
```

- **Anti-doble-canje:** `require(!sessionRecorded[sessionId], "session already recorded")`.
- **Decimales:** 18 (heredados de ERC20). 1 punto = 1 CTC = `10^18` wei.
- NatSpec en inglés; optimizer runs=200.

---

## 4. Backend (contexto `blockchain`, DDD)

Respeta capas `domain / application / infrastructure / interfaces` bajo
`com.sidru.sidru_api.blockchain`.

### 4.1. Componentes

| Componente | Capa | Responsabilidad |
|-----------|------|----------------|
| `BlockchainTransaction` (aggregate, **ya existe**) | domain | sessionId, txHash, network, confirmed, rawPayload |
| `UserWalletAddress` (aggregate, **nuevo**) | domain | userId, address, derivationIndex |
| `WithdrawalRequest` (aggregate, **nuevo**) | domain | userId, toAddress, amount, status, txHash (idempotencia de retiro) |
| `BlockchainTransactionRepository` (**ya existe**) | infrastructure | `findBySessionId` |
| `UserWalletAddressRepository` (**nuevo**) | infrastructure | `findByUserId` |
| `WithdrawalRequestRepository` (**nuevo**) | infrastructure | `findByUserIdAndStatus` |
| `CustodialWalletService` (**nuevo**) | application | deriva/persiste la dirección custodial por `userId` (HD desde `WALLET_MASTER_SEED`) |
| `ChapaTuCripto` (wrapper Web3j, **nuevo**) | infrastructure | generado desde el ABI |
| `Web3jBlockchainAdapter` (**reemplazar STUB**) | infrastructure | implementa `BlockchainPort.recordSession`: resuelve dirección, llama `recordAndReward`, persiste tx, reintentos/idempotencia |
| `TokensMintedEventListener` (**nuevo**) | infrastructure | suscripción al evento; confirma tx + dispara FCM (US-39) |
| `WalletQueryService` (**nuevo**) | application | `balanceOf`, dirección, transacciones por usuario |
| `WithdrawalCommandService` (**nuevo**) | application | retiro idempotente vía `withdrawTo` |
| `WalletController` (**nuevo**) | interfaces/rest | endpoints REST de wallet/retiro |

### 4.2. Flujo de mint (confirmación de sesión)

```
sessions.ConfirmRecyclingSessionCommand
  → session.confirm(userId)
  → blockchainPort.recordSession(session)         [puerto, sin Web3j]
        Web3jBlockchainAdapter:
          if (!enabled) return Optional.empty()
          if (txRepo.findBySessionId(id).present) return existingHash   [idempotencia]
          addr   = custodialWalletService.addressFor(userId)
          amount = BigInteger.valueOf(pointsEarned).multiply(10^18)
          qrHash = keccak256(qrToken)
          receipt = contract.recordAndReward(addr, id, qrHash, amount).send()  [retry/backoff]
          txRepo.save(BlockchainTransaction(id, receipt.txHash, "polygon-amoy", false, payload))
          return Optional.of(receipt.txHash)
  → session.attachBlockchainTx(txHash)
```

`confirmed` se marca `true` cuando el `TokensMintedEventListener` recibe el evento (sección 4.4).

### 4.3. Flujo de retiro

```
POST /wallet/withdraw { toAddress }
  WithdrawalCommandService:
    validar EIP-55(toAddress)                         → 400 si inválida
    if (existe WithdrawalRequest EN_PROCESO) return enCurso   [idempotencia]
    addr    = custodialWalletService.addressFor(userId)
    balance = contract.balanceOf(addr)
    if (balance == 0) return error "Sin saldo para retirar"
    req = save(WithdrawalRequest(userId, toAddress, balance, EN_PROCESO))
    receipt = contract.withdrawTo(addr, toAddress, balance).send()   [gas: backend]
    req.complete(receipt.txHash)  → COMPLETADO
```

### 4.4. Listener de eventos (RF-18, US-39)

- `TokensMintedEventListener` se suscribe (filtro Web3j) al evento `TokensMinted`.
- Al recibirlo: localiza la `BlockchainTransaction` por `sessionId`, marca `confirmed=true` y
  dispara la notificación FCM (a través del contexto `notifications`, respetando ACL).
- Tolerante a `BLOCKCHAIN_ENABLED=false` (no se suscribe) y a desconexiones de RPC (re-suscripción).

### 4.5. Endpoints REST (contexto `blockchain`, interfaces/rest)

| Método | Ruta (`/api/v1`) | Descripción | US |
|--------|------------------|-------------|----|
| GET | `/wallet/me` | dirección custodial, red, balance CTC, equivalencia referencial, wallet de retiro vinculada | US-BC-04 |
| GET | `/wallet/me/transactions` | transacciones on-chain del usuario (hash, tipo, monto, estado, link) | US-BC-04/05 |
| POST | `/wallet/withdraw` | inicia retiro idempotente del saldo completo a `toAddress` | US-BC-06 |
| GET | `/wallet/withdraw/status` | estado del último retiro (EN_PROCESO/COMPLETADO/FALLIDO) | US-BC-06 |

Todos requieren JWT. El `userId` sale del token (no del body).

---

## 5. App Flutter — WalletScreen (MVVM)

Sigue el estilo de `docs/specs/sidru-mobile/` y la cadena
`Pantalla → Provider → Repository → Api → ApiClient → JwtInterceptor → SecureStorage`.

### 5.1. Estructura (feature `wallet`, ya esqueletada en mobile)

```
features/wallet/
├── data/
│   ├── wallet_api.dart                 # GET /wallet/me, /wallet/me/transactions, POST /wallet/withdraw
│   ├── wallet_repository.dart          # abstrae y mapea errores (ApiException)
│   └── models/
│       ├── wallet_balance.dart         # address, network, balanceCtc, balanceWei, solesRef, linkedWallet?
│       └── wallet_transaction.dart     # hash, type(MINT/WITHDRAW/REDEEM), amountCtc, status, timestamp, explorerUrl
└── presentation/
    ├── wallet_provider.dart            # AsyncNotifier<WalletBalance?> + acciones de retiro
    ├── wallet_screen.dart              # UI principal
    └── widgets/
        ├── wallet_balance_card.dart
        ├── wallet_address_row.dart
        ├── wallet_transaction_tile.dart
        └── withdraw_sheet.dart         # bottom sheet con input de dirección + validación EIP-55
```

### 5.2. UI (alineada al tema Material 3 de SIDRU)

- **Header:** "Mi Wallet CTC" + red "Polygon Amoy".
- **Card de balance (hero):** balance CTC en grande (gradiente `#00F5A0→#00D9FF`), equivalencia
  referencial en soles con etiqueta "estimado", dirección custodial truncada (`0x1234…abcd`) con
  botón copiar y enlace a `amoy.polygonscan.com/address/{addr}`.
- **Botón "Retirar a mi wallet":** abre `withdraw_sheet`; valida EIP-55 inline; estado loading;
  feedback de éxito/idempotencia/sin-saldo.
- **Lista de transacciones:** tipo (MINT/WITHDRAW/REDEEM), monto (+/-), hash truncado, chip de
  estado (pendiente/confirmada), enlace al explorador.
- **Estados:** `LoadingState`, `ErrorState` con retry, `EmptyState` ("Aún no tienes CTC").

### 5.3. Validación EIP-55 (cliente)

- Formato: `^0x[0-9a-fA-F]{40}$`.
- Checksum EIP-55: si la dirección trae mayúsculas/minúsculas mezcladas, validar el checksum
  keccak; si viene todo en minúsculas, aceptar como válida pero advertir. El backend revalida.

---

## 6. Coherencia puntos ↔ CTC

| Concepto | Off-chain (backend) | On-chain (CTC) |
|----------|---------------------|----------------|
| Ganar (sesión) | `+pointsEarned` (perfil) | `mint pointsEarned·10^18` a custodia |
| Canjear recompensa | `-pointsCost` (perfil) | `burn pointsCost·10^18` (`redeemFrom`) |
| Retirar | sin cambio de puntos | `transfer` custodia → MetaMask |

- **Invariante:** mientras los CTC están en custodia, `balanceOf(custodia) == totalPoints·10^18`.
- Tras un **retiro**, los CTC salen de la custodia: esos tokens ya no son canjeables in-app. La
  coherencia con el catálogo de recompensas (que hoy gatea por `totalPoints` off-chain) se documenta
  como acoplamiento a manejar en la fase de integración de `rewards` (ver tasks.md, nota de alcance);
  **no se rompe** el flujo de recompensas existente del Sprint 1.

---

## 7. Manejo de errores y reintentos (RF-18)

- **RPC transitorio:** reintentos con backoff exponencial (p. ej. 3 intentos). Si falla, la sesión
  se confirma igual (puntos off-chain intactos) y la tx queda para reconciliación; no se marca
  `confirmed`.
- **Revert `session already recorded`:** se trata como idempotente (otra instancia ya minteó);
  se reutiliza/upserta la `BlockchainTransaction`.
- **Gas/fondos insuficientes** en la wallet backend: log de error operativo; no rompe la confirmación.
- **Retiro:** estados persistidos para idempotencia; reintento seguro.

---

## 8. Seguridad (RNF-BC-01..03)

- `WALLET_MASTER_SEED` y `BLOCKCHAIN_PRIVATE_KEY` **solo** en variables de entorno; nunca en repo,
  logs ni `CLAUDE.md`. `sidru-contracts/.env` en `.gitignore`.
- Solo `BACKEND_ROLE` mintea/retira/quema; `DEFAULT_ADMIN_ROLE` = deployer.
- Las direcciones por usuario no exponen llaves para firmar; el backend paga el gas.
- El `userId` siempre proviene del JWT, no del cliente.

---

## 9. Trazabilidad C4 / Componentes

| Componente | Subproyecto | Archivo / Artefacto |
|-----------|-------------|---------------------|
| ChapaTuCripto | contracts | `sidru-contracts/contracts/ChapaTuCripto.sol` |
| Web3jBlockchainAdapter | api | `blockchain/infrastructure/web3j/Web3jBlockchainAdapter.java` |
| CustodialWalletService | api | `blockchain/application/.../CustodialWalletService.java` |
| TokensMintedEventListener | api | `blockchain/infrastructure/web3j/TokensMintedEventListener.java` |
| WalletController | api | `blockchain/interfaces/rest/WalletController.java` |
| WalletScreen | mobile | `features/wallet/presentation/wallet_screen.dart` |
| WalletProvider | mobile | `features/wallet/presentation/wallet_provider.dart` |
| WalletRepository | mobile | `features/wallet/data/wallet_repository.dart` |
