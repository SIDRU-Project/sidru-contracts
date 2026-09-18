// Pruebas del token con transferencia permisionada (opcion C2).
//
// Requisito: el ciudadano puede TRANSFERIR y RETIRAR a otra wallet, pero NO puede
// formarse un mercado. Sin mercado no hay precio flotante, asi que la paridad
// 100 CTC = S/ 1.00 se sostiene por construccion y sin reserva alguna.

import { expect } from "chai";
import { ethers } from "hardhat";
import { ChapaTuCriptoRestricted } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const CTC = 10n ** 18n; // 1 CTC = 1 punto = S/ 0.01

describe("ChapaTuCriptoRestricted — transferible entre personas, no comerciable", () => {
  let token: ChapaTuCriptoRestricted;
  let deployer: HardhatEthersSigner;
  let backend: HardhatEthersSigner;
  let custodial: HardhatEthersSigner;   // direccion custodial del ciudadano
  let metamask: HardhatEthersSigner;    // wallet propia del ciudadano
  let amigo: HardhatEthersSigner;       // otro ciudadano registrado
  let pool: HardhatEthersSigner;        // simula un pool de Uniswap / exchange
  let extrano: HardhatEthersSigner;     // direccion cualquiera, no registrada

  beforeEach(async () => {
    [deployer, backend, custodial, metamask, amigo, pool, extrano] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("ChapaTuCriptoRestricted");
    token = await Token.deploy(backend.address);
    await token.waitForDeployment();

    // Recompensa por reciclaje: 280 CTC = S/ 2.80 a la direccion custodial.
    await token.connect(backend).recordAndReward(
      custodial.address, 1n, ethers.ZeroHash, 280n * CTC
    );
  });

  it("1. el mint por reciclaje funciona igual que en el contrato original", async () => {
    expect(await token.balanceOf(custodial.address)).to.equal(280n * CTC);
    expect(await token.sessionRecorded(1n)).to.equal(true);
  });

  it("2. RETIRO: el ciudadano retira a su MetaMask sin necesidad de allowlist previa", async () => {
    // withdrawTo lo inicia el backend, asi que el destino no requiere estar en la lista.
    await token.connect(backend).withdrawTo(custodial.address, metamask.address, 280n * CTC);

    expect(await token.balanceOf(metamask.address)).to.equal(280n * CTC);
    expect(await token.balanceOf(custodial.address)).to.equal(0n);
  });

  it("3. TRANSFERENCIA: entre dos wallets registradas funciona", async () => {
    await token.connect(backend).withdrawTo(custodial.address, metamask.address, 280n * CTC);

    // El backend registra ambas wallets al vincularlas en la app (tras validar EIP-55).
    await token.connect(backend).setTransferAllowed(metamask.address, true);
    await token.connect(backend).setTransferAllowed(amigo.address, true);

    await token.connect(metamask).transfer(amigo.address, 100n * CTC);

    expect(await token.balanceOf(amigo.address)).to.equal(100n * CTC);
    expect(await token.balanceOf(metamask.address)).to.equal(180n * CTC);
  });

  it("4. NO MERCADO: transferir a una direccion no registrada revierte", async () => {
    await token.connect(backend).withdrawTo(custodial.address, metamask.address, 280n * CTC);
    await token.connect(backend).setTransferAllowed(metamask.address, true);

    await expect(
      token.connect(metamask).transfer(extrano.address, 50n * CTC)
    ).to.be.revertedWithCustomError(token, "TransferNotAllowed").withArgs(extrano.address);
  });

  it("5. NO MERCADO: un pool no puede recibir ni revender CTC", async () => {
    await token.connect(backend).withdrawTo(custodial.address, metamask.address, 280n * CTC);
    await token.connect(backend).setTransferAllowed(metamask.address, true);

    // Nadie puede aportar liquidez al pool...
    await expect(
      token.connect(metamask).transfer(pool.address, 100n * CTC)
    ).to.be.revertedWithCustomError(token, "TransferNotAllowed").withArgs(pool.address);

    // ...y aunque el pool recibiera tokens por otra via, no podria revenderlos.
    await token.connect(backend).withdrawTo(custodial.address, pool.address, 0n);
    await token.connect(backend).setTransferAllowed(amigo.address, true);
    await expect(
      token.connect(pool).transfer(amigo.address, 1n)
    ).to.be.revertedWithCustomError(token, "TransferNotAllowed").withArgs(pool.address);
  });

  it("6. NO MERCADO: transferFrom con approve tampoco esquiva la restriccion", async () => {
    await token.connect(backend).withdrawTo(custodial.address, metamask.address, 280n * CTC);
    await token.connect(backend).setTransferAllowed(metamask.address, true);

    // El approve se puede firmar, pero el movimiento se bloquea igual.
    await token.connect(metamask).approve(extrano.address, 100n * CTC);
    await expect(
      token.connect(extrano).transferFrom(metamask.address, extrano.address, 100n * CTC)
    ).to.be.revertedWithCustomError(token, "TransferNotAllowed").withArgs(extrano.address);
  });

  it("7. el canje del catalogo (burn) sigue funcionando", async () => {
    await token.connect(backend).redeemFrom(custodial.address, 100n * CTC, 7n);

    expect(await token.balanceOf(custodial.address)).to.equal(180n * CTC);
    expect(await token.totalSupply()).to.equal(180n * CTC);
    expect(await token.rewardRedeemed(7n)).to.equal(true);
  });

  it("8. el backend puede revocar una wallet comprometida", async () => {
    await token.connect(backend).withdrawTo(custodial.address, metamask.address, 280n * CTC);
    await token.connect(backend).setTransferAllowed(metamask.address, true);
    await token.connect(backend).setTransferAllowed(amigo.address, true);
    await token.connect(metamask).transfer(amigo.address, 10n * CTC);

    await token.connect(backend).setTransferAllowed(metamask.address, false);

    await expect(
      token.connect(metamask).transfer(amigo.address, 10n * CTC)
    ).to.be.revertedWithCustomError(token, "TransferNotAllowed").withArgs(metamask.address);
  });

  it("9. solo BACKEND_ROLE administra la allowlist", async () => {
    await expect(
      token.connect(extrano).setTransferAllowed(extrano.address, true)
    ).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
  });

  it("10. el alta por lote registra varias wallets de una sola vez", async () => {
    await token.connect(backend).setTransferAllowedBatch(
      [metamask.address, amigo.address], true
    );

    expect(await token.transferAllowed(metamask.address)).to.equal(true);
    expect(await token.transferAllowed(amigo.address)).to.equal(true);
    expect(await token.transferAllowed(extrano.address)).to.equal(false);
  });

  it("11. la paridad no necesita reserva: no hay reserva que administrar", async () => {
    // 280 CTC = S/ 2.80 por definicion del programa; no hay colateral ni ventanilla de canje.
    // El contrato no custodia ningun otro activo: su unico estado es el saldo de CTC.
    const supply = await token.totalSupply();
    expect(supply).to.equal(280n * CTC);
    expect(supply / CTC).to.equal(280n); // 280 puntos -> 280 CTC -> S/ 2.80
  });
});
