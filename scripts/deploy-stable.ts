// Script de despliegue de ChapaTuCriptoStable (CTC con paridad dura) en hardhat/amoy/polygon.
//
// Uso:
//   npx hardhat run scripts/deploy-stable.ts --network hardhat   (con MockStableReserve)
//   npx hardhat run scripts/deploy-stable.ts --network amoy      (ensayo, MockStableReserve u otra)
//   npx hardhat run scripts/deploy-stable.ts --network polygon   (mainnet real, ver runbook)
//
// Variables de entorno (ver .env.example): BACKEND_ADDRESS, RESERVE_TOKEN_ADDRESS,
// CENTS_PER_RESERVE_UNIT, CONFIRM_MAINNET.
//
// Diseño para pruebas (test/deploy-stable.script.test.ts):
//   `deployStable(params)` NO lee la red desde el runtime de Hardhat: recibe `networkName`
//   y `expectedChainId` como parámetros explícitos, precisamente para que una prueba pueda
//   simular "estamos en polygon" corriendo sobre la red local de Hardhat (que siempre
//   reporta chainId 31337). Como en ese caso el chainId REAL nunca va a coincidir con el
//   137 simulado, `skipChainIdCheckForTests` (SOLO para pruebas, nunca en `main()`) salta
//   esa comparación puntual sin tocar ninguna otra validación de la función.
//
// Orden de validación (falla rápido, ninguna se salta por CONFIRM_MAINNET):
//   (a) red admitida -> (b) chainId real == esperado -> (c) token de reserva (resuelve,
//   lee symbol/decimals, en polygon exige "USDC"/6, y ademas exige que sea el USDC nativo
//   de Circle -- name() "USD Coin" y la direccion oficial de Polygon PoS -- para que no
//   pase como valido el USDC.e puenteado ni otro token no oficial, que comparten symbol y
//   decimals) -> (d) backend (en polygon obligatorio y distinto del deployer) ->
//   (e) paridad (entero > 0) -> (f) SOLO en polygon, si
//   CONFIRM_MAINNET !== "yes": imprime el resumen ya validado y NO despliega -> (g) despliega
//   y verifica roles/estado -> (h) exporta ABI + address.json (solo datos públicos) ->
//   (i) imprime el comando de verificación y el explorador.
//
// Seguridad: este script NUNCA imprime ni escribe claves privadas. Los artefactos
// exportados solo contienen direcciones y datos públicos.

import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

export const ALLOWED_NETWORKS = ["hardhat", "amoy", "polygon"] as const;
export type AllowedNetwork = (typeof ALLOWED_NETWORKS)[number];

const ERC20_METADATA_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
];

// Native USDC (Circle) on Polygon PoS mainnet -- the only reserve token accepted on
// `polygon`. Source: https://developers.circle.com/stablecoins/usdc-contract-addresses
// (Mainnet table, Polygon PoS row). Distinct from bridged USDC.e
// (0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174, name() = "USD Coin (PoS)"), which shares
// the same symbol() ("USDC") and decimals() (6), so those two checks alone cannot tell
// the two apart.
export const NATIVE_USDC_POLYGON = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";

/** Aborto esperado por una validación de configuración (red, chainId, reserva, backend, paridad). */
export class DeployAbortError extends Error {}

/** El contrato ya quedó desplegado pero una verificación post-despliegue falló. */
export class PostDeployVerificationError extends Error {
  readonly address: string;
  constructor(message: string, address: string) {
    super(message);
    this.address = address;
  }
}

export interface DeployStableParams {
  networkName: AllowedNetwork;
  /** ChainId real esperado para networkName (31337 hardhat, 80002 amoy, 137 polygon). */
  expectedChainId: bigint;
  /** SOLO pruebas: salta la comparación de chainId real vs. esperado. Nunca en main(). */
  skipChainIdCheckForTests?: boolean;
  /** Obligatorio en polygon. En amoy/hardhat, si falta, se usa el deployer. */
  backendAddress?: string;
  /** Obligatorio en polygon. En amoy/hardhat, si falta, se despliega MockStableReserve. */
  reserveTokenAddress?: string;
  /** Entero > 0. Obligatorio en polygon. En amoy/hardhat, si falta, default 360. */
  centsPerReserveUnit?: bigint;
  /** Debe ser exactamente true para desplegar de verdad en polygon. */
  confirmMainnet?: boolean;
}

interface ReserveSummary {
  reserveTokenAddress: string;
  reserveSymbol: string;
  reserveDecimals: number;
  deployedMockReserve: boolean;
}

export interface DeployStableDryRun {
  deployed: false;
  network: AllowedNetwork;
  chainId: number;
  deployer: string;
  backend: string;
  reserveToken: string;
  reserveSymbol: string;
  reserveDecimals: number;
  centsPerReserveUnit: bigint;
}

export interface DeployStableSuccess {
  deployed: true;
  network: AllowedNetwork;
  chainId: number;
  address: string;
  deployer: string;
  backend: string;
  reserveToken: string;
  reserveSymbol: string;
  reserveDecimals: number;
  centsPerReserveUnit: bigint;
  txHash: string;
}

export type DeployStableResult = DeployStableDryRun | DeployStableSuccess;

function printSummary(s: {
  network: string;
  chainId: bigint;
  deployer: string;
  backend: string;
  reserveTokenAddress: string;
  reserveSymbol: string;
  reserveDecimals: number;
  centsPerReserveUnit: bigint;
}): void {
  console.log(`  Red            : ${s.network}`);
  console.log(`  ChainId        : ${s.chainId}`);
  console.log(`  Deployer       : ${s.deployer}`);
  console.log(`  Backend        : ${s.backend}`);
  console.log(
    `  Reserva        : ${s.reserveTokenAddress} (symbol=${s.reserveSymbol}, decimals=${s.reserveDecimals})`
  );
  console.log(`  Paridad        : ${s.centsPerReserveUnit} centimos de sol por unidad de reserva`);
}

/** (c) Resuelve el token de reserva, lee symbol()/decimals() y, en polygon, exige USDC/6. */
async function resolveReserve(
  networkName: AllowedNetwork,
  reserveTokenAddress: string | undefined
): Promise<ReserveSummary> {
  let address: string;
  let deployedMockReserve = false;

  if (reserveTokenAddress) {
    address = reserveTokenAddress;
  } else if (networkName === "polygon") {
    throw new DeployAbortError("RESERVE_TOKEN_ADDRESS es obligatorio en polygon.");
  } else {
    const Mock = await ethers.getContractFactory("MockStableReserve");
    const mock = await Mock.deploy();
    await mock.waitForDeployment();
    address = await mock.getAddress();
    deployedMockReserve = true;
  }

  const reserve = await ethers.getContractAt(ERC20_METADATA_ABI, address);
  const reserveSymbol: string = await reserve.symbol();
  const reserveDecimals = Number(await reserve.decimals());

  console.log(`\nToken de reserva  : ${address}${deployedMockReserve ? " (MockStableReserve desplegado)" : ""}`);
  console.log(`  symbol()        : ${reserveSymbol}`);
  console.log(`  decimals()      : ${reserveDecimals}`);

  if (networkName === "polygon" && (reserveSymbol !== "USDC" || reserveDecimals !== 6)) {
    throw new DeployAbortError(
      `Token de reserva invalido para polygon: se esperaba symbol "USDC" y 6 decimales, ` +
        `se encontro symbol "${reserveSymbol}" y ${reserveDecimals} decimales (${address}).`
    );
  }

  if (networkName === "polygon") {
    const reserveName: string = await reserve.name();
    const addressMatches = address.toLowerCase() === NATIVE_USDC_POLYGON.toLowerCase();
    const nameMatches = reserveName === "USD Coin";
    if (!addressMatches || !nameMatches) {
      throw new DeployAbortError(
        `Token de reserva invalido para polygon: parece USDC.e (puenteado) u otro token no ` +
          `oficial, no el USDC nativo de Circle. Se esperaba la direccion ${NATIVE_USDC_POLYGON} ` +
          `con name() "USD Coin"; se encontro ${address} con name() "${reserveName}".`
      );
    }
  }

  return { reserveTokenAddress: address, reserveSymbol, reserveDecimals, deployedMockReserve };
}

/** (d) Resuelve el backend. En polygon es obligatorio y debe ser distinto del deployer. */
function resolveBackend(networkName: AllowedNetwork, backendAddress: string | undefined, deployerAddress: string): string {
  let backend: string;
  if (backendAddress) {
    backend = backendAddress;
  } else if (networkName === "polygon") {
    throw new DeployAbortError("BACKEND_ADDRESS es obligatorio en polygon.");
  } else {
    backend = deployerAddress;
  }

  if (networkName === "polygon" && backend.toLowerCase() === deployerAddress.toLowerCase()) {
    throw new DeployAbortError(
      "En polygon, backend y deployer deben ser wallets distintas (dos wallets separadas: admin y backend)."
    );
  }
  return backend;
}

/** (e) Resuelve la paridad. Obligatoria en polygon; default 360 en amoy/hardhat. */
function resolveParity(networkName: AllowedNetwork, centsPerReserveUnit: bigint | undefined): bigint {
  if (centsPerReserveUnit !== undefined) {
    if (centsPerReserveUnit <= 0n) {
      throw new DeployAbortError("CENTS_PER_RESERVE_UNIT invalido: debe ser un entero > 0.");
    }
    return centsPerReserveUnit;
  }
  if (networkName === "polygon") {
    throw new DeployAbortError("CENTS_PER_RESERVE_UNIT es obligatorio en polygon.");
  }
  return 360n;
}

export async function deployStable(params: DeployStableParams): Promise<DeployStableResult> {
  // (a) Red admitida.
  if (!ALLOWED_NETWORKS.includes(params.networkName)) {
    throw new DeployAbortError(
      `Red no soportada: "${params.networkName}". Redes admitidas: ${ALLOWED_NETWORKS.join(", ")}.`
    );
  }

  // (b) chainId real del provider contra el esperado.
  if (!params.skipChainIdCheckForTests) {
    const realNetwork = await ethers.provider.getNetwork();
    if (realNetwork.chainId !== params.expectedChainId) {
      throw new DeployAbortError(
        `ChainId incorrecto: se esperaba ${params.expectedChainId} (${params.networkName}) pero el ` +
          `provider reporta ${realNetwork.chainId}.`
      );
    }
  }

  const [deployer] = await ethers.getSigners();

  // (c) Token de reserva.
  const { reserveTokenAddress, reserveSymbol, reserveDecimals } = await resolveReserve(
    params.networkName,
    params.reserveTokenAddress
  );

  // (d) Backend.
  const backendAddress = resolveBackend(params.networkName, params.backendAddress, deployer.address);

  // (e) Paridad.
  const centsPerReserveUnit = resolveParity(params.networkName, params.centsPerReserveUnit);

  // (f) Guarda de mainnet: ensayo en seco si no viene CONFIRM_MAINNET=yes.
  if (params.networkName === "polygon" && params.confirmMainnet !== true) {
    console.log("\n=== ENSAYO EN SECO (CONFIRM_MAINNET no es 'yes'): no se desplegara nada ===");
    printSummary({
      network: params.networkName,
      chainId: params.expectedChainId,
      deployer: deployer.address,
      backend: backendAddress,
      reserveTokenAddress,
      reserveSymbol,
      reserveDecimals,
      centsPerReserveUnit,
    });
    return {
      deployed: false,
      network: params.networkName,
      chainId: Number(params.expectedChainId),
      deployer: deployer.address,
      backend: backendAddress,
      reserveToken: reserveTokenAddress,
      reserveSymbol,
      reserveDecimals,
      centsPerReserveUnit,
    };
  }

  // (g) Despliegue.
  console.log("\nDesplegando ChapaTuCriptoStable...");
  const Factory = await ethers.getContractFactory("ChapaTuCriptoStable");
  const token = await Factory.deploy(backendAddress, reserveTokenAddress, reserveDecimals, centsPerReserveUnit);
  await token.waitForDeployment();
  const address = await token.getAddress();
  const txHash = token.deploymentTransaction()?.hash ?? "";

  const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();
  const BACKEND_ROLE = await token.BACKEND_ROLE();
  const distintos = backendAddress.toLowerCase() !== deployer.address.toLowerCase();

  const checks: Array<[string, boolean]> = [
    ["hasRole(DEFAULT_ADMIN_ROLE, deployer) == true", await token.hasRole(DEFAULT_ADMIN_ROLE, deployer.address)],
    ["hasRole(BACKEND_ROLE, backend) == true", await token.hasRole(BACKEND_ROLE, backendAddress)],
    ["reserveToken() == token", (await token.reserveToken()).toLowerCase() === reserveTokenAddress.toLowerCase()],
    ["centsPerReserveUnit() == paridad", (await token.centsPerReserveUnit()) === centsPerReserveUnit],
    ["totalSupply() == 0", (await token.totalSupply()) === 0n],
  ];
  if (distintos) {
    checks.push(["hasRole(BACKEND_ROLE, deployer) == false", !(await token.hasRole(BACKEND_ROLE, deployer.address))]);
    checks.push([
      "hasRole(DEFAULT_ADMIN_ROLE, backend) == false",
      !(await token.hasRole(DEFAULT_ADMIN_ROLE, backendAddress)),
    ]);
  }

  console.log("\nVerificaciones post-despliegue:");
  const fallidas: string[] = [];
  for (const [label, ok] of checks) {
    console.log(`  [${ok ? "OK" : "FALLO"}] ${label}`);
    if (!ok) fallidas.push(label);
  }
  if (fallidas.length > 0) {
    throw new PostDeployVerificationError(
      `El contrato ya quedo desplegado en ${address} pero fallaron estas verificaciones: ${fallidas.join("; ")}.`,
      address
    );
  }

  // (h) Exportar ABI y direccion (solo datos publicos).
  const deploymentsDir = path.join(__dirname, "..", "deployments", params.networkName);
  fs.mkdirSync(deploymentsDir, { recursive: true });

  const artifactPath = path.join(
    __dirname,
    "..",
    "artifacts",
    "contracts",
    "ChapaTuCriptoStable.sol",
    "ChapaTuCriptoStable.json"
  );
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  fs.writeFileSync(
    path.join(deploymentsDir, "ChapaTuCriptoStable.json"),
    JSON.stringify({ abi: artifact.abi }, null, 2) + "\n",
    "utf8"
  );

  const addressOut = {
    address,
    backend: backendAddress,
    deployer: deployer.address,
    reserveToken: reserveTokenAddress,
    reserveSymbol,
    reserveDecimals,
    centsPerReserveUnit: centsPerReserveUnit.toString(),
    network: params.networkName,
    chainId: Number(params.expectedChainId),
    txHash,
    constructorArgs: [backendAddress, reserveTokenAddress, reserveDecimals, centsPerReserveUnit.toString()],
  };
  fs.writeFileSync(
    path.join(deploymentsDir, "address.json"),
    JSON.stringify(addressOut, null, 2) + "\n",
    "utf8"
  );

  console.log(`\nArtefactos exportados a: ${deploymentsDir}`);
  console.log("  - ChapaTuCriptoStable.json (ABI)");
  console.log("  - address.json");

  // (i) Comando de verificacion y explorador (no aplica a la red local de Hardhat).
  if (params.networkName !== "hardhat") {
    const explorer = params.networkName === "polygon" ? "https://polygonscan.com" : "https://amoy.polygonscan.com";
    console.log("\n=== Verificacion (paso manual) ===");
    console.log(
      `npx hardhat verify --network ${params.networkName} ${address} ${backendAddress} ${reserveTokenAddress} ${reserveDecimals} ${centsPerReserveUnit}`
    );
    console.log(`Explorer: ${explorer}/address/${address}`);
  }

  return {
    deployed: true,
    network: params.networkName,
    chainId: Number(params.expectedChainId),
    address,
    deployer: deployer.address,
    backend: backendAddress,
    reserveToken: reserveTokenAddress,
    reserveSymbol,
    reserveDecimals,
    centsPerReserveUnit,
    txHash,
  };
}

const NETWORK_CHAIN_IDS: Record<AllowedNetwork, bigint> = {
  hardhat: 31337n,
  amoy: 80002n,
  polygon: 137n,
};

async function main(): Promise<void> {
  const networkName = network.name as AllowedNetwork;
  if (!ALLOWED_NETWORKS.includes(networkName)) {
    console.error(`Red no soportada: "${network.name}". Redes admitidas: ${ALLOWED_NETWORKS.join(", ")}.`);
    process.exitCode = 1;
    return;
  }

  console.log("=== Despliegue ChapaTuCriptoStable (CTC con paridad) ===");

  const centsEnv = process.env.CENTS_PER_RESERVE_UNIT;
  const result = await deployStable({
    networkName,
    expectedChainId: NETWORK_CHAIN_IDS[networkName],
    backendAddress: process.env.BACKEND_ADDRESS,
    reserveTokenAddress: process.env.RESERVE_TOKEN_ADDRESS,
    centsPerReserveUnit: centsEnv ? BigInt(centsEnv) : undefined,
    confirmMainnet: process.env.CONFIRM_MAINNET === "yes",
  });

  if (!result.deployed) {
    console.log("\nEnsayo en seco completado. Vuelve a ejecutar con CONFIRM_MAINNET=yes para desplegar de verdad.");
    process.exitCode = 1;
    return;
  }

  console.log(`\nContrato desplegado en: ${result.address}`);
  console.log(`Tx de despliegue      : ${result.txHash}`);
}

main().catch((error) => {
  console.error("\nError en el despliegue:");
  console.error(error);
  process.exitCode = 1;
});
