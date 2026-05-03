const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

// ── helpers ───────────────────────────────────────────────────────────────────
function dealKey(id) {
  return ethers.keccak256(ethers.toUtf8Bytes(id));
}

const FIVE_ETH  = ethers.parseEther("5");
const ZERO_ETH  = 0n;
const ONE_HOUR  = 3600;
const FIVE_MIN  = 300;

// ─────────────────────────────────────────────────────────────────────────────

describe("PhantomVault", function () {
  let vault;
  let owner, operator, buyer, seller, stranger;

  beforeEach(async function () {
    [owner, operator, buyer, seller, stranger] = await ethers.getSigners();

    // Deploy vault (ETH-only, no token param)
    const PhantomVault = await ethers.getContractFactory("PhantomVault");
    vault = await PhantomVault.deploy(operator.address);
  });

  // ── deployment ──────────────────────────────────────────────────────────────
  describe("Deployment", function () {
    it("sets operator address", async function () {
      expect(await vault.operator()).to.equal(operator.address);
    });

    it("sets owner to deployer", async function () {
      expect(await vault.owner()).to.equal(owner.address);
    });

    it("reverts with ZeroAddress for zero operator", async function () {
      const PhantomVault = await ethers.getContractFactory("PhantomVault");
      await expect(
        PhantomVault.deploy(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });
  });

  // ── deposit ─────────────────────────────────────────────────────────────────
  describe("deposit()", function () {
    const DEAL = "550e8400-e29b-41d4-a716-446655440000";

    it("locks ETH and emits Locked", async function () {
      const key = dealKey(DEAL);
      const vaultAddr = await vault.getAddress();
      await expect(
        vault.connect(buyer).deposit(key, seller.address, ONE_HOUR, { value: FIVE_ETH })
      )
        .to.emit(vault, "Locked")
        .withArgs(key, buyer.address, seller.address, FIVE_ETH, anyValue);

      // ETH held by vault
      expect(await ethers.provider.getBalance(vaultAddr)).to.equal(FIVE_ETH);
    });

    it("stores correct deal struct", async function () {
      const key = dealKey(DEAL);
      await vault.connect(buyer).deposit(key, seller.address, ONE_HOUR, { value: FIVE_ETH });

      const deal = await vault.getDeal(key);
      expect(deal.buyer).to.equal(buyer.address);
      expect(deal.seller).to.equal(seller.address);
      expect(deal.amount).to.equal(FIVE_ETH);
      expect(deal.status).to.equal(1); // Locked
    });

    it("reverts if deal already exists", async function () {
      const key = dealKey(DEAL);
      await vault.connect(buyer).deposit(key, seller.address, ONE_HOUR, { value: FIVE_ETH });
      await expect(
        vault.connect(buyer).deposit(key, seller.address, ONE_HOUR, { value: FIVE_ETH })
      ).to.be.revertedWithCustomError(vault, "DealAlreadyExists");
    });

    it("reverts with ZeroAmount when msg.value is 0", async function () {
      const key = dealKey(DEAL);
      await expect(
        vault.connect(buyer).deposit(key, seller.address, ONE_HOUR, { value: 0n })
      ).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("reverts with ZeroAddress for zero seller", async function () {
      const key = dealKey(DEAL);
      await expect(
        vault.connect(buyer).deposit(key, ethers.ZeroAddress, ONE_HOUR, { value: FIVE_ETH })
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("reverts with LockDurationOutOfRange if too short", async function () {
      const key = dealKey(DEAL);
      await expect(
        vault.connect(buyer).deposit(key, seller.address, 60, { value: FIVE_ETH }) // 60s < MIN (5min)
      ).to.be.revertedWithCustomError(vault, "LockDurationOutOfRange");
    });

    it("reverts with LockDurationOutOfRange if too long", async function () {
      const key = dealKey(DEAL);
      const eightDays = 8 * 24 * 60 * 60;
      await expect(
        vault.connect(buyer).deposit(key, seller.address, eightDays, { value: FIVE_ETH })
      ).to.be.revertedWithCustomError(vault, "LockDurationOutOfRange");
    });
  });

  // ── release ─────────────────────────────────────────────────────────────────
  describe("release()", function () {
    const DEAL = "deal-release-test";

    beforeEach(async function () {
      await vault.connect(buyer).deposit(dealKey(DEAL), seller.address, ONE_HOUR, { value: FIVE_ETH });
    });

    it("operator can release ETH to seller", async function () {
      const key = dealKey(DEAL);
      const before = await ethers.provider.getBalance(seller.address);
      await expect(vault.connect(operator).release(key))
        .to.emit(vault, "Released")
        .withArgs(key, seller.address, FIVE_ETH);

      const after = await ethers.provider.getBalance(seller.address);
      expect(after - before).to.equal(FIVE_ETH);
      expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(0n);
    });

    it("owner can also release", async function () {
      const before = await ethers.provider.getBalance(seller.address);
      await vault.connect(owner).release(dealKey(DEAL));
      const after = await ethers.provider.getBalance(seller.address);
      expect(after - before).to.equal(FIVE_ETH);
    });

    it("stranger cannot release", async function () {
      await expect(
        vault.connect(stranger).release(dealKey(DEAL))
      ).to.be.revertedWithCustomError(vault, "NotAuthorized");
    });

    it("reverts with DealNotFound for unknown deal", async function () {
      await expect(
        vault.connect(operator).release(dealKey("nonexistent"))
      ).to.be.revertedWithCustomError(vault, "DealNotFound");
    });

    it("reverts with DealNotLocked after already released", async function () {
      const key = dealKey(DEAL);
      await vault.connect(operator).release(key);
      await expect(
        vault.connect(operator).release(key)
      ).to.be.revertedWithCustomError(vault, "DealNotLocked");
    });

    it("reverts with DealExpired if lock has expired", async function () {
      await time.increase(ONE_HOUR + 1);
      await expect(
        vault.connect(operator).release(dealKey(DEAL))
      ).to.be.revertedWithCustomError(vault, "DealExpired");
    });

    it("updates deal status to Released", async function () {
      const key = dealKey(DEAL);
      await vault.connect(operator).release(key);
      const deal = await vault.getDeal(key);
      expect(deal.status).to.equal(2); // Released
    });
  });

  // ── refund ──────────────────────────────────────────────────────────────────
  describe("refund()", function () {
    const DEAL = "deal-refund-test";

    beforeEach(async function () {
      await vault.connect(buyer).deposit(dealKey(DEAL), seller.address, ONE_HOUR, { value: FIVE_ETH });
    });

    it("operator can refund ETH to buyer", async function () {
      const key = dealKey(DEAL);
      const before = await ethers.provider.getBalance(buyer.address);
      await expect(vault.connect(operator).refund(key))
        .to.emit(vault, "Refunded")
        .withArgs(key, buyer.address, FIVE_ETH);
      const after = await ethers.provider.getBalance(buyer.address);
      expect(after - before).to.equal(FIVE_ETH);
    });

    it("stranger cannot refund", async function () {
      await expect(
        vault.connect(stranger).refund(dealKey(DEAL))
      ).to.be.revertedWithCustomError(vault, "NotAuthorized");
    });

    it("reverts with DealNotFound for unknown deal", async function () {
      await expect(
        vault.connect(operator).refund(dealKey("nonexistent"))
      ).to.be.revertedWithCustomError(vault, "DealNotFound");
    });

    it("reverts with DealNotLocked after already refunded", async function () {
      const key = dealKey(DEAL);
      await vault.connect(operator).refund(key);
      await expect(
        vault.connect(operator).refund(key)
      ).to.be.revertedWithCustomError(vault, "DealNotLocked");
    });

    it("updates deal status to Refunded", async function () {
      const key = dealKey(DEAL);
      await vault.connect(operator).refund(key);
      const deal = await vault.getDeal(key);
      expect(deal.status).to.equal(3); // Refunded
    });
  });

  // ── claimExpiredRefund ───────────────────────────────────────────────────────
  describe("claimExpiredRefund()", function () {
    const DEAL = "deal-expired-test";

    beforeEach(async function () {
      await vault.connect(buyer).deposit(dealKey(DEAL), seller.address, FIVE_MIN, { value: FIVE_ETH });
    });

    it("buyer can reclaim ETH after expiry", async function () {
      const key = dealKey(DEAL);
      await time.increase(FIVE_MIN + 1);
      const before = await ethers.provider.getBalance(buyer.address);
      const tx = await vault.connect(buyer).claimExpiredRefund(key);
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;
      const after = await ethers.provider.getBalance(buyer.address);
      expect(after - before + gasCost).to.equal(FIVE_ETH);
    });

    it("reverts before expiry", async function () {
      await expect(
        vault.connect(buyer).claimExpiredRefund(dealKey(DEAL))
      ).to.be.revertedWithCustomError(vault, "DealNotExpired");
    });

    it("non-buyer cannot claim", async function () {
      await time.increase(FIVE_MIN + 1);
      await expect(
        vault.connect(stranger).claimExpiredRefund(dealKey(DEAL))
      ).to.be.revertedWithCustomError(vault, "NotAuthorized");
    });

    it("reverts for unknown deal", async function () {
      await time.increase(FIVE_MIN + 1);
      await expect(
        vault.connect(buyer).claimExpiredRefund(dealKey("nonexistent"))
      ).to.be.revertedWithCustomError(vault, "DealNotFound");
    });
  });

  // ── setOperator ──────────────────────────────────────────────────────────────
  describe("setOperator()", function () {
    it("owner can update operator", async function () {
      await expect(vault.connect(owner).setOperator(stranger.address))
        .to.emit(vault, "OperatorUpdated")
        .withArgs(operator.address, stranger.address);
      expect(await vault.operator()).to.equal(stranger.address);
    });

    it("non-owner cannot update operator", async function () {
      await expect(
        vault.connect(operator).setOperator(stranger.address)
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("reverts with ZeroAddress", async function () {
      await expect(
        vault.connect(owner).setOperator(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });
  });

  // ── dealKeyFor ───────────────────────────────────────────────────────────────
  describe("dealKeyFor()", function () {
    it("matches off-chain keccak256(utf8(dealId))", async function () {
      const id = "550e8400-e29b-41d4-a716-446655440000";
      const onChain  = await vault.dealKeyFor(id);
      const offChain = ethers.keccak256(ethers.toUtf8Bytes(id));
      expect(onChain).to.equal(offChain);
    });
  });
});

// (no custom helper needed — anyValue from hardhat-chai-matchers handles timestamp matching)
