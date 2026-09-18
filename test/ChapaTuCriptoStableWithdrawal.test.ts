// Pruebas del retiro: CTC solo existe cuando el ciudadano retira puntos (mintWithdrawal),
// o se le paga en USDC desde la reserva a la par (payoutReserve). También cubre la
// actualización de paridad (setCentsPerReserveUnit) y las invariantes I1/I2 bajo fuzzing.

import { expect } from "chai";
import { ethers } from "hardhat";
import { ChapaTuCriptoStable, MockStableReserve } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const CENTS_PER_RESERVE_UNIT = 337n; // 1 mUSD = S/ 3.37
const RESERVE_DECIMALS = 6;
const ONE_RESERVE = 10n ** BigInt(RESERVE_DECIMALS);
const CTC = 10n ** 18n;

describe("ChapaTuCriptoStable — retiro (mintWithdrawal / payoutReserve / paridad)", () => {
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

  it("1. mintWithdrawal desde BACKEND_ROLE acredita el monto exacto y emite WithdrawalMinted", async () => {
    await fondear(ONE_RESERVE); // respalda hasta 337 CTC

    await expect(token.connect(backend).mintWithdrawal(ciudadano.address, 1n, 300n * CTC))
      .to.emit(token, "WithdrawalMinted")
      .withArgs(ciudadano.address, 1n, 300n * CTC);

    expect(await token.balanceOf(ciudadano.address)).to.equal(300n * CTC);
    expect(await token.withdrawalProcessed(1n)).to.equal(true);
  });

  it("2. mintWithdrawal con el mismo id revierte con WithdrawalAlreadyProcessed y el saldo no cambia", async () => {
    await fondear(ONE_RESERVE);
    await token.connect(backend).mintWithdrawal(ciudadano.address, 1n, 100n * CTC);
    const saldoAntes = await token.balanceOf(ciudadano.address);

    await expect(token.connect(backend).mintWithdrawal(ciudadano.address, 1n, 100n * CTC))
      .to.be.revertedWithCustomError(token, "WithdrawalAlreadyProcessed")
      .withArgs(1n);

    expect(await token.balanceOf(ciudadano.address)).to.equal(saldoAntes);
  });

  it("3. mintWithdrawal sin reserva suficiente revierte con InsufficientReserve", async () => {
    await fondear(ONE_RESERVE); // respalda hasta 337 CTC

    await expect(
      token.connect(backend).mintWithdrawal(ciudadano.address, 1n, 400n * CTC)
    ).to.be.revertedWithCustomError(token, "InsufficientReserve");
  });

  it("4. mintWithdrawal desde una cuenta sin rol revierte (AccessControlUnauthorizedAccount)", async () => {
    await fondear(ONE_RESERVE);

    await expect(
      token.connect(tercero).mintWithdrawal(ciudadano.address, 1n, 100n * CTC)
    ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
  });

  it("5. payoutReserve transfiere reserveForCtc(amount) USDC al destino, emite ReservePaidOut y no cambia totalSupply", async () => {
    await fondear(3n * ONE_RESERVE); // deja excedente sobre lo circulante
    await token.connect(backend).mintWithdrawal(ciudadano.address, 1n, 300n * CTC);
    const supplyAntes = await token.totalSupply();
    const esperado = await token.reserveForCtc(200n * CTC);

    await expect(token.connect(backend).payoutReserve(tercero.address, 2n, 200n * CTC))
      .to.emit(token, "ReservePaidOut")
      .withArgs(tercero.address, 2n, 200n * CTC, esperado);

    expect(await reserve.balanceOf(tercero.address)).to.equal(esperado);
    expect(await token.totalSupply()).to.equal(supplyAntes);
    expect(await token.withdrawalProcessed(2n)).to.equal(true);
  });

  it("6. payoutReserve no puede tocar el respaldo de los CTC en circulación (I2)", async () => {
    await fondear(ONE_RESERVE); // reserva exacta para lo que se va a mintear
    await token.connect(backend).mintWithdrawal(ciudadano.address, 1n, 337n * CTC);
    // Sin excedente: cualquier payoutReserve tocaría el respaldo circulante.
    await expect(
      token.connect(backend).payoutReserve(tercero.address, 2n, 1n * CTC)
    ).to.be.revertedWithCustomError(token, "InsufficientReserve");

    expect(await token.reserveBalance()).to.be.greaterThanOrEqual(await token.requiredReserve());
  });

  it("7. payoutReserve y mintWithdrawal comparten idempotencia: procesar un id por una vía bloquea la otra", async () => {
    await fondear(3n * ONE_RESERVE);

    await token.connect(backend).mintWithdrawal(ciudadano.address, 5n, 100n * CTC);
    await expect(
      token.connect(backend).payoutReserve(tercero.address, 5n, 50n * CTC)
    ).to.be.revertedWithCustomError(token, "WithdrawalAlreadyProcessed").withArgs(5n);

    await token.connect(backend).payoutReserve(tercero.address, 6n, 50n * CTC);
    await expect(
      token.connect(backend).mintWithdrawal(ciudadano.address, 6n, 50n * CTC)
    ).to.be.revertedWithCustomError(token, "WithdrawalAlreadyProcessed").withArgs(6n);
  });

  it("8. setCentsPerReserveUnit válido cambia la paridad y emite ParityUpdated", async () => {
    await expect(token.connect(deployer).setCentsPerReserveUnit(360n))
      .to.emit(token, "ParityUpdated")
      .withArgs(CENTS_PER_RESERVE_UNIT, 360n);

    expect(await token.centsPerReserveUnit()).to.equal(360n);
  });

  it("9. setCentsPerReserveUnit que descolateralizaría revierte con ParityWouldUnderCollateralize", async () => {
    await fondear(ONE_RESERVE); // respalda exactamente 337 CTC a la paridad actual
    await token.connect(backend).mintWithdrawal(ciudadano.address, 1n, 337n * CTC);

    // Bajar la paridad reduce cuanto respalda la misma reserva: 1 mUSD pasaría a
    // respaldar solo 100 CTC, menos que los 337 ya en circulación.
    await expect(
      token.connect(deployer).setCentsPerReserveUnit(100n)
    ).to.be.revertedWithCustomError(token, "ParityWouldUnderCollateralize");

    expect(await token.centsPerReserveUnit()).to.equal(CENTS_PER_RESERVE_UNIT);
  });

  it("10. setCentsPerReserveUnit desde BACKEND_ROLE revierte", async () => {
    await expect(
      token.connect(backend).setCentsPerReserveUnit(360n)
    ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
  });

  it("11. Propiedad: 200 operaciones aleatorias entre mint/payout/purchase/redeem/fund/parity mantienen I1 e I2", async () => {
    // Fuzz sencillo sembrado (LCG) para que la corrida sea reproducible.
    let seed = 424242n;
    const MOD = 2n ** 32n;
    function rand(): bigint {
      seed = (seed * 1103515245n + 12345n) % MOD;
      return seed;
    }
    function randInt(max: number): number {
      return Number(rand() % BigInt(max));
    }

    await fondear(50n * ONE_RESERVE);

    let nextId = 100n;
    const actors = [ciudadano, tercero];

    for (let i = 0; i < 200; i++) {
      const op = randInt(6);
      try {
        if (op === 0) {
          // mintWithdrawal
          const monto = BigInt(1 + randInt(50)) * CTC;
          const to = actors[randInt(actors.length)].address;
          await token.connect(backend).mintWithdrawal(to, nextId++, monto);
        } else if (op === 1) {
          // payoutReserve
          const monto = BigInt(1 + randInt(50)) * CTC;
          const to = actors[randInt(actors.length)].address;
          await token.connect(backend).payoutReserve(to, nextId++, monto);
        } else if (op === 2) {
          // purchase
          const actor = actors[randInt(actors.length)];
          const pago = BigInt(1 + randInt(5)) * ONE_RESERVE;
          await reserve.mint(actor.address, pago);
          await reserve.connect(actor).approve(await token.getAddress(), pago);
          await token.connect(actor).purchase(pago);
        } else if (op === 3) {
          // redeem
          const actor = actors[randInt(actors.length)];
          const saldo = await token.balanceOf(actor.address);
          if (saldo > 0n) {
            const monto = saldo / BigInt(1 + randInt(4)) + 1n;
            const aQuemar = monto > saldo ? saldo : monto;
            await token.connect(actor).redeem(aQuemar);
          }
        } else if (op === 4) {
          // fundReserve
          const monto = BigInt(1 + randInt(5)) * ONE_RESERVE;
          await fondear(monto);
        } else {
          // setCentsPerReserveUnit
          const nuevaParidad = BigInt(200 + randInt(400));
          await token.connect(deployer).setCentsPerReserveUnit(nuevaParidad);
        }
      } catch {
        // Un revert esperado (reserva insuficiente, descolateralización, etc.) no rompe
        // el fuzz: lo que importa es que las invariantes se sostengan tras cada intento,
        // exitoso o no.
      }

      expect(await token.totalSupply()).to.be.lessThanOrEqual(await token.reserveCapacity());
      expect(await token.reserveBalance()).to.be.greaterThanOrEqual(await token.requiredReserve());
    }
  });

  it("12. Gas: mintWithdrawal y payoutReserve quedan registrados en scripts/gas-report.ts", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const contenido = fs.readFileSync(
      path.join(__dirname, "..", "scripts", "gas-report.ts"),
      "utf8"
    );
    expect(contenido).to.include("mintWithdrawal");
    expect(contenido).to.include("payoutReserve");
  });

  // No exigidas explícitamente por contract-spec.md §6, pero cubren las ramas require()
  // propias del código nuevo de esta fase (gate de cobertura de tasks.md Fase 1).
  describe("Guardas de entrada de las funciones nuevas", () => {
    it("mintWithdrawal a address(0) revierte con 'invalid recipient'", async () => {
      await fondear(ONE_RESERVE);
      await expect(
        token.connect(backend).mintWithdrawal(ethers.ZeroAddress, 50n, 100n * CTC)
      ).to.be.revertedWith("invalid recipient");
    });

    it("mintWithdrawal con amount 0 revierte con 'zero amount'", async () => {
      await fondear(ONE_RESERVE);
      await expect(
        token.connect(backend).mintWithdrawal(ciudadano.address, 51n, 0n)
      ).to.be.revertedWith("zero amount");
    });

    it("payoutReserve desde una cuenta sin rol revierte (AccessControlUnauthorizedAccount)", async () => {
      await fondear(ONE_RESERVE);
      await expect(
        token.connect(tercero).payoutReserve(ciudadano.address, 52n, 100n * CTC)
      ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });

    it("payoutReserve a address(0) revierte con 'invalid recipient'", async () => {
      await fondear(ONE_RESERVE);
      await expect(
        token.connect(backend).payoutReserve(ethers.ZeroAddress, 53n, 100n * CTC)
      ).to.be.revertedWith("invalid recipient");
    });

    it("payoutReserve con ctcAmount 0 revierte con 'zero amount'", async () => {
      await fondear(ONE_RESERVE);
      await expect(
        token.connect(backend).payoutReserve(ciudadano.address, 54n, 0n)
      ).to.be.revertedWith("zero amount");
    });

    it("payoutReserve con un monto que redondea a 0 reserva revierte con 'amount below reserve precision'", async () => {
      await fondear(ONE_RESERVE);
      await expect(
        token.connect(backend).payoutReserve(ciudadano.address, 55n, 1n)
      ).to.be.revertedWith("amount below reserve precision");
    });

    it("setCentsPerReserveUnit con newCents 0 revierte con 'invalid parity'", async () => {
      await expect(
        token.connect(deployer).setCentsPerReserveUnit(0n)
      ).to.be.revertedWith("invalid parity");
    });
  });
});
