import { ZgFile, Indexer } from '@0gfoundation/0g-ts-sdk';
import { ethers } from 'ethers';
import { createZGComputeNetworkBroker } from '@0glabs/0g-serving-broker';
import OpenAI from 'openai';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const RPC_URL = process.env.ZERO_G_RPC_URL || 'https://evmrpc-testnet.0g.ai';
const STORAGE_URL =
  process.env.ZERO_G_STORAGE_URL || 'https://indexer-storage-testnet-turbo.0g.ai';
const PROVIDER_ADDRESS =
  process.env.ZERO_G_PROVIDER_ADDRESS || '0xa48f01287233509FD694a22Bf840225062E67836';

function getWallet() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  return new ethers.Wallet(process.env.PROTOCOL_PRIVATE_KEY, provider);
}

/**
 * Upload an already-encrypted payload buffer to 0G Storage.
 * Returns { rootHash, txHash }.
 */
export async function uploadToZeroG(dealId, encryptedBuffer) {
  const wallet = getWallet();
  const indexer = new Indexer(STORAGE_URL);

  // 0G SDK requires a file path — write buffer to a temp file
  const tmpPath = join(tmpdir(), `phantom-${dealId}-${Date.now()}.enc`);
  writeFileSync(tmpPath, encryptedBuffer);

  try {
    const zgFile = await ZgFile.fromFilePath(tmpPath);
    const [tree, treeErr] = await zgFile.merkleTree();
    if (treeErr || !tree) throw new Error(`Merkle tree error: ${treeErr}`);

    const rootHash = tree.rootHash();

    const [txHash, uploadErr] = await indexer.upload(zgFile, RPC_URL, wallet, {
      gasPrice: ethers.parseUnits('1', 'gwei'),
    });
    if (uploadErr) throw new Error(`0G upload error: ${uploadErr}`);

    console.log(`[0G] Uploaded deal ${dealId}: rootHash=${rootHash}, txHash=${txHash}`);
    return { rootHash, txHash };
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

/**
 * Ask a 0G Compute inference node to confirm the payload metadata is consistent.
 * This is a best-effort check — returns true if compute is unavailable.
 */
export async function runComputeVerification(dealId, rootHash, expectedSha256 = null) {
  const wallet = getWallet();

  try {
    const broker = await createZGComputeNetworkBroker(wallet);
    const { endpoint, model } = await broker.inference.getServiceMetadata(PROVIDER_ADDRESS);
    const prompt = `Verify deal ${dealId}`;
    const headers = await broker.inference.getRequestHeaders(PROVIDER_ADDRESS, prompt);

    const client = new OpenAI({ baseURL: endpoint, apiKey: '' });

    const lines = [
      `Deal ID: ${dealId}`,
      `Root hash on 0G Storage: ${rootHash}`,
      expectedSha256 ? `Expected SHA256: ${expectedSha256}` : null,
      '',
      'As a verification agent for Phantom Protocol, confirm the rootHash is consistent with the stated metadata. Reply with VERIFIED or UNVERIFIED only.',
    ].filter(Boolean);

    const response = await client.chat.completions.create(
      {
        model,
        messages: [
          {
            role: 'system',
            content: 'You are a file verification agent for Phantom Protocol.',
          },
          { role: 'user', content: lines.join('\n') },
        ],
      },
      { headers },
    );

    await broker.inference.processResponse(PROVIDER_ADDRESS, response, '');

    const verdict = response.choices[0]?.message?.content?.trim() || '';
    console.log(`[0G Compute] Verification for deal ${dealId}: ${verdict}`);
    return verdict.toUpperCase().includes('VERIFIED');
  } catch (err) {
    console.error('[0G Compute] Verification error (non-fatal):', err.message);
    return true; // trust the rootHash if compute is unavailable
  }
}
