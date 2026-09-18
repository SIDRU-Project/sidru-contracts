// Pruebas de scripts/deploy-stable.ts, llamando a deployStable(params) directamente
// (sin pasar por `npx hardhat run`), sobre la red local de Hardhat.
//
// deployStable() no lee la red del runtime de Hardhat: recibe `networkName` y
// `expectedChainId` como parámetros explícitos (ver el encabezado de deploy-stable.ts).
// Eso es lo que nos permite simular "estamos en polygon" corriendo sobre la red local
// (que siempre reporta chainId 31337): pasamos networkName:"polygon", expectedChainId:137n
// y `skipChainIdCheckForTests: true` para saltar SOLO la comparación de chainId real vs.
// esperado (la única validación que no tiene sentido fuera de una red real). Ninguna otra
// validación (red admitida, token de reserva, backend, paridad, guarda de mainnet) se salta.
//
// Los tres escenarios "polygon" usan MockConfigurableReserve (contracts/mocks/), un mock
// nuevo agregado solo para este archivo: con symbol "USDC" y 6 decimales sirve como reserva
// válida para aislar la guarda de CONFIRM_MAINNET y la de backend==deployer; con 18
// decimales sirve para probar el aborto por decimales inválidos.

import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
  deployStable,
  DeployAbortError,
  DeployStableSuccess,
} from "../scripts/deploy-stable";

describe("scripts/deploy-stable.ts — deployStable(params)", () => {
  let deployer: HardhatEthersSigner;
  let backend: HardhatEthersSigner;

  beforeEach(async () => {
    [deployer, backend] = await ethers.getSigners();
  });

  async function deployUsdcMock(decimals: number) {
    const Mock = await ethers.getContractFactory("MockConfigurableReserve");
    const mock = await Mock.deploy("USDC", decimals);
    await mock.waitForDeployment();
    return await mock.getAddress();
  }

  it("camino feliz en hardhat con MockStableReserve: address, roles correctos, totalSupply 0, paridad correcta", async () => {
    const result = await deployStable({
      networkName: "hardhat",
      expectedChainId: 31337n,
    });

    expect(result.deployed).to.equal(true);
    const ok = result as DeployStableSuccess;

    expect(ok.address).to.match(/^0x[0-9a-fA-F]{40}$/);
    expect(ok.backend).to.equal(deployer.address); // sin BACKEND_ADDRESS, usa el deployer
    expect(ok.centsPerReserveUnit).to.equal(360n); // default en hardhat/amoy
    expect(ok.reserveSymbol).to.equal("mUSD"); // MockStableReserve desplegado por el script

    const token = await ethers.getContractAt("ChapaTuCriptoStable", ok.address);
    expect(await token.totalSupply()).to.equal(0n);
    const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();
    const BACKEND_ROLE = await token.BACKEND_ROLE();
    expect(await token.hasRole(DEFAULT_ADMIN_ROLE, deployer.address)).to.equal(true);
    expect(await token.hasRole(BACKEND_ROLE, deployer.address)).to.equal(true);
  });

  it("aborta si decimals != 6 cuando se le indica que la red es polygon", async () => {
    const badReserve = await deployUsdcMock(18);

    let error: unknown;
    try {
      await deployStable({
        networkName: "polygon",
        expectedChainId: 137n,
        skipChainIdCheckForTests: true,
        reserveTokenAddress: badReserve,
        backendAddress: backend.address,
        centsPerReserveUnit: 360n,
        confirmMainnet: true,
      });
    } catch (e) {
      error = e;
    }

    expect(error).to.be.instanceOf(DeployAbortError);
    expect((error as Error).message).to.match(/decimales/);
  });

  it("aborta en polygon sin CONFIRM_MAINNET=yes sin desplegar nada", async () => {
    const goodReserve = await deployUsdcMock(6);

    const result = await deployStable({
      networkName: "polygon",
      expectedChainId: 137n,
      skipChainIdCheckForTests: true,
      reserveTokenAddress: goodReserve,
      backendAddress: backend.address,
      centsPerReserveUnit: 360n,
      // confirmMainnet ausente => el default es "no confirmado".
    });

    expect(result.deployed).to.equal(false);
    expect("address" in result).to.equal(false);
    if (!result.deployed) {
      expect(result.network).to.equal("polygon");
      expect(result.backend).to.equal(backend.address);
      expect(result.reserveSymbol).to.equal("USDC");
      expect(result.reserveDecimals).to.equal(6);
    }
  });

  it("aborta en polygon si backend == deployer", async () => {
    const goodReserve = await deployUsdcMock(6);

    let error: unknown;
    try {
      await deployStable({
        networkName: "polygon",
        expectedChainId: 137n,
        skipChainIdCheckForTests: true,
        reserveTokenAddress: goodReserve,
        backendAddress: deployer.address, // igual al deployer: invalido en polygon
        centsPerReserveUnit: 360n,
        confirmMainnet: true,
      });
    } catch (e) {
      error = e;
    }

    expect(error).to.be.instanceOf(DeployAbortError);
    expect((error as Error).message).to.match(/distintas/);
  });
});
