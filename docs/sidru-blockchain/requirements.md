# SIDRU Blockchain — Requirements Spec (Módulo CTC)

## 1. Introducción

El módulo **blockchain** de SIDRU registra cada sesión de reciclaje válida en una red pública
(**Polygon Amoy**, testnet) y recompensa al ciudadano con el token **CTC ("Chapa Tu Cripto")**,
un ERC-20 de incentivo. El objetivo es dar **trazabilidad pública e inmutable** a las sesiones
confirmadas y un **saldo verificable** de tokens por ciudadano, manteniendo coherencia con el
cálculo de puntos off-chain del backend.

CTC es un **token de incentivo en testnet, sin valor fiat**. La equivalencia en soles que muestra
la app es **referencial/educativa**, no un tipo de cambio real ni una promesa de conversión.

Este documento cubre los requerimientos funcionales y no funcionales del **módulo blockchain
completo**: contrato Solidity (`sidru-contracts/`), integración Web3j en el backend
(`sidru-api/`) y la `WalletScreen` de la app Flutter (`sidru_mobile/`).

---

## 2. Objetivo

Entregar la integración blockchain end-to-end que permita:

- Desplegar y verificar el contrato **ChapaTuCripto (CTC)** en Polygon Amoy vía Hardhat.
- **Mintear CTC** al ciudadano cada vez que una sesión válida se confirma (1 punto = 1 CTC).
- Garantizar **anti-doble-canje on-chain**: una `sessionId` no se recompensa dos veces.
- Persistir cada transacción blockchain en el backend y **propagar el `txHash`** a la app.
- Exponer en la app el **saldo real on-chain** del ciudadano (`balanceOf`) y su historial de
  transacciones con enlace al explorador.
- Permitir al ciudadano **retirar sus CTC** desde la custodia hacia su wallet propia (MetaMask).
- Emitir el evento **TokensMinted** que el backend escucha para confirmar la transacción y
  disparar la notificación FCM.

---

## 3. Modelo de Custodia (decisión de arquitectura)

**Híbrido: custodial por defecto + retiro on-demand.**

1. **Custodia por usuario (base).** El contexto `blockchain` deriva una **dirección
   determinística por ciudadano** desde un seed maestro del backend (HD wallet, índice = `userId`)
   y la persiste en una tabla aditiva `user_wallet_addresses` (no toca `iam` ni `users`). Los CTC
   de cada sesión se mintean a esa dirección custodial y **permanecen on-chain** en Amoy.
   `balanceOf(direcciónCustodial)` = saldo real del ciudadano.
2. **Retiro on-demand.** El ciudadano puede pulsar **"Retirar a mi wallet"** e ingresar su
   dirección MetaMask. El backend transfiere los CTC desde la custodia hacia esa dirección
   **pagando el gas con la wallet del backend**. Las direcciones por usuario **NUNCA firman ni
   pagan gas** (no custodian POL); el movimiento se hace con funciones privilegiadas del contrato
   restringidas a `BACKEND_ROLE`.

> El canje de recompensas (contexto `rewards`) descuenta CTC **on-chain** (burn desde la custodia,
> `redeemFrom`), manteniéndolo coherente con el descuento de puntos off-chain. "Retirar" mueve los
> tokens **dentro de Amoy** a la wallet propia del ciudadano; **no** los convierte a soles.

---

## 4. Alcance Incluido

| Área | Funcionalidades |
|------|----------------|
| Contrato | ERC-20 CTC + AccessControl, mint por sesión, anti-doble-canje, withdraw y redeem custodiales, eventos, deploy + verify en Amoy |
| Backend | Resolución/persistencia de direcciones custodiales, adapter Web3j real, persistencia de `BlockchainTransaction`, idempotencia/reintentos, listener de eventos, endpoints de wallet y retiro |
| App | `WalletScreen`: dirección truncada, red, balance (`balanceOf`), equivalencia referencial en soles, lista de transacciones con hash/estado y enlace al explorador, flujo "Retirar a mi wallet" |

## 5. Alcance Excluido

- Mainnet (solo testnet Amoy en este módulo).
- Conversión real a fiat / on-ramp / off-ramp.
- Wallet con firma del lado del ciudadano (self-custody con su propia llave para firmar): el modelo
  es custodial; el retiro es la única salida hacia self-custody.
- Tokenomics avanzada (staking, vesting, gobernanza, supply cap dinámico).
- Swap o trading de CTC.
- Bridge entre redes.

---

## 6. User Stories

> Las US del módulo se alinean al documento de diseño OE2 (US-05, US-14, US-21, US-24, US-35,
> US-38) y a las anclas de integración con mobile (US-20 AC2, US-25 AC3, US-39).

**US-BC-01** — Recompensa on-chain por sesión *(OE2 US-05 · RF-17)*
> Como ciudadano reciclador, quiero recibir tokens CTC en mi wallet custodial cuando confirmo una
> sesión válida, para ser recompensado de forma transparente por reciclar.

**US-BC-02** — Anti-doble-canje on-chain *(OE2 US-24)*
> Como operador del sistema, quiero que una misma `sessionId` no pueda recompensarse dos veces en
> la blockchain, para evitar fraude y doble acreditación.

**US-BC-03** — Trazabilidad pública de la sesión *(OE2 US-21 · RNF-18)*
> Como auditor, quiero que cada sesión recompensada quede registrada on-chain con su `sessionId`,
> usuario, hash del QR y monto, para poder verificarla en Polygonscan.

**US-BC-04** — Saldo verificable en la app *(OE2 US-14 · US-25 AC3 · RF-19)*
> Como ciudadano reciclador, quiero ver en la app mi saldo real de CTC (`balanceOf`), la red y mi
> dirección, para confiar en que mis recompensas existen on-chain.

**US-BC-05** — Propagación del `txHash` *(US-20 AC2)*
> Como ciudadano reciclador, quiero ver el hash de la transacción de mi sesión confirmada, para
> poder auditarla en el explorador.

**US-BC-06** — Retiro a wallet propia *(OE2 US-35)*
> Como ciudadano reciclador, quiero retirar mis CTC desde la custodia hacia mi wallet MetaMask,
> para tener autocustodia de mis tokens.

**US-BC-07** — Notificación de tokens acreditados *(US-39)*
> Como ciudadano reciclador, quiero recibir una notificación cuando mis tokens se acreditan
> on-chain, para enterarme de mi recompensa sin revisar la app.

**US-BC-08** — Despliegue y verificación del contrato *(OE2 US-38 · RF-16 · RNF-16 · RNF-18)*
> Como desarrollador, quiero desplegar y verificar el contrato CTC en Polygon Amoy con ABI
> publicada, para que sea auditable y consumible por el backend.

**US-BC-09** — Operación sin blockchain en dev *(operacional)*
> Como desarrollador, quiero poder correr el backend con `BLOCKCHAIN_ENABLED=false`, para
> desarrollar sin depender de la red.

---

## 7. Criterios de Aceptación (Gherkin)

### US-BC-01 — Recompensa on-chain por sesión

```gherkin
Escenario: Mint al confirmar una sesión PENDING
  Dado que una sesión está en estado PENDING y blockchain está habilitado
  Cuando el backend confirma la sesión
  Entonces el backend resuelve la dirección custodial del ciudadano (HD, índice = userId)
  Y llama recordAndReward(direccionCustodial, sessionId, qrHash, amount)
  Y amount = pointsEarned * 10^18 (1 punto = 1 CTC, 18 decimales)
  Y el contrato mintea CTC a la dirección custodial
  Y emite SessionRecorded y TokensMinted
  Y el backend persiste BlockchainTransaction con txHash y network="polygon-amoy"
  Y adjunta el txHash a la sesión

Escenario: Blockchain deshabilitado
  Dado que BLOCKCHAIN_ENABLED=false
  Cuando el backend confirma la sesión
  Entonces no se realiza ninguna llamada on-chain
  Y la confirmación de la sesión se completa con normalidad (txHash nulo)
```

### US-BC-02 — Anti-doble-canje on-chain

```gherkin
Escenario: Rechazo de sessionId duplicada
  Dado que la sessionId N ya fue registrada on-chain (sessionRecorded[N] == true)
  Cuando el backend llama recordAndReward(..., N, ...)
  Entonces la transacción revierte con "session already recorded"
  Y no se mintea CTC adicional

Escenario: Idempotencia en el backend
  Dado que ya existe una BlockchainTransaction para la sessionId N
  Cuando el backend procesa nuevamente la confirmación de N
  Entonces no envía una nueva transacción on-chain
  Y reutiliza el txHash existente
```

### US-BC-03 — Trazabilidad pública

```gherkin
Escenario: Evento auditable
  Dado que una sesión fue recompensada
  Cuando se inspecciona el contrato en Polygonscan
  Entonces existe un evento SessionRecorded con sessionId, user, qrHash, amount y timestamp
  Y el contrato está verificado y su ABI publicada
```

### US-BC-04 — Saldo verificable en la app

```gherkin
Escenario: Ver saldo on-chain
  Dado que el ciudadano tiene CTC en su dirección custodial
  Cuando abre la WalletScreen
  Entonces la app muestra la dirección custodial truncada
  Y la red "Polygon Amoy"
  Y el balance = balanceOf(direccionCustodial) formateado con 18 decimales
  Y una equivalencia referencial en soles (1 CTC ≈ S/ 0.01, etiquetada como estimada)

Escenario: Sin tokens todavía
  Dado que el ciudadano aún no tiene CTC
  Entonces la app muestra balance 0 CTC sin error
```

### US-BC-05 — Propagación del txHash

```gherkin
Escenario: txHash en el detalle de sesión
  Dado que una sesión confirmada generó una transacción on-chain
  Cuando el ciudadano abre el detalle de la sesión
  Entonces se muestra el blockchainTxHash truncado
  Y un enlace a amoy.polygonscan.com/tx/{txHash}
```

### US-BC-06 — Retiro a wallet propia

```gherkin
Escenario: Retiro exitoso del saldo completo
  Dado que el ciudadano tiene saldo de CTC en custodia
  Y pulsa "Retirar a mi wallet"
  Y pega una dirección con formato y checksum EIP-55 válidos
  Cuando confirma el retiro
  Entonces el backend llama withdrawTo(direccionCustodial, direccionDestino, saldoCompleto)
  Y el gas lo paga la wallet del backend (la dirección custodial no firma)
  Y el contrato transfiere los CTC a la dirección destino
  Y emite TokensWithdrawn
  Y el backend persiste el retiro como COMPLETADO con su txHash

Escenario: Dirección inválida
  Dado que la dirección ingresada no cumple formato/checksum EIP-55
  Entonces la app rechaza el retiro con mensaje claro y no llama al backend

Escenario: Retiro sin saldo
  Dado que el saldo custodial es 0
  Entonces el backend no envía transacción y responde un error controlado "Sin saldo para retirar"

Escenario: Idempotencia del retiro
  Dado que un retiro para el usuario está EN_PROCESO
  Cuando llega otra solicitud de retiro del mismo usuario
  Entonces el backend no envía una segunda transacción
  Y devuelve el estado del retiro en curso
```

### US-BC-07 — Notificación de tokens acreditados

```gherkin
Escenario: FCM tras TokensMinted
  Dado que el backend está suscrito al evento TokensMinted
  Cuando el contrato emite TokensMinted(user, amount, sessionId)
  Entonces el backend marca la BlockchainTransaction como confirmada
  Y dispara una notificación FCM al ciudadano (si FCM está habilitado)
```

### US-BC-08 — Despliegue y verificación

```gherkin
Escenario: Deploy verificado en Amoy
  Dado el proyecto Hardhat configurado con la red amoy (chainId 80002)
  Cuando se ejecuta el script de deploy con la wallet del backend como BACKEND_ROLE
  Entonces el contrato queda desplegado en Amoy
  Y se verifica en Polygonscan con Etherscan V2
  Y se exportan ABI y dirección a sidru-contracts/deployments/
```

### US-BC-09 — Operación sin blockchain en dev

```gherkin
Escenario: Flag de habilitación
  Dado BLOCKCHAIN_ENABLED=false
  Cuando se levanta el backend
  Entonces todos los flujos funcionan sin tocar la red
  Y recordSession devuelve Optional.empty()
```

---

## 8. Requerimientos No Funcionales

| ID | Categoría | Descripción |
|----|-----------|-------------|
| RNF-BC-01 | Seguridad | Ninguna clave privada, seed ni secreto en el repo, logs ni archivos versionados; solo en `.env` (Hardhat) y variables de entorno (Spring), referenciadas por nombre |
| RNF-BC-02 | Seguridad | Solo `BACKEND_ROLE` puede mintear, retirar (`withdrawTo`) y quemar (`redeemFrom`); el deployer es `DEFAULT_ADMIN_ROLE` |
| RNF-BC-03 | Seguridad | Las direcciones custodiales por usuario no custodian POL ni firman transacciones; el backend paga todo el gas |
| RNF-BC-04 | Solidez | Solidity 0.8.24 (overflow checks nativos); optimizer runs=200 (RNF-16) |
| RNF-BC-05 | Auditabilidad | Contrato verificado en Polygonscan con ABI publicada (RNF-18) |
| RNF-BC-06 | Resiliencia | La integración Web3j maneja errores y reintenta con backoff ante fallos transitorios de RPC (RF-18) |
| RNF-BC-07 | Idempotencia | Reintentos no generan minteos/retiros duplicados (anti-doble-canje on-chain + estado en backend) |
| RNF-BC-08 | Coherencia | El monto on-chain es coherente con el cálculo off-chain: 1 punto = 1 CTC = 10^18 wei |
| RNF-BC-09 | Arquitectura | `sessions` usa solo el puerto `BlockchainPort`; no conoce Web3j ni direcciones |
| RNF-BC-10 | Operabilidad | `BLOCKCHAIN_ENABLED=false` permite correr todo el sistema sin red blockchain |
| RNF-BC-11 | Trazabilidad | Cada transacción on-chain se persiste (`BlockchainTransaction`) y se enlaza a Polygonscan |

---

## 9. Reglas de Negocio

| ID | Regla |
|----|-------|
| RN-BC-01 | 1 punto off-chain = 1 CTC on-chain (18 decimales). `amount = pointsEarned * 10^18` |
| RN-BC-02 | Una `sessionId` se recompensa una sola vez (mapping `sessionRecorded` + `require`) |
| RN-BC-03 | Solo se mintea al confirmar una sesión PENDING válida (no expirada) |
| RN-BC-04 | La dirección custodial se deriva de forma determinística por `userId` (HD) y se persiste |
| RN-BC-05 | El retiro por defecto mueve el saldo completo a la dirección destino del ciudadano |
| RN-BC-06 | El retiro valida formato + checksum EIP-55 antes de tocar la red |
| RN-BC-07 | El retiro es idempotente: estados EN_PROCESO / COMPLETADO / FALLIDO |
| RN-BC-08 | El canje de recompensa quema CTC de la custodia (`redeemFrom`) en coherencia con el descuento de puntos off-chain |
| RN-BC-09 | "Retirar" mueve tokens dentro de Amoy; no convierte a fiat |
| RN-BC-10 | La equivalencia en soles mostrada es referencial (1 CTC ≈ S/ 0.01), nunca un tipo de cambio real |

---

## 10. Estados de Error

| Estado | Descripción | Capa | Acción recomendada |
|--------|-------------|------|-------------------|
| ERR-BC-01 | RPC no disponible | Backend Web3j | Reintentar con backoff; no marcar confirmada |
| ERR-BC-02 | `session already recorded` (revert) | Contrato | Tratar como idempotente: reutilizar tx previa |
| ERR-BC-03 | Gas/fondos insuficientes en wallet backend | Backend | Log de error operativo; no romper confirmación de sesión |
| ERR-BC-04 | Dirección de retiro inválida (EIP-55) | App / Backend | Mensaje inline; no llamar a la red |
| ERR-BC-05 | Retiro sin saldo | Backend | "Sin saldo para retirar" |
| ERR-BC-06 | Retiro sin wallet de destino ingresada | App | Solicitar dirección antes de continuar |
| ERR-BC-07 | Retiro ya en proceso | Backend | Devolver estado en curso (idempotente) |
| ERR-BC-08 | Balance no consultable (RPC) | App | Mostrar estado de error con retry |

---

## 11. Trazabilidad: US → RF/RNF (OE2)

| US módulo | OE2 / Ancla | RF | RNF |
|-----------|-------------|----|-----|
| US-BC-01 | US-05 | RF-17 | RNF-BC-08 |
| US-BC-02 | US-24 | RF-17 | RNF-BC-07 |
| US-BC-03 | US-21 | RF-16 | RNF-18 / RNF-BC-05 |
| US-BC-04 | US-14, US-25 AC3 | RF-19 | RNF-BC-11 |
| US-BC-05 | US-20 AC2 | RF-19 | RNF-BC-11 |
| US-BC-06 | US-35 | RF-19 | RNF-BC-03 |
| US-BC-07 | US-39 | RF-18 | RNF-BC-06 |
| US-BC-08 | US-38 | RF-16 | RNF-16, RNF-18 |
| US-BC-09 | — (operacional) | RF-18 | RNF-BC-10 |

### Mapa RF/RNF → entregable

| Requisito | Entregable |
|-----------|-----------|
| RF-16 | `sidru-contracts/` (Hardhat) + deploy en Amoy |
| RF-17 | `recordAndReward` + `Web3jBlockchainAdapter` |
| RF-18 | Manejo de errores/reintentos + listener de eventos |
| RF-19 | `WalletScreen` + endpoints de wallet/retiro |
| RNF-16 | Solidity 0.8.24, optimizer 200 |
| RNF-18 | Verificación en Polygonscan + ABI en `deployments/` |

---

## 12. Referencias Obligatorias

| Documento | Propósito |
|-----------|-----------|
| `requirements.md` | User Stories, criterios Gherkin, reglas de negocio, estados de error |
| `design.md` | Arquitectura, contrato refinado, modelo custodial, flujos, DDD y MVVM |
| `contract-spec.md` | Especificación del contrato, conversión puntos→CTC, eventos, deploy |
| `tasks.md` | Plan fase por fase con checkboxes |
| `CLAUDE.md` | Convenciones del monorepo y gestión de secretos (regla dura) |
| `docs/specs/sidru-mobile/*` | Estilo de specs y contrato de la app a respetar |
| Documento OE2 (C4) | Fuente de las US/RF/RNF del módulo blockchain |
