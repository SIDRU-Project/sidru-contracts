// Script de despliegue de ChapaTuCripto (CTC) en Polygon Amoy.
//
// Uso:
//   npx hardhat run scripts/deploy.ts --network amoy
//
// Seguridad: este script NUNCA imprime ni escribe claves privadas. La clave del
// deployer se referencia solo a traves de la cuenta configurada en hardhat.config.ts
// (DEPLOYER_PRIVATE_KEY del .env). En los artefactos exportados solo se guardan
// direcciones publicas.

import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// Parametros esperados de la red de destino (Polygon Amoy).
const EXPECTED_NETWORK = "amoy";
const EXPECTED_CHAIN_ID = 80002n;

async function main(): Promise<void> {
  // 1. Obtener el deployer. En el MVP, deployer == backend (misma wallet del .env).
  const [deployer] = await ethers.getSigners();
  const backendAddress = deployer.address;

  // 2. Leer el chainId real desde el provider (no confiar solo en network.name).
  const realNetwork = await ethers.provider.getNetwork();
  const realChainId = realNetwork.chainId;

  // 3. Log de pre-despliegue (antes de gastar gas).
  console.log("=== Despliegue ChapaTuCripto (CTC) ===");
  console.log(`Red (hardhat)   : ${network.name}`);
  console.log(`ChainId (real)  : ${realChainId}`);
  console.log(`Deployer        : ${deployer.address}`);
  console.log(`Backend (arg)   : ${backendAddress}`);

  // 4. Guard de seguridad: abortar si no estamos en amoy / 80002.
  //    Evita desplegar en otra red por accidente.
  if (network.name !== EXPECTED_NETWORK) {
    throw new Error(
      `Red incorrecta: se esperaba "${EXPECTED_NETWORK}" pero hardhat reporta "${network.name}". ` +
        `Ejecuta con: npx hardhat run scripts/deploy.ts --network ${EXPECTED_NETWORK}`
    );
  }
  if (realChainId !== EXPECTED_CHAIN_ID) {
    throw new Error(
      `ChainId incorrecto: se esperaba ${EXPECTED_CHAIN_ID} (Polygon Amoy) pero el provider reporta ${realChainId}. ` +
        `Revisa AMOY_RPC_URL en .env.`
    );
  }

  // 5. Desplegar el contrato con el constructor arg = direccion del deployer (backend).
  console.log("\nDesplegando contrato...");
  const Factory = await ethers.getContractFactory("ChapaTuCripto");
  const token = await Factory.deploy(backendAddress);
  await token.waitForDeployment();

  // 6. Recuperar direccion desplegada y txHash del deploy.
  const address = await token.getAddress();
  const txHash = token.deploymentTransaction()?.hash ?? "";

  console.log(`\nContrato desplegado en: ${address}`);
  console.log(`Tx de despliegue      : ${txHash}`);

  // 7. Exportar artefactos a deployments/amoy/.
  const deploymentsDir = path.join(__dirname, "..", "deployments", "amoy");
  fs.mkdirSync(deploymentsDir, { recursive: true });

  // 7a. ABI: leido del artifact compilado por Hardhat.
  const artifactPath = path.join(
    __dirname,
    "..",
    "artifacts",
    "contracts",
    "ChapaTuCripto.sol",
    "ChapaTuCripto.json"
  );
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const abiOut = { abi: artifact.abi };
  fs.writeFileSync(
    path.join(deploymentsDir, "ChapaTuCripto.json"),
    JSON.stringify(abiOut, null, 2) + "\n",
    "utf8"
  );

  // 7b. address.json: metadatos de despliegue (solo direcciones publicas).
  const addressOut = {
    address,
    backend: backendAddress,
    deployer: deployer.address,
    network: "polygon-amoy",
    chainId: 80002,
    txHash,
    constructorArgs: [backendAddress],
  };
  fs.writeFileSync(
    path.join(deploymentsDir, "address.json"),
    JSON.stringify(addressOut, null, 2) + "\n",
    "utf8"
  );

  console.log(`\nArtefactos exportados a: ${deploymentsDir}`);
  console.log("  - ChapaTuCripto.json (ABI)");
  console.log("  - address.json");

  // 8. Comando de verificacion listo para copiar/pegar (verify se corre aparte).
  console.log("\n=== Verificacion (paso manual) ===");
  console.log(`npx hardhat verify --network amoy ${address} ${backendAddress}`);
  console.log(`\nExplorer: https://amoy.polygonscan.com/address/${address}`);
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error("\nError en el despliegue:");
    console.error(error);
    process.exitCode = 1;
  });
