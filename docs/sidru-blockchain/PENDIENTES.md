# SIDRU Blockchain — Pendientes y estado de cierre

> Documento de cierre de sesión. Resume **qué quedó hecho**, **qué falta** y el **contexto para
> retomar**. Fecha de cierre inicial: **2026-06-04**. Última actualización: **2026-06-05**.
> Specs fuente: `requirements.md`, `design.md`, `contract-spec.md`, `tasks.md` (en esta carpeta).
>
> **Avance 2026-06-05:** se vació la base de datos (clean slate) y se implementaron + testearon los
> pendientes §2.1 (cablear `redeemFrom` al canje) y §2.2 (job de reconciliación). Suite backend: **26/26**.
> Queda solo la prueba en vivo (§2.3), que depende de POL en la wallet del backend.

---

## 1. Estado del módulo (resumen)

El módulo blockchain está **construido de punta a punta** y **probado en vivo** (mint real):

| Fase | Estado |
|------|--------|
| 0 — Subagentes | ✅ |
| 1 — Specs | ✅ |
| 2 — Contrato `ChapaTuCripto.sol` | ✅ compila |
| 3 — Tests del contrato | ✅ 10/10 |
| 4 — Deploy + verificación en Amoy | ✅ verificado en Polygonscan |
| 5 — Integración Web3j (backend) | ✅ compila + tests |
| 6 — Listener `TokensMinted` + FCM | ✅ (mejorado: confirmación desde el receipt) |
| 7 — WalletScreen Flutter | ✅ `flutter analyze` limpio |
| CIERRE — Revisión de seguridad | ✅ APROBADO CON OBSERVACIONES |

**Prueba E2E realizada:** se confirmó una sesión y se mintearon **280 CTC reales** a la dirección
custodial del ciudadano de prueba; saldo verificado on-chain (`balanceOf`) y `txHash` propagado a la app.

---

## 2. Pendientes DENTRO del alcance

### 2.1. Cablear `redeemFrom` (quema de CTC) al contexto `rewards` — ✅ IMPLEMENTADO (2026-06-05)
- **Estado:** **cableado y con tests** (`RewardRedemptionBurnTest` 3/3). Falta solo **ejercitarlo en vivo**
  (depende de POL en la wallet del backend → ver 2.3).
- **Cómo quedó (DDD respetado, `rewards` NO conoce Web3j):**
  - Gateway: `ChapaTuCriptoContract.redeemFrom(from, amount, rewardTxId)` (EIP-1559, backend paga gas).
  - Fachada ACL del contexto `blockchain`: `interfaces/acl/BlockchainRedemptionFacade` +
    `application/acl/BlockchainRedemptionFacadeImpl` (resuelve dirección custodial, quema
    `pointsCost·10^18`, honra `BLOCKCHAIN_ENABLED`, **best-effort**: nunca rompe el canje off-chain).
  - `rewards` la consume vía `application/internal/outboundservices/acl/ExternalBlockchainService`.
  - `RewardCommandServiceImpl`: tras descontar puntos off-chain y guardar el `PointTransaction`, quema CTC
    con `rewardTxId = PointTransaction.id`. El hash se adjunta al `PointTransaction`
    (columna aditiva `blockchain_tx_hash`) y se expone en `PointTransactionResource` (US-20 AC2).
- **Idempotencia on-chain (mejora 2026-06-05):** `redeemFrom` ahora tiene anti-doble-canje on-chain
  (`mapping rewardRedeemed[rewardTxId]`, análogo a `sessionRecorded` del mint). La fachada consulta
  `rewardRedeemed` (vista, sin gas) antes de quemar: si ya estaba canjeado, **confirma sin re-quemar**
  (marca `redeemed:{id}`). Por eso un reintento es seguro y nunca quema doble. **Requiere el contrato
  redesplegado** (ver §6). Test de contrato 11/11 (incluye el caso de doble canje).
- **Reconciliación de quemas (mejora 2026-06-05):** `rewards/.../scheduling/RewardBurnReconciliationService`
  (`@Scheduled`, gateado por `BLOCKCHAIN_ENABLED`) reintenta las quemas de transacciones `REDEEM` con
  `blockchain_tx_hash` nulo (acotado a 50/tick). Tests: `RewardBurnReconciliationServiceTest` 3/3.
  El canje off-chain sigue siendo no-bloqueante: si la quema falla, los puntos ya se descontaron y la
  reconciliación la completa luego.

### 2.2. Job de reconciliación de mints fallidos — ✅ IMPLEMENTADO (2026-06-05)
- **Estado:** **implementado y con tests** (`BlockchainReconciliationServiceTest` 3/3).
- **Contexto:** si el mint on-chain falla (p. ej. la wallet del backend se quedó sin POL), la sesión se
  **confirma off-chain igual** (puntos acreditados) por diseño (RF-18), pero los CTC **no se mintean** →
  queda un **desfase** puntos↔CTC.
- **Cómo quedó:** `@EnableScheduling` + `sessions/application/internal/scheduling/BlockchainReconciliationService`.
  Cada 5 min (config `sidru.blockchain.reconciliation.*`) busca sesiones `CONFIRMED` con
  `blockchain_tx_hash IS NULL` (acotado a 50/tick, oldest-first) y reintenta `recordSession`. Vive en
  `sessions` (que ya depende de `BlockchainPort`) para evitar el ciclo `blockchain→sessions`. Se apaga solo
  si `BLOCKCHAIN_ENABLED=false`. Idempotente: anti-doble-canje on-chain + `findBySessionId` +
  `unique(session_id)`; si la tx ya existe on-chain pero no se guardó el hash, lo re-adjunta (self-healing).
- **Nota:** el caso real de desfase (antigua sesión id=9) **ya no aplica** — la base se vació el 2026-06-05.

### 2.3. 🟡 Probar en vivo `redeemFrom` y el retiro (`withdrawTo`) — PENDIENTE (requiere POL)
- **Estado:** código ✅ en ambos (canje quema CTC; retiro: `POST /wallet/withdraw`, EIP-55, idempotencia,
  gas pagado por el backend). **No ejercitados end-to-end en vivo** porque la wallet del backend necesita POL.
- **Qué falta (cuando haya POL):**
  1. Canjear una recompensa de un ciudadano con CTC y verificar el evento `TokensRedeemed` + balance bajado.
  2. Retirar a una MetaMask propia y verificar `TokensWithdrawn` + saldo movido en Polygonscan; llenar `linkedWallet`.

---

## 3. 🔵 FCM — código completo, falta solo el proyecto Firebase (2026-06-05)

**Implementado de punta a punta** (ya NO es "para Sprint 2"):
- **Backend:** `FirebaseConfig` (init de `FirebaseApp` gateado por `FIREBASE_ENABLED=true`) +
  `FcmNotificationAdapter` con envío **real** al topic `user-{userId}` (best-effort). Antes era un STUB.
- **App:** `firebase_core` + `firebase_messaging` agregados; `FcmHandler` real (init best-effort en
  `main.dart`, permisos, handlers); el ciudadano se **suscribe a `user-{userId}` en login** y se
  desuscribe en logout (`auth_provider`).
- **Activación con env var:** `sidru.firebase.enabled=${FIREBASE_ENABLED:false}`.

**Único pendiente (solo lo puede hacer el dueño, en la consola Firebase):** crear el proyecto y soltar
las credenciales — `firebase-service-account.json` (backend) + `google-services.json`/`flutterfire
configure` (app). Ambos **gitignored**. Paso a paso en **[`../../FIREBASE_SETUP.md`](../../FIREBASE_SETUP.md)**.

> Mientras no se agreguen esas credenciales, backend y app **funcionan igual** (FCM en no-op,
> sin romper nada). Al soltarlas + `FIREBASE_ENABLED=true`, el push se activa sin tocar código.

---

## 4. ⚪ Hardening opcional (de la revisión de cierre, no aplicado)

Menores/cosméticos, no bloqueantes:
- **H-09** — `.env.example` usa una private key dummy de ceros (mejor un placeholder no-hex).
- **H-10** — añadir `require(from != address(0))` en `redeemFrom` (simetría; OZ ya revierte).
- **H-13** — test extra: `DEFAULT_ADMIN_ROLE` sin `BACKEND_ROLE` no puede mintear.
- **H-14** — checksum EIP-55 completo en el cliente Flutter (hoy solo valida formato; el backend revalida).
- **H-15** — hook `gitleaks`/`detect-secrets` para evitar fugas de claves en commits.

> Ya aplicados en esta sesión: `.gitignore` raíz + mobile, externalización JWT/DB/MQTT, `@Transactional`
> + `unique(session_id)`, gas EIP-1559, `gasLimit` 300k→150k, confirmación-desde-receipt.

---

## 5. ⛔ Fuera de alcance por diseño (exclusiones, no pendientes)

Mainnet (solo testnet Amoy), conversión real a fiat / on-ramp / off-ramp, swap o trading de CTC, bridge
entre redes, tokenomics avanzada (staking/vesting/gobernanza), dashboard admin de wallets, endpoint de
"listar todas las wallets". Ver `requirements.md §5`.

---

## 6. Contexto para retomar (datos públicos)

### On-chain (Polygon Amoy, chainId 80002)
- **Contrato CTC (vigente, con `rewardRedeemed` idempotente):** `0x734abA5606F56F7a6313132c6d608B43e594C684`
  · verificado: `https://amoy.polygonscan.com/address/0x734abA5606F56F7a6313132c6d608B43e594C684#code`
  · holders/token: `https://amoy.polygonscan.com/token/0x734abA5606F56F7a6313132c6d608B43e594C684`
  · ⚠️ Setear `BLOCKCHAIN_CONTRACT_ADDRESS` a esta dirección y reiniciar el backend.
- **Contrato CTC (anterior, sin idempotencia de quema — DEPRECADO):** `0xB24e33d64f69c630353881c9fe3a37C121ffd8ec`
  · Aquí quedaron los **30 CTC** de prueba del ciudadano (userId=2); en el contrato nuevo el saldo arranca en 0.
- **Wallet del backend** (deployer == `BACKEND_ROLE`, paga gas y firma): `0x71f6122D5858a35D2393d1981f22022B9d6bd6cb`
  · ⚠️ necesita **POL** para mintear/retirar (faucets de Amoy tienen límite de 1/24 h).
- **Conversión:** `1 punto = 1 CTC = 10^18 wei`; peso→puntos = `round(weightGrams·0.4)`; soles ref. = `CTC/100`.

### Variables de entorno del backend (valores reales NUNCA en archivos; solo por env var)
`BLOCKCHAIN_ENABLED` · `BLOCKCHAIN_CONTRACT_ADDRESS` · `BLOCKCHAIN_NODE_URL` · `BLOCKCHAIN_PRIVATE_KEY`
· `WALLET_MASTER_SEED` (mnemónico BIP-39; deriva las direcciones custodiales por `userId`).
Secretos de Hardhat en `sidru-contracts/.env` (gitignored): `AMOY_RPC_URL`, `DEPLOYER_PRIVATE_KEY`,
`ETHERSCAN_API_KEY`.

### Datos de prueba (solo dev/testnet)
> ⚠️ La base se **vació el 2026-06-05** (`TRUNCATE … RESTART IDENTITY`). Los datos manuales viejos
> (`e2e@sidru.pe` userId=6, `BIN-E2E`, sesiones, wallets) **ya no existen**; los IDs reinician desde 1.
> Al arrancar el backend, los seeders recrean el baseline (admin + roles + `BIN-001` + 8 rewards).
- **Baseline auto-sembrado:**
  - **Admin:** `admin@sidru.pe` / `Admin1234` (id=1) — `iam/.../ApplicationReadyEventHandler`.
  - **Smart Bin demo:** `BIN-001` (id=1). El `api_key` se **regenera** en cada base nueva; léelo con
    `SELECT api_key FROM smart_bins WHERE device_code='BIN-001';`.
  - **Catálogo:** 8 rewards (`rewards/.../RewardsSeederEventHandler`).
- **Crear un ciudadano de prueba:** registrarlo por la app o `POST /api/v1/authentication/sign-up`. Su
  dirección custodial se deriva sola del `userId` la primera vez que consulta `/wallet/me`.
- **Ver wallets custodiales creadas:** `SELECT user_id, address, derivation_index FROM user_wallet_addresses ORDER BY user_id;`

### Cómo crear y reclamar una sesión de prueba (resumen)
1. Crear sesión PENDING (Smart Bin): `POST /api/v1/sessions` con header `X-Device-Api-Key: <api_key>` y
   body `{"capCount":1,"weightGrams":25}` (→ 10 CTC). Devuelve `qrToken`.
2. Reclamar: en la app, login del ciudadano → Escanear → manual → pegar `qrToken` → Confirmar.
   (o `POST /api/v1/sessions/qr/{qrToken}/confirm` con el JWT del ciudadano.)
3. Verificar: `GET /api/v1/wallet/me` y `GET /api/v1/wallet/me/transactions`.

---

## 7. Sugerencia de orden para la próxima sesión
> §2.1 (cablear `redeemFrom`) y §2.2 (reconciliación) ya están implementados y testeados (2026-06-05).
> Lo que resta es prueba en vivo (necesita POL) y hardening opcional.
1. **Recargar POL** en la wallet del backend (`0x71f6…d6cb`) cuando el faucet lo permita.
2. **Re-probar el reclamo en vivo** (mint) para validar la confirmación-desde-receipt end-to-end.
3. **Probar el canje en vivo** (`redeemFrom`): verificar evento `TokensRedeemed` + balance bajado.
4. **Probar el retiro en vivo** (`withdrawTo`) a una MetaMask propia.
5. **Observar la reconciliación**: forzar un mint fallido (wallet sin POL), luego recargar y verificar que
   el job acredita los CTC pendientes en el siguiente tick.
6. (Opcional) hardening H-09/10/13/14/15 y activar FCM real.
