import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { ChapaTuCripto } from "../typechain-types";

/**
 * Casos de prueba del plan (TP202610003_CP.xlsx) que se verifican on-chain.
 *
 *  - CP018 (US-21/US-14, esc. 1) — Emision de tokens tras la validacion de la sesion: el mint
 *    llega a la direccion custodial del ciudadano y deja los eventos que el backend escucha.
 *  - CP029 (US-17, esc. 1) — Generacion de un codigo QR unico: la unicidad se sostiene tambien
 *    en la cadena, que rechaza un segundo registro del mismo sessionId (anti doble canje).
 *  - CP039 (US-05, esc. 1) — Ejecucion de la suite en el entorno de pruebas local de Hardhat.
 *
 * Corre sobre la red local de Hardhat: no toca Amoy ni consume POL. El despliegue real en
 * testnet y su verificacion en Polygonscan son el CP030 (manual).
 */
describe("CP018/CP029/CP039 — reglas on-chain del plan de pruebas", () => {
  const QR_HASH = ethers.keccak256(ethers.toUtf8Bytes("QR-SESION-CP"));
  const SESSION_ID = 5001n;
  // 200 puntos off-chain = 200 CTC on-chain (1 punto = 1 CTC = 10^18 wei).
  const AMOUNT = ethers.parseEther("200");

  async function deployFixture() {
    const [backend, citizen, otroCiudadano, attacker] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("ChapaTuCripto");
    const token = (await Factory.connect(backend).deploy(backend.address)) as unknown as ChapaTuCripto;
    await token.waitForDeployment();
    return { token, backend, citizen, otroCiudadano, attacker };
  }

  // ------------------------------------------------------------------ CP018

  describe("CP018 — Emision de tokens en la wallet custodial y evidencia on-chain", () => {
    it("Paso 1-2: el mint acredita el monto exacto en la direccion custodial del ciudadano", async () => {
      const { token, backend, citizen } = await loadFixture(deployFixture);

      const saldoPrevio = await token.balanceOf(citizen.address);
      await token.connect(backend).recordAndReward(citizen.address, SESSION_ID, QR_HASH, AMOUNT);

      expect(await token.balanceOf(citizen.address)).to.equal(saldoPrevio + AMOUNT);
      expect(await token.sessionRecorded(SESSION_ID)).to.equal(true);
    });

    it("Paso 3: la transaccion emite SessionRecorded y TokensMinted con los datos de la sesion", async () => {
      const { token, backend, citizen } = await loadFixture(deployFixture);

      const tx = token.connect(backend).recordAndReward(citizen.address, SESSION_ID, QR_HASH, AMOUNT);

      // TokensMinted es el evento que el backend escucha para notificar al ciudadano (US-39).
      await expect(tx)
        .to.emit(token, "TokensMinted")
        .withArgs(citizen.address, AMOUNT, SESSION_ID);

      // SessionRecorded deja la huella del QR: la evidencia inmutable de la sesion.
      await expect(tx).to.emit(token, "SessionRecorded");

      const recibo = await (await tx).wait();
      expect(recibo?.status).to.equal(1, "la transaccion debe quedar confirmada");
      expect(recibo?.hash).to.match(/^0x[0-9a-f]{64}$/, "debe devolver un txHash trazable");
    });

    it("Solo BACKEND_ROLE puede emitir: una cuenta sin rol no mintea", async () => {
      const { token, citizen, attacker } = await loadFixture(deployFixture);

      await expect(
        token.connect(attacker).recordAndReward(citizen.address, SESSION_ID, QR_HASH, AMOUNT),
      ).to.be.reverted;

      expect(await token.balanceOf(citizen.address)).to.equal(0n);
      expect(await token.sessionRecorded(SESSION_ID)).to.equal(false);
    });
  });

  // ------------------------------------------------------------------ CP029

  describe("CP029 — Unicidad de la sesion sostenida en la cadena", () => {
    it("Paso 3-4: un sessionId ya registrado no puede volver a canjearse", async () => {
      const { token, backend, citizen } = await loadFixture(deployFixture);

      await token.connect(backend).recordAndReward(citizen.address, SESSION_ID, QR_HASH, AMOUNT);
      const saldoTrasElPrimerCanje = await token.balanceOf(citizen.address);

      // Segundo intento con el mismo sessionId: la cadena lo rechaza.
      await expect(
        token.connect(backend).recordAndReward(citizen.address, SESSION_ID, QR_HASH, AMOUNT),
      ).to.be.reverted;

      expect(await token.balanceOf(citizen.address)).to.equal(
        saldoTrasElPrimerCanje,
        "un canje rechazado no debe acreditar tokens",
      );
    });

    it("Ni siquiera cambiando el destinatario: la clave del anti doble canje es el sessionId", async () => {
      const { token, backend, citizen, otroCiudadano } = await loadFixture(deployFixture);

      await token.connect(backend).recordAndReward(citizen.address, SESSION_ID, QR_HASH, AMOUNT);

      await expect(
        token.connect(backend).recordAndReward(otroCiudadano.address, SESSION_ID, QR_HASH, AMOUNT),
      ).to.be.reverted;

      expect(await token.balanceOf(otroCiudadano.address)).to.equal(0n);
    });

    it("Paso 1-2: 50 sesiones distintas se registran sin colisiones", async () => {
      const { token, backend, citizen } = await loadFixture(deployFixture);
      const SESIONES = 50;
      const montoPorSesion = ethers.parseEther("10");

      for (let i = 0; i < SESIONES; i++) {
        const sessionId = 9000n + BigInt(i);
        const qrHash = ethers.keccak256(ethers.toUtf8Bytes(`QR-SESION-${i}`));
        await token.connect(backend).recordAndReward(citizen.address, sessionId, qrHash, montoPorSesion);
        expect(await token.sessionRecorded(sessionId)).to.equal(true);
      }

      expect(await token.balanceOf(citizen.address)).to.equal(
        montoPorSesion * BigInt(SESIONES),
        "cada sesion unica debe acreditar su monto una sola vez",
      );
    });
  });

  // ------------------------------------------------------------------ CP039

  describe("CP039 — Ejecucion de la suite en el entorno de pruebas", () => {
    it("Paso 1: la red local de Hardhat esta operativa con cuentas fondeadas", async () => {
      const signers = await ethers.getSigners();

      expect(signers.length).to.be.greaterThan(0, "la red local debe exponer cuentas");
      const saldo = await ethers.provider.getBalance(signers[0].address);
      expect(saldo).to.be.greaterThan(0n, "las cuentas locales deben venir fondeadas");
    });

    it("Paso 2: el contrato compila y despliega en la red local con su configuracion inicial", async () => {
      const { token, backend } = await loadFixture(deployFixture);

      expect(await token.name()).to.equal("Chapa Tu Cripto");
      expect(await token.symbol()).to.equal("CTC");
      expect(await token.decimals()).to.equal(18);

      const BACKEND_ROLE = await token.BACKEND_ROLE();
      expect(await token.hasRole(BACKEND_ROLE, backend.address)).to.equal(
        true,
        "el backend debe quedar con BACKEND_ROLE tras el despliegue",
      );
    });
  });
});
