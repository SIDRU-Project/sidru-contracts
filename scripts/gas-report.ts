// Medicion de gas de cada operacion de los contratos, en la red local de Hardhat.
//
// Es la base del modelo de costos del piloto (docs/publicacion/costos-piloto.md):
// el gas consumido por operacion es un dato del bytecode, identico en la red local y en
// mainnet, asi que medirlo aqui da cifras reales sin gastar POL. Lo que si cambia entre
// redes es el PRECIO del gas (gwei) y el precio de POL, que son parametros del modelo.
//
// Uso:
//   npx hardhat run scripts/gas-report.ts
//
// Imprime una tabla con el gas por operacion y deja scripts/gas-report.json para que el
// modelo de costos lo consuma. No toca ninguna red externa.

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

const CENTS_PER_RESERVE_UNIT = 360n; // 1 USDC = S/ 3.60 (parametro de ejemplo)
const RESERVE_DECIMALS = 6;
const ONE_USDC = 10n ** 6n;
const CTC = 10n ** 18n;

type Row = { contrato: string; operacion: string; gas: bigint; nota: string };

async function main(): Promise<void> {
  const [deployer, backend, ciudadano, otro] = await ethers.getSigners();
  const rows: Row[] = [];
  const add = (contrato: string, operacion: string, gas: bigint, nota = "") =>
    rows.push({ contrato, operacion, gas, nota });

  // ------------------------------------------------------------ Stable (paridad)
  const Reserve = await ethers.getContractFactory("MockStableReserve");
  const reserve = await Reserve.deploy();
  await reserve.waitForDeployment();

  const Stable = await ethers.getContractFactory("ChapaTuCriptoStable");
  const stable = await Stable.deploy(
    backend.address,
    await reserve.getAddress(),
    RESERVE_DECIMALS,
    CENTS_PER_RESERVE_UNIT,
  );
  const stableDeploy = await stable.deploymentTransaction()!.wait();
  add("ChapaTuCriptoStable", "deploy", stableDeploy!.gasUsed, "una sola vez");

  // Fondear la reserva con 1000 USDC (respalda 360 000 CTC = S/ 3 600).
  const fondeo = 1000n * ONE_USDC;
  await (await reserve.mint(deployer.address, fondeo)).wait();
  const approveRx = await (await reserve.approve(await stable.getAddress(), fondeo)).wait();
  add("USDC (ERC-20)", "approve", approveRx!.gasUsed, "previo a fundReserve, una vez por recarga");
  const fundRx = await (await stable.fundReserve(fondeo)).wait();
  add("ChapaTuCriptoStable", "fundReserve", fundRx!.gasUsed, "una vez por recarga de reserva");

  // Mint por sesion: 200 CTC (sesion de 500 g). Primera y segunda para ver el costo estable.
  const qrHash = ethers.keccak256(ethers.toUtf8Bytes("QR-1"));
  const mint1 = await (
    await stable.connect(backend).recordAndReward(ciudadano.address, 1n, qrHash, 200n * CTC)
  ).wait();
  add("ChapaTuCriptoStable", "recordAndReward (1er mint al usuario)", mint1!.gasUsed,
    "incluye crear el slot de balance: mas caro");
  const mint2 = await (
    await stable.connect(backend).recordAndReward(ciudadano.address, 2n, qrHash, 200n * CTC)
  ).wait();
  add("ChapaTuCriptoStable", "recordAndReward (mints siguientes)", mint2!.gasUsed, "costo en regimen");

  // Retiro de CTC a la wallet externa (withdrawTo, el backend paga el gas).
  const wd = await (
    await stable.connect(backend).withdrawTo(ciudadano.address, otro.address, 100n * CTC)
  ).wait();
  add("ChapaTuCriptoStable", "withdrawTo (CTC a MetaMask)", wd!.gasUsed, "el backend paga el gas");

  // Transferencia entre ciudadanos (la paga el ciudadano desde su wallet).
  const tr = await (await stable.connect(otro).transfer(ciudadano.address, 50n * CTC)).wait();
  add("ChapaTuCriptoStable", "transfer (entre wallets)", tr!.gasUsed, "la paga quien envia");

  // Canje a USDC: el ciudadano quema CTC y recibe USDC (redeem desde su propia wallet).
  const rd = await (await stable.connect(otro).redeem(50n * CTC)).wait();
  add("ChapaTuCriptoStable", "redeem (CTC -> USDC)", rd!.gasUsed, "la paga quien canjea");

  // Compra a la par (purchase): deposita USDC, recibe CTC.
  await (await reserve.mint(otro.address, ONE_USDC)).wait();
  await (await reserve.connect(otro).approve(await stable.getAddress(), ONE_USDC)).wait();
  const pu = await (await stable.connect(otro).purchase(ONE_USDC)).wait();
  add("ChapaTuCriptoStable", "purchase (USDC -> CTC)", pu!.gasUsed, "la paga quien compra");

  // Retiro con emision: el ciudadano retira puntos y recibe CTC directo en su wallet.
  const mw = await (
    await stable.connect(backend).mintWithdrawal(ciudadano.address, 1001n, 50n * CTC)
  ).wait();
  add("ChapaTuCriptoStable", "mintWithdrawal (retiro en CTC)", mw!.gasUsed,
    "el backend paga el gas; CTC solo existe al retirar");

  // Retiro en USDC: el ciudadano retira puntos y recibe USDC desde la reserva, a la par.
  const pr = await (
    await stable.connect(backend).payoutReserve(ciudadano.address, 1002n, 50n * CTC)
  ).wait();
  add("ChapaTuCriptoStable", "payoutReserve (retiro en USDC)", pr!.gasUsed,
    "el backend paga el gas; no mintea, paga desde el excedente de reserva");

  // ------------------------------------------------------------ Simple (sin paridad)
  const Simple = await ethers.getContractFactory("ChapaTuCripto");
  const simple = await Simple.deploy(backend.address);
  const simpleDeploy = await simple.deploymentTransaction()!.wait();
  add("ChapaTuCripto (simple)", "deploy", simpleDeploy!.gasUsed, "una sola vez");
  const sm1 = await (
    await simple.connect(backend).recordAndReward(ciudadano.address, 1n, qrHash, 200n * CTC)
  ).wait();
  add("ChapaTuCripto (simple)", "recordAndReward (1er mint)", sm1!.gasUsed);
  const sm2 = await (
    await simple.connect(backend).recordAndReward(ciudadano.address, 2n, qrHash, 200n * CTC)
  ).wait();
  add("ChapaTuCripto (simple)", "recordAndReward (siguientes)", sm2!.gasUsed);
  const swd = await (
    await simple.connect(backend).withdrawTo(ciudadano.address, otro.address, 100n * CTC)
  ).wait();
  add("ChapaTuCripto (simple)", "withdrawTo", swd!.gasUsed);

  // ------------------------------------------------------------ Transferencia nativa de POL
  const native = await (await backend.sendTransaction({ to: otro.address, value: 1n })).wait();
  add("POL nativo", "transfer (pago directo en POL)", native!.gasUsed, "referencia: 21 000 fijo");

  // ------------------------------------------------------------ Salida
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log("\nGas por operacion (unidades de gas; identicas en local y en mainnet)\n");
  console.log(pad("Contrato", 26) + pad("Operacion", 42) + pad("Gas", 10) + "Nota");
  console.log("-".repeat(110));
  for (const r of rows) {
    console.log(pad(r.contrato, 26) + pad(r.operacion, 42) + pad(r.gas.toString(), 10) + r.nota);
  }

  const out = rows.map((r) => ({ ...r, gas: Number(r.gas) }));
  const file = path.join(__dirname, "gas-report.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`\nGuardado en ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
