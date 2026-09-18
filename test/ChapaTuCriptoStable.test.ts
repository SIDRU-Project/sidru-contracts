// Pruebas de la paridad dura 100 CTC = S/ 1.00 con token transferible.
//
// La paridad se defiende con una ventanilla de canje a la par en las dos direcciones
// (purchase = techo, redeem = piso) contra una reserva totalmente respaldada.

import { expect } from "chai";
import { ethers } from "hardhat";
import { ChapaTuCriptoStable, MockStableReserve } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// 1 unidad de reserva (1 mUSD) = 337 céntimos de sol = S/ 3.37.
const CENTS_PER_RESERVE_UNIT = 337n;
const RESERVE_DECIMALS = 6;
const ONE_RESERVE = 10n ** BigInt(RESERVE_DECIMALS); // 1.000000 mUSD
const CTC = 10n ** 18n; // 1 CTC = 1 céntimo de sol

describe("ChapaTuCriptoStable — paridad dura 100 CTC = S/ 1.00", () => {
  let token: ChapaTuCriptoStable;
  let reserve: MockStableReserve;
  let deployer: HardhatEthersSigner;
  let backend: HardhatEthersSigner;
  let ciudadano: HardhatEthersSigner;
  let tercero: HardhatEthersSigner;

  beforeEach(async () => {
    [deployer, backend, ciudadano, tercero] = await ethers.getSigners();

    const Reserve = await ethers.getContractFactory("MockStableReserve");
    reserve = await Reserve.deploy();
    await reserve.waitForDeployment();

    const Token = await ethers.getContractFactory("ChapaTuCriptoStable");
    token = await Token.deploy(
      backend.address,
      await reserve.getAddress(),
      RESERVE_DECIMALS,
      CENTS_PER_RESERVE_UNIT
    );
    await token.waitForDeployment();
  });

  /** Fondea la reserva de SIDRU sin mintear CTC. */
  async function fondear(unidades: bigint) {
    await reserve.mint(deployer.address, unidades);
    await reserve.connect(deployer).approve(await token.getAddress(), unidades);
    await token.connect(deployer).fundReserve(unidades);
  }

  it("1. la paridad es exacta: 1 mUSD (S/ 3.37) respalda 337 CTC", async () => {
    expect(await token.ctcForReserve(ONE_RESERVE)).to.equal(337n * CTC);
    // Y 100 CTC = S/ 1.00 valen 1/3.37 mUSD = 0.296735 (redondeado hacia abajo).
    expect(await token.reserveForCtc(100n * CTC)).to.equal(296_735n);
  });

  it("2. sin reserva, recordAndReward revierte: es imposible emitir CTC sin respaldo", async () => {
    await expect(
      token.connect(backend).recordAndReward(ciudadano.address, 1n, ethers.ZeroHash, 280n * CTC)
    ).to.be.revertedWithCustomError(token, "InsufficientReserve");
  });

  it("3. con la reserva fondeada, la recompensa por reciclaje se mintea", async () => {
    await fondear(ONE_RESERVE); // respalda hasta 337 CTC
    await token.connect(backend).recordAndReward(
      ciudadano.address, 1n, ethers.ZeroHash, 280n * CTC
    );
    expect(await token.balanceOf(ciudadano.address)).to.equal(280n * CTC);
    // 280 CTC = S/ 2.80 y la reserva sigue cubriendo el 100%.
    expect(await token.collateralizationBps()).to.be.greaterThanOrEqual(10000n);
  });

  it("4. PISO: cualquiera puede quemar 100 CTC y recibir S/ 1.00 de reserva", async () => {
    await fondear(ONE_RESERVE);
    await token.connect(backend).recordAndReward(
      ciudadano.address, 1n, ethers.ZeroHash, 300n * CTC
    );

    const antes = await reserve.balanceOf(ciudadano.address);
    await token.connect(ciudadano).redeem(100n * CTC);
    const recibido = (await reserve.balanceOf(ciudadano.address)) - antes;

    // 296735 unidades = 0.296735 mUSD x S/ 3.37 = S/ 1.0000 (a 4 decimales).
    expect(recibido).to.equal(296_735n);
    const solesRecibidos = (recibido * CENTS_PER_RESERVE_UNIT) / ONE_RESERVE; // en céntimos
    expect(solesRecibidos).to.equal(99n); // 99.99 céntimos por redondeo a la baja
    expect(await token.balanceOf(ciudadano.address)).to.equal(200n * CTC);
  });

  it("5. TECHO: cualquiera puede depositar S/ 1.00 y recibir 100 CTC", async () => {
    const pago = 296_736n; // ~S/ 1.00 en reserva
    await reserve.mint(tercero.address, pago);
    await reserve.connect(tercero).approve(await token.getAddress(), pago);

    await token.connect(tercero).purchase(pago);

    // Recibe ~100 CTC: nadie pagaria mas de la par en un mercado pudiendo comprar aqui.
    const recibido = await token.balanceOf(tercero.address);
    expect(recibido).to.be.greaterThanOrEqual(100n * CTC);
    expect(recibido).to.be.lessThan(101n * CTC);
  });

  it("6. el token es LIBREMENTE TRANSFERIBLE entre ciudadanos", async () => {
    await fondear(ONE_RESERVE);
    await token.connect(backend).recordAndReward(
      ciudadano.address, 1n, ethers.ZeroHash, 300n * CTC
    );

    await token.connect(ciudadano).transfer(tercero.address, 120n * CTC);

    expect(await token.balanceOf(tercero.address)).to.equal(120n * CTC);
    expect(await token.balanceOf(ciudadano.address)).to.equal(180n * CTC);

    // Y quien lo recibe puede canjearlo a la par: el piso vale para cualquiera.
    await expect(token.connect(tercero).redeem(120n * CTC)).to.not.be.reverted;
  });

  it("7. la reserva completa es un invariante: el admin no puede retirar de mas", async () => {
    await fondear(ONE_RESERVE);
    await token.connect(backend).recordAndReward(
      ciudadano.address, 1n, ethers.ZeroHash, 337n * CTC
    );

    // Todo el respaldo esta comprometido: no hay excedente que retirar.
    await expect(
      token.connect(deployer).withdrawExcessReserve(deployer.address, 1n)
    ).to.be.revertedWithCustomError(token, "WouldBreakFullReserve");
  });

  it("8. el canje del catalogo libera reserva y SIDRU recupera el excedente", async () => {
    await fondear(ONE_RESERVE);
    await token.connect(backend).recordAndReward(
      ciudadano.address, 1n, ethers.ZeroHash, 337n * CTC
    );

    // El ciudadano canjea un cupon de S/ 1.00 (100 CTC): se queman, la reserva se libera.
    await token.connect(backend).redeemFrom(ciudadano.address, 100n * CTC, 7n);

    const excedente = (await token.reserveBalance()) - (await token.requiredReserve());
    expect(excedente).to.be.greaterThan(0n);

    await expect(
      token.connect(deployer).withdrawExcessReserve(deployer.address, excedente)
    ).to.not.be.reverted;

    // Sigue totalmente respaldado tras retirar el excedente.
    expect(await token.collateralizationBps()).to.be.greaterThanOrEqual(10000n);
  });

  it("9. tras cualquier secuencia de operaciones, el respaldo nunca baja del 100%", async () => {
    await fondear(3n * ONE_RESERVE);
    await token.connect(backend).recordAndReward(
      ciudadano.address, 1n, ethers.ZeroHash, 400n * CTC
    );
    await token.connect(ciudadano).transfer(tercero.address, 150n * CTC);
    await token.connect(tercero).redeem(150n * CTC);
    await token.connect(backend).redeemFrom(ciudadano.address, 50n * CTC, 1n);
    await token.connect(backend).recordAndReward(
      ciudadano.address, 2n, ethers.ZeroHash, 200n * CTC
    );

    expect(await token.collateralizationBps()).to.be.greaterThanOrEqual(10000n);
    expect(await token.reserveBalance()).to.be.greaterThanOrEqual(await token.requiredReserve());
  });
});
