/**
 * Deploy PhantomVault to Sepolia.
 *
 * Usage:
 *   cd contracts
 *   cp .env.example .env          # fill in SEPOLIA_RPC_URL, PROTOCOL_PRIVATE_KEY
 *   npm install
 *   npx hardhat run scripts/deploy.js --network sepolia
 *
 * After deployment, copy VAULT_CONTRACT_ADDRESS into backend/.env.
 *
 * To verify on Etherscan (optional):
 *   npx hardhat verify --network sepolia <DEPLOYED_ADDRESS> <USDC_ADDRESS> <OPERATOR_ADDRESS>
 *
 * ── DealId → bytes32 conversion ─────────────────────────────────────────────
 * Backend deal IDs are UUID strings (e.g. "550e8400-e29b-41d4-a716-446655440000").
 * The on-chain key is:
 *   bytes32 key = keccak256(abi.encodePacked(dealId))   // Solidity
 *   const key  = ethers.keccak256(ethers.toUtf8Bytes(dealId))  // JS/ethers v6
 * Use dealKeyFor(dealId) on the deployed contract to verify the conversion.
 */

const { ethers, network } = require("hardhat");

// ── Addresses ────────────────────────────────────────────────────────────────
// USDC on Sepolia (Circle's official testnet deployment, 6 decimals)
const USDC_SEPOLIA = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

// Operator = the protocol wallet that calls release() / refund().
// Defaults to the deployer if not set. On Sepolia this is the same wallet
// as PROTOCOL_PRIVATE_KEY in backend/.env.
const OPERATOR = process.env.OPERATOR_ADDRESS || null;

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const [deployer] = await ethers.getSigners();
  const operator = OPERATOR || deployer.address;

  console.log("\n── PhantomVault deployment ────────────────────────────────────");
  console.log(`Network    : ${network.name}`);
  console.log(`Deployer   : ${deployer.address}`);
  console.log(`Operator   : ${operator}`);
  console.log(`USDC       : ${USDC_SEPOLIA}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`ETH balance: ${ethers.formatEther(balance)} ETH`);

  if (balance === 0n) {
    throw new Error(
      "Deployer has no ETH. Get Sepolia ETH from:\n" +
      "  https://cloud.google.com/application/web3/faucet/ethereum/sepolia\n" +
      "  https://sepoliafaucet.com"
    );
  }

  const PhantomVault = await ethers.getContractFactory("PhantomVault");
  console.log("\nDeploying…");

  const vault = await PhantomVault.deploy(USDC_SEPOLIA, operator);
  await vault.waitForDeployment();

  const address = await vault.getAddress();
  const deployTx = vault.deploymentTransaction();

  console.log("\n── Deployed ────────────────────────────────────────────────────");
  console.log(`Contract   : ${address}`);
  console.log(`Tx hash    : ${deployTx?.hash}`);
  console.log(`Block      : ${deployTx?.blockNumber ?? "(pending)"}`);
  console.log("────────────────────────────────────────────────────────────────");

  // Print the env var to paste into backend/.env
  console.log(`\nAdd to backend/.env:`);
  console.log(`  VAULT_CONTRACT_ADDRESS=${address}`);
  console.log(`  VAULT_CHAIN_ID=11155111`);
  console.log(`  VAULT_USDC_ADDRESS=${USDC_SEPOLIA}`);

  // Show Etherscan link
  console.log(`\nEtherscan: https://sepolia.etherscan.io/address/${address}`);

  // Show verification command
  console.log(`\nTo verify:`);
  console.log(
    `  npx hardhat verify --network sepolia ${address} ${USDC_SEPOLIA} ${operator}`
  );

  // Sanity check: confirm operator is set correctly
  const onChainOperator = await vault.operator();
  if (onChainOperator.toLowerCase() !== operator.toLowerCase()) {
    throw new Error(`Operator mismatch: expected ${operator}, got ${onChainOperator}`);
  }
  console.log(`\nOperator confirmed on-chain: ${onChainOperator}`);
}

// ── Deposit helper (for run-test.js pre-flight) ──────────────────────────────
// This is not called during deployment — exported for use in other scripts.
async function makeDealKey(dealId) {
  return ethers.keccak256(ethers.toUtf8Bytes(dealId));
}

main().catch((err) => {
  console.error("\n[FATAL]", err.message);
  process.exitCode = 1;
});
