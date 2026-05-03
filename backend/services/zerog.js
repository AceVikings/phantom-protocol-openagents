import { ZgFile, Indexer } from '@0gfoundation/0g-ts-sdk';
import { ethers } from 'ethers';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const RPC_URL = process.env.ZERO_G_RPC_URL || 'https://evmrpc-testnet.0g.ai';
const STORAGE_URL =
  process.env.ZERO_G_STORAGE_URL || 'https://indexer-storage-testnet-turbo.0g.ai';

function getWallet() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  return new ethers.Wallet(process.env.PROTOCOL_PRIVATE_KEY, provider);
}

/**
 * Upload an already-encrypted payload buffer to 0G Storage.
 * Returns { rootHash, txHash }.
 * Retries up to 3 times on transient on-chain failures.
 */
export async function uploadToZeroG(dealId, encryptedBuffer) {
  const wallet = getWallet();
  const indexer = new Indexer(STORAGE_URL);

  // 0G SDK requires a file path — write buffer to a temp file
  const tmpPath = join(tmpdir(), `phantom-${dealId}-${Date.now()}.enc`);
  writeFileSync(tmpPath, encryptedBuffer);

  const MAX_ATTEMPTS = 3;
  let lastError;

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const zgFile = await ZgFile.fromFilePath(tmpPath);
        const [tree, treeErr] = await zgFile.merkleTree();
        if (treeErr || !tree) throw new Error(`Merkle tree error: ${treeErr}`);

        const rootHash = tree.rootHash();

        // Use SDK's auto-detected gas price for optimal tx acceptance
        const [txResult, uploadErr] = await indexer.upload(zgFile, RPC_URL, wallet, {});
        if (uploadErr) throw new Error(`0G upload error: ${uploadErr}`);

        const txHash = txResult?.txHash ?? txResult;
        console.log(`[0G] Uploaded deal ${dealId}: rootHash=${rootHash}, txHash=${txHash}`);
        return { rootHash, txHash: txResult };
      } catch (err) {
        lastError = err;
        if (attempt < MAX_ATTEMPTS) {
          const delay = attempt * 5000;
          console.warn(`[0G] Upload attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}. Retrying in ${delay / 1000}s…`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastError;
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {}
  }
}

/**
 * Check whether a rootHash is committed on 0G Storage.
 * Returns true if the file exists and can be downloaded, false otherwise.
 */
export async function verifyRootHashExists(rootHash) {
  const indexer = new Indexer(STORAGE_URL);
  const downloadPath = join(tmpdir(), `phantom-verify-${Date.now()}.tmp`);

  try {
    const err = await indexer.download(rootHash, downloadPath, false);
    try {
      unlinkSync(downloadPath);
    } catch {}
    return !err;
  } catch {
    return false;
  }
}

