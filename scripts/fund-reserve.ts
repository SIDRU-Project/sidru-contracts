// Fondea la reserva de ChapaTuCriptoStable en la red indicada.
//
//   RESERVE_UNITS=1000 npx hardhat run scripts/fund-reserve.ts --network amoy
//
// Lee deployments/<red>/address.json. Si el token de reserva expone mint() (es el mock de
// pruebas), acuna primero las unidades al deployer; en mainnet (USDC real) NO se puede
// acunar: el USDC debe estar ya en la wallet admin (ver runbook-mainnet.md, paso 5).
// Nunca imprime claves.
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main(): Promise<void> {
  const units = BigInt(process.env.RESERVE_UNITS ?? "1000"); // unidades enteras (1 = 1 USDC)
  const file = path.join(__dirname, "..", "deployments", network.name, "address.json");
  const info = JSON.parse(fs.readFileSync(file, "utf8"));
  const [signer] = await ethers.getSigners();
  const decimals: number = info.reserveDecimals;
  const raw = units * 10n ** BigInt(decimals);

  const reserve = await ethers.getContractAt("MockStableReserve", info.reserveToken, signer);
  const token = await ethers.getContractAt("ChapaTuCriptoStable", info.address, signer);

  console.log(`Red ${network.name} · contrato ${info.address} · reserva ${info.reserveToken}`);
  console.log(`Fondeo solicitado: ${units} unidades (${raw} raw, ${decimals} decimales)`);

  if (network.name !== "polygon") {
    console.log("Acunando unidades en el mock de reserva...");
    await (await reserve.mint(signer.address, raw)).wait();
  }
  console.log("approve...");
  await (await reserve.approve(info.address, raw)).wait();
  console.log("fundReserve...");
  const tx = await token.fundReserve(raw);
  const rc = await tx.wait();
  console.log(`fundReserve minado: ${rc?.hash}`);

  const balance = await token.reserveBalance();
  const capacity = await token.reserveCapacity();
  console.log(`reserveBalance()  = ${balance} raw`);
  console.log(`reserveCapacity() = ${ethers.formatEther(capacity)} CTC (= S/ ${(Number(ethers.formatEther(capacity)) / 100).toFixed(2)})`);
}

main().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; });
