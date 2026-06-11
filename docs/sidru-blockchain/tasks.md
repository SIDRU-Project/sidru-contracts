# SIDRU Blockchain — Tasks Spec (Módulo CTC)

---

## Estado actual

| Ítem | Estado |
|------|--------|
| `requirements.md` | ✅ Creado |
| `design.md` | ✅ Creado |
| `contract-spec.md` | ✅ Creado |
| `tasks.md` | ✅ Creado |
| FASE 0 — Subagentes `.claude/agents/` | ✅ Verificados (4 archivos) |
| FASE 1 — Especificaciones | ✅ Aprobada |
| FASE 2 — Contrato | ✅ Completada (compila) |
| FASE 3 — Tests del contrato | ✅ Completada (10/10) |
| FASE 4 — Deploy + verificación Amoy | ✅ Completada (verificado) |
| FASE 5 — Integración API (Web3j) | ✅ Completada (compila + tests) |
| FASE 6 — Listener de eventos | ✅ Completada (16/16) |
| FASE 7 — WalletScreen Flutter | ✅ Completada (analyze limpio) |
| CIERRE — Revisión de seguridad | ✅ Realizada (ver veredicto) |

> 📌 **Pendientes y contexto para retomar:** ver [`PENDIENTES.md`](./PENDIENTES.md) — qué falta dentro
> del alcance (cablear `redeemFrom` a rewards, job de reconciliación, probar el retiro en vivo), qué
> quedó construido pero inactivo (FCM), hardening opcional y datos públicos para continuar.

> **Regla de ejecución:** fase por fase, en orden secuencial. No avanzar sin validar la fase actual,
> marcar sus checkboxes y obtener confirmación del usuario. Al cerrar cada fase: listar archivos
> creados/modificados, cómo probar, y marcar checkboxes.

---

## Referencias obligatorias

| Documento | Propósito |
|-----------|-----------|
| `requirements.md` | US, criterios Gherkin, RNF, reglas de negocio, errores |
| `design.md` | Arquitectura, modelo custodial, flujos, DDD/MVVM |
| `contract-spec.md` | Contrato, conversión puntos→CTC, eventos, deploy |
| `CLAUDE.md` | Convenciones del monorepo + gestión de secretos (regla dura) |
| `docs/specs/sidru-mobile/*` | Estilo de specs y contrato de la app |
| Documento OE2 (C4) | US/RF/RNF del módulo |

---

## FASE 2 — Contrato (delegar a `solidity-engineer`) ✅

- [x] `sidru-contracts/package.json` con Hardhat + OpenZeppelin + toolbox
- [x] `sidru-contracts/hardhat.config.ts` — red `amoy` (chainId 80002), optimizer runs=200, Etherscan V2 desde `.env`
- [x] `sidru-contracts/.env.example` — `AMOY_RPC_URL`, `DEPLOYER_PRIVATE_KEY`, `ETHERSCAN_API_KEY` (valores ficticios)
- [x] Verificar que `.env` esté en `.gitignore`
- [x] `sidru-contracts/contracts/ChapaTuCripto.sol` — ERC20+AccessControl, `recordAndReward`, `withdrawTo`, `redeemFrom`, eventos, NatSpec EN
- [x] `npx hardhat compile` sin errores

**Cómo probar:** `cd sidru-contracts && npx hardhat compile`.

---

## FASE 3 — Tests del contrato (`solidity-engineer`) ✅

- [x] `test/ChapaTuCripto.test.ts` cubriendo los 10 casos de `contract-spec.md §9`:
  - [x] mint solo por `BACKEND_ROLE`; rechazo sin rol
  - [x] rechazo de `sessionId` duplicada ("session already recorded")
  - [x] emisión de `SessionRecorded` y `TokensMinted` con args correctos
  - [x] `balanceOf` correcto tras mint
  - [x] `withdrawTo`: transfiere, emite `TokensWithdrawn`, revierte con destino 0 / sin saldo / sin rol
  - [x] `redeemFrom`: quema, emite `TokensRedeemed`, revierte sin rol
  - [x] **(OBLIGATORIO)** coherencia off-chain/on-chain: `pointsEarned` puntos → `pointsEarned·10^18` wei (caso 280)
- [x] `npx hardhat test` en verde — 10/10 passing (el test de coherencia pasa)

**Cómo probar:** `cd sidru-contracts && npx hardhat test`.

---

## FASE 4 — Deploy a Amoy + verificación (`solidity-engineer`) ✅

- [x] `scripts/deploy.ts` — despliega con `backend` = wallet del backend; guard de red amoy/80002; imprime dirección y txHash
- [x] `npx hardhat run scripts/deploy.ts --network amoy`
- [x] `npx hardhat verify --network amoy <ADDRESS> <backend-address>` (Etherscan V2)
- [x] Exportar `deployments/amoy/ChapaTuCripto.json` (ABI) y `deployments/amoy/address.json`
- [x] Reportar dirección + link de Polygonscan

> **Contrato desplegado y verificado:** `0xB24e33d64f69c630353881c9fe3a37C121ffd8ec`
> `https://amoy.polygonscan.com/address/0xB24e33d64f69c630353881c9fe3a37C121ffd8ec#code`
> backend == deployer == `0x71f6122D5858a35D2393d1981f22022B9d6bd6cb` (MVP, misma wallet).
> Este address alimenta `BLOCKCHAIN_CONTRACT_ADDRESS` en la Fase 5.

**Cómo probar:** revisar el contrato verificado en `amoy.polygonscan.com/address/<ADDRESS>`.

> Prerequisito: `sidru-contracts/.env` con secretos reales (ya provisto por el usuario). Nunca commitear.

---

## FASE 5 — Integración API (delegar a `spring-web3j-engineer`) ✅

- [x] Acceso al contrato Web3j (`ChapaTuCriptoContract.java`) — escrito a mano con `org.web3j:core` (no había CLI): `Function`/`FunctionEncoder` + `RawTransactionManager` (chainId 80002) + `eth_call` para `balanceOf`
- [x] `blockchain/domain/.../UserWalletAddress.java` + `WithdrawalRequest.java` (aggregates nuevos)
- [x] `blockchain/infrastructure/.../UserWalletAddressRepository.java`, `WithdrawalRequestRepository.java`
- [x] `blockchain/application/.../CustodialWalletService.java` — deriva dirección HD por `userId` (m/44'/60'/0'/0/{userId}) desde `WALLET_MASTER_SEED`, persiste; solo usa la dirección pública
- [x] Reemplazar STUB de `Web3jBlockchainAdapter.recordSession`:
  - [x] respetar `enabled`; idempotencia por `findBySessionId`
  - [x] resolver dirección custodial; `amount = pointsEarned·10^18`; `qrHash = keccak256(qrToken)`
  - [x] llamar `recordAndReward(...)`; persistir `BlockchainTransaction` real con `network="polygon-amoy"`
  - [x] manejo de errores + reintentos con backoff (RF-18); no rompe la confirmación off-chain
- [x] `WalletQueryService` + `WithdrawalCommandService` (retiro idempotente vía `withdrawTo`, validación EIP-55, sin-saldo/sin-wallet)
- [x] `WalletController` REST: `GET /wallet/me`, `GET /wallet/me/transactions`, `POST /wallet/withdraw`, `GET /wallet/withdraw/status`
- [x] Externalizar `application.properties` con `${VAR:default}` (node-url→Amoy, contract-address, private-key, enabled) + `WALLET_MASTER_SEED`
- [x] `sessions` sigue usando SOLO `BlockchainPort` (firma del puerto intacta; sin filtrar Web3j)
- [x] `./mvnw compile` verde · `./mvnw test` → 12/12 (conversión 280·10^18, EIP-55, **determinismo HD** mismo userId→misma dirección, **idempotencia de retiro** no permite dos simultáneos)

> Nota: `BlockchainTransaction` recibió una columna aditiva `userId` (denormalizada para el historial de wallet) + constructor sobrecargado; no rompe el constructor existente. `confirmed=false` hasta la Fase 6.

**Cómo probar:** con `BLOCKCHAIN_ENABLED=true` y env vars, confirmar una sesión y ver el txHash real
en Polygonscan; `GET /wallet/me` devuelve balance > 0.

> **Nota de alcance (coherencia rewards↔CTC):** el burn por canje (`redeemFrom`) queda especificado y
> con función/test en el contrato. Su cableado en el contexto `rewards` se hace **sin romper** el flujo
> off-chain del Sprint 1; si introduce riesgo, se trata como sub-tarea separada y se confirma antes.

---

## FASE 6 — Listener de eventos (`spring-web3j-engineer`) ✅

- [x] `TokensMintedEventListener` — suscripción Web3j (`EthFilter` desde LATEST, topic0, scheduler daemon)
- [x] `TokensMintedHandler.onTokensMinted(...)` marca `BlockchainTransaction.confirmed=true` por `sessionId` (idempotente)
- [x] Disparar FCM al ciudadano vía ACL aditivo `NotificationContextFacade` → topic `user-{userId}` (US-39), best-effort
- [x] Tolerancia a `enabled=false` (no suscribe) y re-suscripción con backoff exponencial ante caída de RPC
- [x] Test unitario `TokensMintedHandlerTest` (confirma+notifica / idempotencia / sin tx) — `./mvnw test` 16/16

> ACL en `notifications` añadido de forma aditiva (`interfaces/acl/NotificationContextFacade` + impl). `ChapaTuCriptoContract` expuso `web3jClient()`/`contractAddress()` (aditivo). sessions/rewards/iam/users intactos.

**Cómo probar:** confirmar una sesión con blockchain activo y verificar que la tx pasa a `confirmed`
y (si FCM on) llega la notificación.

---

## FASE 7 — WalletScreen Flutter (delegar a `flutter-engineer`) ✅

- [x] `features/wallet/data/wallet_api.dart` — `GET /wallet/me`, `GET /wallet/me/transactions`, `POST /wallet/withdraw`, `GET /wallet/withdraw/status` (204→null)
- [x] `features/wallet/data/wallet_repository.dart` — abstrae y mapea `ApiException`
- [x] `features/wallet/data/models/wallet_balance.dart` (reemplaza placeholder), `wallet_transaction.dart`, `withdrawal_status.dart` (freezed+json)
- [x] `features/wallet/presentation/wallet_provider.dart` — `AsyncNotifier<WalletBalance?>` + `FutureProvider` de transacciones + controller de retiro (refresca al completar)
- [x] `features/wallet/presentation/wallet_screen.dart` — dirección truncada, red Amoy, balance CTC, equivalencia "≈ S/ {solesRef} (estimado)", transacciones con link al explorador
- [x] `widgets/withdraw_sheet.dart` — input + validación EIP-55 de formato inline + estados; checksum revalidado por backend
- [x] Ruta `/wallet` integrada (ya montada fullscreen); consume `ApiClient`/`JwtInterceptor`; manejo global de 401
- [x] `dart run build_runner build` OK · `dart format .` · `flutter analyze` → **No issues found!**

> Transacciones sin monto (calca `WalletTransactionResource`). Se añadió `url_launcher` para abrir el explorador. No se tocó `.env` ni otros features.

**Cómo probar:** `flutter run`, abrir `/wallet`, ver balance real; probar retiro con dirección válida e
inválida; verificar tx en el explorador.

---

## CIERRE — Revisión de seguridad y cumplimiento (`blockchain-reviewer`) ✅

- [x] Sin claves/seed en repo ni logs; `.env` gitignored; `application.properties` con `${VAR:default}`
- [x] Anti-doble-canje por `sessionId`; solo `BACKEND_ROLE` mintea/retira/quema
- [x] Eventos `SessionRecorded`/`TokensMinted`/`TokensWithdrawn`/`TokensRedeemed` correctos e indexados
- [x] `sessions` no conoce Web3j (puerto respetado); bounded contexts intactos
- [x] Idempotencia y reintentos (RF-18); retiro idempotente
- [x] RNF-18: contrato verificado en Polygonscan + ABI publicada
- [x] Coherencia puntos→CTC (1:1, 18 decimales)
- [x] `balanceOf` como saldo del usuario y `txHash` propagado a la app (US-20 AC2, US-25 AC3)
- [x] Lista priorizada de hallazgos entregada

### Veredicto: APROBADO CON OBSERVACIONES
- **Falsos positivos verificados con git/código:** H-01 (`.env` NO commiteado; repo sin commits) y H-07 (división entre 10^18 siempre termina).
- **Remediaciones aplicadas (las 4 elegidas):**
  - [x] `.gitignore` raíz del monorepo + `.env` en `sidru_mobile/.gitignore` (H-05/H-06)
  - [x] Externalizados JWT/DB/MQTT a `${VAR:default}` en `application.properties` (H-02/03/04)
  - [x] Anti-TOCTOU: `@Transactional` en `recordSession` + `unique=true` en `session_id` (H-08)
  - [x] Gas EIP-1559 dinámico en `ChapaTuCriptoContract` para Amoy (H-12)
  - [x] Verificación conjunta: `./mvnw test` 16/16 verde
- **Menores no aplicados (cosméticos/decisiones tomadas):** H-09, H-10, H-13, H-14.

---

## Comandos útiles

```bash
# Contrato
cd sidru-contracts
npx hardhat compile
npx hardhat test
npx hardhat run scripts/deploy.ts --network amoy
npx hardhat verify --network amoy <ADDRESS> <backend-address>

# Backend
cd sidru-api/sidru-api
./mvnw test
./mvnw spring-boot:run     # con env vars BLOCKCHAIN_* y WALLET_MASTER_SEED

# App
cd sidru_mobile
flutter pub get
dart format .
flutter analyze
flutter run
```
