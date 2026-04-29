const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

// ── helpers ───────────────────────────────────────────────────────────────────
function dealKey(id) {
  return ethers.keccak256(ethers.toUtf8Bytes(id));
}

const USDC_DECIMALS = 6n;
const ONE_USDC      = 10n ** USDC_DECIMALS;        // 1_000_000
const FIVE_USDC     = 5n * ONE_USDC;               // 5_000_000
const ONE_HOUR      = 3600;
const FIVE_MIN      = 300;

// ─────────────────────────────────────────────────────────────────────────────

describe("PhantomVault", function () {
  let vault, usdc;
  let owner, operator, buyer, seller, stranger;

  beforeEach(async function () {
    [owner, operator, buyer, seller, stranger] = await ethers.getSigners();

    // Deploy a minimal ERC-20 mock to stand in for USDC
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20.deploy("USD Coin", "USDC", 6);

    // Mint 1000 USDC to buyer
    await usdc.mint(buyer.address, 1000n * ONE_USDC);

    // Deploy vault
    const PhantomVault = await ethers.getContractFactory("PhantomVault");
    vault = await PhantomVault.deploy(await usdc.getAddress(), operator.address);

    // Buyer approves vault
    await usdc.connect(buyer).approve(await vault.getAddress(), ethers.MaxUint256);
  });

  // ── deployment ──────────────────────────────────────────────────────────────
  describe("Deployment", function () {
    it("sets USDC address", async function () {
      expect(await vault.usdc()).to.equal(await usdc.getAddress());
    });

    it("sets operator address", async function () {
      expect(await vault.operator()).to.equal(operator.address);
    });

    it("sets owner to deployer", async function () {
      expect(await vault.owner()).to.equal(owner.address);
    });

    it("reverts with ZeroAddress for zero USDC", async function () {
      const PhantomVault = await ethers.getContractFactory("PhantomVault");
      await expect(
        PhantomVault.deploy(ethers.ZeroAddress, operator.address)
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("reverts with ZeroAddress for zero operator", async function () {
      const PhantomVault = await ethers.getContractFactory("PhantomVault");
      await expect(
        PhantomVault.deploy(await usdc.getAddress(), ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });
  });

  // ── deposit ─────────────────────────────────────────────────────────────────
  describe("deposit()", function () {
    const DEAL = "550e8400-e29b-41d4-a716-446655440000";

    it("locks USDC and emits Locked", async function () {
      const key = dealKey(DEAL);
      await expect(
        vault.connect(buyer).deposit(key, seller.address, FIVE_USDC, ONE_HOUR)
      )
        .to.emit(vault, "Locked")
        .withArgs(key, buyer.address, seller.address, FIVE_USDC, anyValue);

      // Funds transferred into vault
      expect(await usdc.balanceOf(await vault.getAddress())).to.equal(FIVE_USDC);
      expect(await usdc.balanceOf(buyer.address)).to.equal(1000n * ONE_USDC - FIVE_USDC);
    });

    it("stores correct deal struct", async function () {
      const key = dealKey(DEAL);
      await vault.connect(buyer).deposit(key, seller.address, FIVE_USDC, ONE_HOUR);

      const deal = await vault.getDeal(key);
      expect(deal.buyer).to.equal(buyer.address);
      expect(deal.seller).to.equal(seller.address);
      expect(deal.amount).to.equal(FIVE_USDC);
      expect(deal.status).to.equal(1); // Locked
    });

    it("reverts if deal already exists", async function () {
      const key = dealKey(DEAL);
      await vault.connect(buyer).deposit(key, seller.address, FIVE_USDC, ONE_HOUR);
      await expect(
        vault.connect(buyer).deposit(key, seller.address, FIVE_USDC, ONE_HOUR)
      ).to.be.revertedWithCustomError(vault, "DealAlreadyExists");
    });

    it("reverts with ZeroAmount", async function () {
      const key = dealKey(DEAL);
      await expect(
        vault.connect(buyer).deposit(key, seller.address, 0, ONE_HOUR)
      ).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("reverts with ZeroAddress for zero seller", async function () {
      const key = dealKey(DEAL);
      await expect(
        vault.connect(buyer).deposit(key, ethers.ZeroAddress, FIVE_USDC, ONE_HOUR)
      ).to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("reverts with LockDurationOutOfRange if too short", async function () {
      const key = dealKey(DEAL);
      await expect(
        vault.connect(buyer).deposit(key, seller.address, FIVE_USDC, 60) // 60s < MIN (5min)
      ).to.be.revertedWithCustomError(vault, "LockDurationOutOfRange");
    });

    it("reverts with LockDurationOutOfRange if too long", async function () {
      const key = dealKey(DEAL);
      const eightDays = 8 * 24 * 60 * 60;
      await expect(
        vault.connect(buyer).deposit(key, seller.address, FIVE_USDC, eightDays)
      ).to.be.revertedWithCustomError(vault, "LockDurationOutOfRange");
    });
  });

  // ── release ─────────────────────────────────────────────────────────────────
  describe("release()", function () {
    const DEAL = "deal-release-test";

    beforeEach(async function () {
      await vault.connect(buyer).deposit(dealKey(DEAL), seller.address, FIVE_USDC, ONE_HOUR);
    });

    it("operator can release funds to seller", async function () {
      const key = dealKey(DEAL);
      await expect(vault.connect(operator).release(key))
        .to.emit(vault, "Released")
        .withArgs(key, seller.address, FIVE_USDC);

      expect(await usdc.balanceOf(seller.address)).to.equal(FIVE_USDC);
      expect(await usdc.balanceOf(await vault.getAddress())).to.equal(0n);
    });

    it("owner can also release", async function () {
      await vault.connect(owner).release(dealKey(DEAL));
      expect(await usdc.balanceOf(seller.address)).to.equal(FIVE_USDC);
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
      await vault.connect(buyer).deposit(dealKey(DEAL), seller.address, FIVE_USDC, ONE_HOUR);
    });

    it("operator can refund buyer", async function () {
      const key = dealKey(DEAL);
      const before = await usdc.balanceOf(buyer.address);
      await expect(vault.connect(operator).refund(key))
        .to.emit(vault, "Refunded")
        .withArgs(key, buyer.address, FIVE_USDC);
      expect(await usdc.balanceOf(buyer.address)).to.equal(before + FIVE_USDC);
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
      await vault.connect(buyer).deposit(dealKey(DEAL), seller.address, FIVE_USDC, FIVE_MIN);
    });

    it("buyer can reclaim after expiry", async function () {
      const key = dealKey(DEAL);
      await time.increase(FIVE_MIN + 1);
      const before = await usdc.balanceOf(buyer.address);
      await vault.connect(buyer).claimExpiredRefund(key);
      expect(await usdc.balanceOf(buyer.address)).to.equal(before + FIVE_USDC);
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
