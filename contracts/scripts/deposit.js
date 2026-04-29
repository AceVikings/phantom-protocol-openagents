/**
 * scripts/deposit.js — perform a test deposit on Sepolia to get a real LOCK_TX_HASH
 *
 * Usage:
 *   DEAL_ID=<uuid-from-backend> \
 *   SELLER_ADDRESS=0x<seller-ephemeral> \
 *   VAULT_CONTRACT_ADDRESS=0x<deployed> \
 *   npx hardhat run scripts/deposit.js --network sepolia
 *
 * Prerequisites:
 *   - Deployer wallet has Sepolia USDC (get from Circle's testnet faucet)
 *   - USDC approved for the vault contract (run scripts/approve.js first)
 *   - DEAL_ID and SELLER_ADDRESS set
 *
 * Output: prints the tx hash — paste into backend/.env as LOCK_TX_HASH
 */

const { ethers } = require("hardhat");

// USDC on Sepolia (6 decimals)
const USDC_ADDRESS = process.env.VAULT_USDC_ADDRESS || "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

// Default: 5.00 USDC = 5_000_000 base units (6 decimals)
const AMOUNT_USDC = BigInt(process.env.AMOUNT_USDC || "5000000");

// Lock duration: 1 hour
const LOCK_DURATION = 60 * 60;

const VAULT_ABI = [
  "function deposit(bytes32 dealKey, address seller, uint256 amount, uint256 lockDuration) external",
  "function getDeal(bytes32 dealKey) external view returns (tuple(address buyer, address seller, uint256 amount, uint8 status, uint256 lockedAt, uint256 expiresAt))",
  "function dealKeyFor(string calldata dealId) external pure returns (bytes32)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
];

async function main() {
  const dealId = process.env.DEAL_ID;
  const sellerAddress = process.env.SELLER_ADDRESS;
  const vaultAddress = process.env.VAULT_CONTRACT_ADDRESS;

  if (!dealId) throw new Error("DEAL_ID env var is required");
  if (!sellerAddress) throw new Error("SELLER_ADDRESS env var is required");
  if (!vaultAddress) throw new Error("VAULT_CONTRACT_ADDRESS env var is required");

  const [buyer] = await ethers.getSigners();
  console.log(`\n── Phantom Vault Deposit ────────────────────────────────────────`);
  console.log(`Buyer   : ${buyer.address}`);
  console.log(`Seller  : ${sellerAddress}`);
  console.log(`Deal ID : ${dealId}`);
  console.log(`Amount  : ${Number(AMOUNT_USDC) / 1e6} USDC`);
  console.log(`Vault   : ${vaultAddress}`);

  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, buyer);
  const vault = new ethers.Contract(vaultAddress, VAULT_ABI, buyer);

  // Check USDC balance
  const balance = await usdc.balanceOf(buyer.address);
  console.log(`\nUSDC balance: ${Number(balance) / 1e6} USDC`);
  if (balance < AMOUNT_USDC) {
    throw new Error(
      `Insufficient USDC. Need ${Number(AMOUNT_USDC) / 1e6}, have ${Number(balance) / 1e6}.\n` +
      "Get testnet USDC from: https://faucet.circle.com"
    );
  }

  // Check/set allowance
  const allowance = await usdc.allowance(buyer.address, vaultAddress);
  if (allowance < AMOUNT_USDC) {
    console.log(`\nApproving USDC for vault…`);
    const approveTx = await usdc.approve(vaultAddress, AMOUNT_USDC);
    await approveTx.wait();
    console.log(`Approved: ${approveTx.hash}`);
  } else {
    console.log(`\nAllowance already sufficient (${Number(allowance) / 1e6} USDC)`);
  }

  // Derive the bytes32 deal key
  const dealKey = ethers.keccak256(ethers.toUtf8Bytes(dealId));
  console.log(`Deal key: ${dealKey}`);

  // Deposit
  console.log(`\nDepositing…`);
  const tx = await vault.deposit(dealKey, sellerAddress, AMOUNT_USDC, LOCK_DURATION);
  const receipt = await tx.wait();

  console.log(`\n── Deposited ────────────────────────────────────────────────────`);
  console.log(`Tx hash : ${receipt.hash}`);
  console.log(`Block   : ${receipt.blockNumber}`);
  console.log(`────────────────────────────────────────────────────────────────`);
  console.log(`\nAdd to backend/.env:`);
  console.log(`  LOCK_TX_HASH=${receipt.hash}`);
  console.log(`\nEtherscan: https://sepolia.etherscan.io/tx/${receipt.hash}`);
}

main().catch((err) => {
  console.error("\n[FATAL]", err.message);
  process.exitCode = 1;
});
