// Hardening de cobertura de ChapaTuCriptoStable.sol: cierra los branch-paths de código
// preexistente que ChapaTuCriptoStable.test.ts y ChapaTuCriptoStableWithdrawal.test.ts no
// ejercitan. El contrato es inmutable en mainnet, así que cada rama sin probar es
// permanente. No modifica el contrato ni los archivos de prueba existentes.

import { expect } from "chai";
import { ethers } from "hardhat";
import { ChapaTuCriptoStable, MockStableReserve } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const CENTS_PER_RESERVE_UNIT = 337n; // 1 mUSD = S/ 3.37
const RESERVE_DECIMALS = 6;
const ONE_RESERVE = 10n ** BigInt(RESERVE_DECIMALS);
const CTC = 10n ** 18n;

describe("ChapaTuCriptoStable — hardening de cobertura (ramas de código preexistente)", () => {
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

  it("1. constructor con reserveToken == address(0) revierte con 'invalid reserve token'", async () => {
    const Token = await ethers.getContractFactory("ChapaTuCriptoStable");
    await expect(
      Token.deploy(backend.address, ethers.ZeroAddress, RESERVE_DECIMALS, CENTS_PER_RESERVE_UNIT)
    ).to.be.revertedWith("invalid reserve token");
  });

  it("2. constructor con centsPerReserveUnit == 0 revierte con 'invalid parity'", async () => {
    const Token = await ethers.getContractFactory("ChapaTuCriptoStable");
    await expect(
      Token.deploy(backend.address, await reserve.getAddress(), RESERVE_DECIMALS, 0n)
    ).to.be.revertedWith("invalid parity");
  });

  it("3. purchase con un monto que convierte a 0 CTC revierte con AmountTooSmall", async () => {
    await expect(token.connect(tercero).purchase(0n)).to.be.revertedWithCustomError(
      token,
      "AmountTooSmall"
    );
  });

  it("4. redeem con un monto que convierte a 0 reserva revierte con AmountTooSmall", async () => {
    await expect(token.connect(ciudadano).redeem(0n)).to.be.revertedWithCustomError(
      token,
      "AmountTooSmall"
    );
  });

  it("5. withdrawTo (camino feliz): BACKEND_ROLE mueve CTC de A a B, saldo exacto, totalSupply sin cambios", async () => {
    await fondear(ONE_RESERVE);
    await token.connect(backend).recordAndReward(ciudadano.address, 1n, ethers.ZeroHash, 300n * CTC);
    const supplyAntes = await token.totalSupply();

    await token.connect(backend).withdrawTo(ciudadano.address, tercero.address, 120n * CTC);

    expect(await token.balanceOf(ciudadano.address)).to.equal(180n * CTC);
    expect(await token.balanceOf(tercero.address)).to.equal(120n * CTC);
    expect(await token.totalSupply()).to.equal(supplyAntes);
  });

  it("6. withdrawTo desde una cuenta sin rol revierte con AccessControlUnauthorizedAccount", async () => {
    await fondear(ONE_RESERVE);
    await token.connect(backend).recordAndReward(ciudadano.address, 1n, ethers.ZeroHash, 100n * CTC);

    await expect(
      token.connect(tercero).withdrawTo(ciudadano.address, tercero.address, 50n * CTC)
    ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
  });

  it("7. recordAndReward con sessionId duplicado revierte con 'session already recorded'", async () => {
    await fondear(ONE_RESERVE);
    await token.connect(backend).recordAndReward(ciudadano.address, 1n, ethers.ZeroHash, 100n * CTC);

    await expect(
      token.connect(backend).recordAndReward(ciudadano.address, 1n, ethers.ZeroHash, 50n * CTC)
    ).to.be.revertedWith("session already recorded");
  });

  it("8. redeemFrom con rewardTxId duplicado revierte con 'reward already redeemed'", async () => {
    await fondear(ONE_RESERVE);
    await token.connect(backend).recordAndReward(ciudadano.address, 1n, ethers.ZeroHash, 100n * CTC);
    await token.connect(backend).redeemFrom(ciudadano.address, 10n * CTC, 7n);

    await expect(
      token.connect(backend).redeemFrom(ciudadano.address, 10n * CTC, 7n)
    ).to.be.revertedWith("reward already redeemed");
  });

  it("9. redeemFrom desde una cuenta sin rol revierte con AccessControlUnauthorizedAccount", async () => {
    await fondear(ONE_RESERVE);
    await token.connect(backend).recordAndReward(ciudadano.address, 1n, ethers.ZeroHash, 100n * CTC);

    await expect(
      token.connect(tercero).redeemFrom(ciudadano.address, 10n * CTC, 8n)
    ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
  });

  it("10. withdrawExcessReserve desde una cuenta sin DEFAULT_ADMIN_ROLE revierte con AccessControlUnauthorizedAccount", async () => {
    await fondear(ONE_RESERVE);

    await expect(
      token.connect(tercero).withdrawExcessReserve(tercero.address, 1n)
    ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
  });

  it("11. collateralizationBps con requiredReserve() == 0 (totalSupply 0) devuelve type(uint256).max, tal como está escrito", async () => {
    // Sin fondear ni mintear: totalSupply == 0 => requiredReserve() == 0.
    expect(await token.totalSupply()).to.equal(0n);
    expect(await token.requiredReserve()).to.equal(0n);
    expect(await token.collateralizationBps()).to.equal(ethers.MaxUint256);
  });

  // --- Ramas adicionales encontradas al re-correr coverage tras las 11 anteriores ---

  it("12. recordAndReward desde una cuenta sin rol revierte con AccessControlUnauthorizedAccount", async () => {
    await fondear(ONE_RESERVE);

    await expect(
      token.connect(tercero).recordAndReward(ciudadano.address, 1n, ethers.ZeroHash, 50n * CTC)
    ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
  });

  it("13. withdrawTo a address(0) revierte con 'invalid destination'", async () => {
    await fondear(ONE_RESERVE);
    await token.connect(backend).recordAndReward(ciudadano.address, 1n, ethers.ZeroHash, 100n * CTC);

    await expect(
      token.connect(backend).withdrawTo(ciudadano.address, ethers.ZeroAddress, 10n * CTC)
    ).to.be.revertedWith("invalid destination");
  });
});
