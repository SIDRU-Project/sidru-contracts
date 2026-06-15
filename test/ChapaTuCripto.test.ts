import { expect } from "chai";
import { ethers } from "hardhat";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ChapaTuCripto } from "../typechain-types";

/**
 * Tests de la Fase 3 para ChapaTuCripto (CTC).
 * Cubre los 10 casos de contract-spec.md §9. Corre en la red local de Hardhat.
 *
 * Convencion de signers (MVP: deployer == backend):
 *  - backend  : recibe DEFAULT_ADMIN_ROLE (deployer) y BACKEND_ROLE. Firma las operaciones privilegiadas.
 *  - citizen  : direccion custodial receptora de tokens (no firma nada).
 *  - external : wallet externa del ciudadano (destino de withdrawTo).
 *  - attacker : cuenta SIN rol, usada para validar AccessControl.
 */
describe("ChapaTuCripto (CTC)", () => {
  // keccak256 del QR token de sesion, igual que hace el backend con sha3(qrToken).
  const QR_HASH = ethers.keccak256(ethers.toUtf8Bytes("QR-SESION-DEMO"));
  const SESSION_ID = 1001n;
  const AMOUNT = ethers.parseEther("280"); // 280 CTC en wei

  async function deployFixture() {
    const [backend, citizen, external, attacker] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("ChapaTuCripto");
    // En el MVP deployer (msg.sender = backend) y el arg `backend` son la misma wallet.
    const token = (await Factory.connect(backend).deploy(backend.address)) as unknown as ChapaTuCripto;
    await token.waitForDeployment();

    return { token, backend, citizen, external, attacker };
  }

  // Helper: recompensa una sesion para el ciudadano con el monto dado.
  async function reward(
    token: ChapaTuCripto,
    backend: HardhatEthersSigner,
    user: string,
    amount: bigint,
    sessionId: bigint = SESSION_ID,
  ) {
    return token.connect(backend).recordAndReward(user, sessionId, QR_HASH, amount);
  }

  describe("recordAndReward (mint por sesion)", () => {
    it("1. desde BACKEND_ROLE mintea el amount y actualiza balanceOf(user)", async () => {
      const { token, backend, citizen } = await loadFixture(deployFixture);

      await reward(token, backend, citizen.address, AMOUNT);

      expect(await token.balanceOf(citizen.address)).to.equal(AMOUNT);
      expect(await token.totalSupply()).to.equal(AMOUNT);
      expect(await token.sessionRecorded(SESSION_ID)).to.equal(true);
    });

    it("2. desde una cuenta SIN rol revierte con AccessControlUnauthorizedAccount", async () => {
      const { token, citizen, attacker } = await loadFixture(deployFixture);

      const BACKEND_ROLE = await token.BACKEND_ROLE();
      await expect(
        token.connect(attacker).recordAndReward(citizen.address, SESSION_ID, QR_HASH, AMOUNT),
      )
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
        .withArgs(attacker.address, BACKEND_ROLE);
    });

    it("3. con una sessionId duplicada revierte con 'session already recorded'", async () => {
      const { token, backend, citizen } = await loadFixture(deployFixture);

      await reward(token, backend, citizen.address, AMOUNT);

      await expect(
        reward(token, backend, citizen.address, AMOUNT),
      ).to.be.revertedWith("session already recorded");
    });

    it("4. emite SessionRecorded y TokensMinted con los args correctos", async () => {
      const { token, backend, citizen } = await loadFixture(deployFixture);

      const tx = token.connect(backend).recordAndReward(citizen.address, SESSION_ID, QR_HASH, AMOUNT);

      // SessionRecorded: el timestamp es block.timestamp -> se valida con anyValue.
      await expect(tx)
        .to.emit(token, "SessionRecorded")
        .withArgs(SESSION_ID, citizen.address, QR_HASH, AMOUNT, anyValue);

      // TokensMinted: todos los args son deterministas.
      await expect(tx)
        .to.emit(token, "TokensMinted")
        .withArgs(citizen.address, AMOUNT, SESSION_ID);
    });
  });

  describe("withdrawTo (retiro custodial)", () => {
    it("5. mueve el saldo al destino, deja from en 0 y emite TokensWithdrawn", async () => {
      const { token, backend, citizen, external } = await loadFixture(deployFixture);

      await reward(token, backend, citizen.address, AMOUNT);

      await expect(token.connect(backend).withdrawTo(citizen.address, external.address, AMOUNT))
        .to.emit(token, "TokensWithdrawn")
        .withArgs(citizen.address, external.address, AMOUNT);

      expect(await token.balanceOf(citizen.address)).to.equal(0n);
      expect(await token.balanceOf(external.address)).to.equal(AMOUNT);
      // totalSupply no cambia: es una transferencia, no un burn.
      expect(await token.totalSupply()).to.equal(AMOUNT);
    });

    it("6. con destino address(0) revierte con 'invalid destination'", async () => {
      const { token, backend, citizen } = await loadFixture(deployFixture);

      await reward(token, backend, citizen.address, AMOUNT);

      await expect(
        token.connect(backend).withdrawTo(citizen.address, ethers.ZeroAddress, AMOUNT),
      ).to.be.revertedWith("invalid destination");
    });

    it("7. sin saldo suficiente revierte con ERC20InsufficientBalance", async () => {
      const { token, backend, citizen, external } = await loadFixture(deployFixture);

      // citizen no tiene saldo: balanceOf == 0 < AMOUNT.
      await expect(
        token.connect(backend).withdrawTo(citizen.address, external.address, AMOUNT),
      )
        .to.be.revertedWithCustomError(token, "ERC20InsufficientBalance")
        .withArgs(citizen.address, 0n, AMOUNT);
    });
  });

  describe("redeemFrom (quema por canje)", () => {
    it("8. quema saldo: baja totalSupply y balanceOf(from), emite TokensRedeemed", async () => {
      const { token, backend, citizen } = await loadFixture(deployFixture);

      await reward(token, backend, citizen.address, AMOUNT);

      const rewardTxId = 7777n;
      const burnAmount = ethers.parseEther("100");

      await expect(token.connect(backend).redeemFrom(citizen.address, burnAmount, rewardTxId))
        .to.emit(token, "TokensRedeemed")
        .withArgs(citizen.address, burnAmount, rewardTxId);

      expect(await token.balanceOf(citizen.address)).to.equal(AMOUNT - burnAmount);
      expect(await token.totalSupply()).to.equal(AMOUNT - burnAmount);
    });

    it("11. con un rewardTxId duplicado revierte con 'reward already redeemed' (idempotencia)", async () => {
      const { token, backend, citizen } = await loadFixture(deployFixture);

      await reward(token, backend, citizen.address, AMOUNT);

      const rewardTxId = 8888n;
      const burnAmount = ethers.parseEther("50");

      // Primer canje OK: marca rewardRedeemed y quema.
      await token.connect(backend).redeemFrom(citizen.address, burnAmount, rewardTxId);
      expect(await token.rewardRedeemed(rewardTxId)).to.equal(true);

      // Segundo canje con el mismo id revierte -> un reintento/reconciliacion es seguro.
      await expect(
        token.connect(backend).redeemFrom(citizen.address, burnAmount, rewardTxId),
      ).to.be.revertedWith("reward already redeemed");

      // El saldo solo bajo una vez.
      expect(await token.balanceOf(citizen.address)).to.equal(AMOUNT - burnAmount);
    });
  });

  describe("AccessControl en operaciones custodiales", () => {
    it("9. withdrawTo y redeemFrom desde cuenta sin rol revierten por AccessControl", async () => {
      const { token, backend, citizen, external, attacker } = await loadFixture(deployFixture);

      await reward(token, backend, citizen.address, AMOUNT);

      const BACKEND_ROLE = await token.BACKEND_ROLE();

      await expect(
        token.connect(attacker).withdrawTo(citizen.address, external.address, AMOUNT),
      )
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
        .withArgs(attacker.address, BACKEND_ROLE);

      await expect(
        token.connect(attacker).redeemFrom(citizen.address, AMOUNT, 1n),
      )
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
        .withArgs(attacker.address, BACKEND_ROLE);
    });
  });

  describe("Coherencia off-chain / on-chain (OBLIGATORIO)", () => {
    it("10. pointsEarned=280 escalado a 18 decimales -> balanceOf == 280 * 10^18 wei", async () => {
      const { token, backend, citizen } = await loadFixture(deployFixture);

      // Replica exacta del backend (Web3j):
      //   amount = BigInteger.valueOf(pointsEarned).multiply(BigInteger.TEN.pow(18))
      const pointsEarned = 280n;
      const amountWei = pointsEarned * 10n ** 18n;

      await reward(token, backend, citizen.address, amountWei);

      // Coincidencia exacta con el calculo off-chain: 280 * 10^18 == parseEther("280").
      expect(amountWei).to.equal(ethers.parseEther("280"));
      expect(await token.balanceOf(citizen.address)).to.equal(ethers.parseEther("280"));
      expect(await token.balanceOf(citizen.address)).to.equal(amountWei);
    });
  });
});
