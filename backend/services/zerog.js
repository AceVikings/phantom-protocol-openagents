import { Indexer } from '@0gfoundation/0g-ts-sdk';
import { unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const STORAGE_URL =
  process.env.ZERO_G_STORAGE_URL || 'https://indexer-storage-testnet-turbo.0g.ai';

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

