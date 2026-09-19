#!/usr/bin/env node
// Comprobación del `.env` de sidru-contracts antes del despliegue en Polygon mainnet.
//
// Regla: NUNCA imprime un valor secreto. De la clave privada solo muestra la dirección
// pública que deriva; de la API key y del RPC solo dice si están y (del RPC) el host.
// Uso:  node scripts/check-mainnet-env.js
// Sale con código 1 si hay algún ✘ (bloqueante); ⚠ es aviso, no bloquea.

require("dotenv").config();
const { ethers } = require("ethers");

const NATIVE_USDC_POLYGON = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const EXAMPLE_KEY = "0x" + "0".repeat(64);
const EXAMPLE_ETHERSCAN = "your_etherscan_v2_api_key_here";
const PLACEHOLDER_RPC = "https://polygon-rpc.com";

let failures = 0;
const ok = (name, msg) => console.log(`  ✔ ${name}: ${msg}`);
const warn = (name, msg) => console.log(`  ⚠ ${name}: ${msg}`);
const fail = (name, msg) => {
  failures++;
  console.log(`  ✘ ${name}: ${msg}`);
};

function checkRpc() {
  const url = process.env.POLYGON_RPC_URL ?? "";
  if (!url) return fail("POLYGON_RPC_URL", "falta");
  if (!url.startsWith("https://")) return fail("POLYGON_RPC_URL", "debe empezar por https://");
  if (url.includes("<")) return fail("POLYGON_RPC_URL", "todavía tiene un marcador <...> sin reemplazar");
  if (url === PLACEHOLDER_RPC) return fail("POLYGON_RPC_URL", "es el valor de ejemplo; pon la URL con clave de Alchemy/Infura");
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return fail("POLYGON_RPC_URL", "no es una URL válida");
  }
  ok("POLYGON_RPC_URL", `presente (host ${host})`);
  return url;
}

function checkDeployerKey() {
  const key = process.env.DEPLOYER_PRIVATE_KEY ?? "";
  if (!key) return fail("DEPLOYER_PRIVATE_KEY", "falta (clave de la wallet ADMIN, solo durante el despliegue)");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    return fail(
      "DEPLOYER_PRIVATE_KEY",
      `formato inválido: se esperan 66 caracteres (0x + 64 hex), hay ${key.length}${key.startsWith("0x") ? "" : " y no empieza por 0x"}`
    );
  }
  if (key === EXAMPLE_KEY) return fail("DEPLOYER_PRIVATE_KEY", "es la clave de ejemplo (todo ceros)");
  const address = new ethers.Wallet(key).address;
  ok("DEPLOYER_PRIVATE_KEY", `formato correcto; deriva la dirección ${address}`);
  const expected = process.env.EXPECTED_ADMIN_ADDRESS;
  if (expected) {
    if (expected.toLowerCase() === address.toLowerCase()) ok("EXPECTED_ADMIN_ADDRESS", "coincide con la dirección derivada");
    else fail("EXPECTED_ADMIN_ADDRESS", `NO coincide: la clave pegada deriva ${address}, se esperaba ${expected}`);
  }
  return address;
}

function checkAddress(name, value, { mustDifferFrom } = {}) {
  if (!value) return fail(name, "falta");
  if (!ethers.isAddress(value)) return fail(name, `no es una dirección válida (${value})`);
  let checksummed;
  try {
    checksummed = ethers.getAddress(value);
  } catch {
    return fail(name, `checksum EIP-55 incorrecto (${value})`);
  }
  if (checksummed !== value) return fail(name, `checksum EIP-55 incorrecto: cópiala de MetaMask tal cual (${checksummed})`);
  if (mustDifferFrom && checksummed.toLowerCase() === mustDifferFrom.toLowerCase()) {
    return fail(name, `es la misma dirección que deriva DEPLOYER_PRIVATE_KEY; ADMIN y BACKEND deben ser wallets distintas`);
  }
  ok(name, checksummed);
  return checksummed;
}

function checkReserveToken() {
  const value = process.env.RESERVE_TOKEN_ADDRESS ?? "";
  if (!value) return fail("RESERVE_TOKEN_ADDRESS", `falta (USDC nativo de Circle en Polygon PoS: ${NATIVE_USDC_POLYGON})`);
  if (value.toLowerCase() !== NATIVE_USDC_POLYGON.toLowerCase()) {
    return fail(
      "RESERVE_TOKEN_ADDRESS",
      `${value} no es el USDC nativo de Circle (${NATIVE_USDC_POLYGON}); si es 0x2791…4174 es USDC.e puenteado y NO sirve`
    );
  }
  ok("RESERVE_TOKEN_ADDRESS", `${NATIVE_USDC_POLYGON} (USDC nativo de Circle)`);
}

function checkParity() {
  const raw = process.env.CENTS_PER_RESERVE_UNIT ?? "";
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) return fail("CENTS_PER_RESERVE_UNIT", `debe ser un entero > 0 (hay "${raw}")`);
  const cents = Number(raw);
  if (cents < 300 || cents > 450) warn("CENTS_PER_RESERVE_UNIT", `${cents} está fuera del rango habitual 300–450 (S/ 3.00–4.50 por USDC); revisa el tipo de cambio`);
  else ok("CENTS_PER_RESERVE_UNIT", `${cents} → 1 USDC = S/ ${(cents / 100).toFixed(2)} = ${cents} CTC`);
}

function checkEtherscan() {
  const key = process.env.ETHERSCAN_API_KEY ?? "";
  if (!key) return fail("ETHERSCAN_API_KEY", "falta (necesaria para hardhat verify)");
  if (key === EXAMPLE_ETHERSCAN) return fail("ETHERSCAN_API_KEY", "es el valor de ejemplo");
  ok("ETHERSCAN_API_KEY", "presente");
}

async function checkChain(url, deployer, backend) {
  if (!url) return;
  const provider = new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true });
  const withTimeout = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 10 s")), 10_000))]);
  try {
    const chainId = Number(await withTimeout(provider.send("eth_chainId", [])));
    if (chainId !== 137) return fail("RPC", `responde chainId ${chainId}; se necesita 137 (Polygon mainnet)`);
    ok("RPC", "responde chainId 137 (Polygon mainnet)");
  } catch (e) {
    return fail("RPC", `no responde: ${e.message}`);
  }
  for (const [label, addr, min] of [["POL de ADMIN (deployer)", deployer, 1], ["POL de BACKEND", backend, 2]]) {
    if (!addr) continue;
    try {
      const bal = Number(ethers.formatEther(await withTimeout(provider.getBalance(addr))));
      if (bal < min) warn(label, `${bal.toFixed(4)} POL (recomendado ≥ ${min})`);
      else ok(label, `${bal.toFixed(4)} POL`);
    } catch (e) {
      warn(label, `no se pudo leer el saldo: ${e.message}`);
    }
  }
}

(async () => {
  console.log("Comprobación del .env para mainnet (no se imprime ningún secreto)\n");
  const url = checkRpc();
  const deployer = checkDeployerKey();
  const backend = checkAddress("BACKEND_ADDRESS", process.env.BACKEND_ADDRESS, { mustDifferFrom: deployer });
  checkReserveToken();
  checkParity();
  checkEtherscan();
  await checkChain(typeof url === "string" ? url : null, deployer, backend);
  console.log("");
  if (failures > 0) {
    console.log(`Resultado: ${failures} problema(s) bloqueante(s). Corrige el .env y vuelve a ejecutar.`);
    process.exit(1);
  }
  console.log("Resultado: listo para el ensayo en seco (npx hardhat run scripts/deploy-stable.ts --network polygon).");
})().catch((e) => {
  console.error("Error inesperado:", e.message);
  process.exit(1);
});
