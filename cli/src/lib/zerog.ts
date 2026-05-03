/**
 * 0G Storage upload — runs entirely in the CLI so the backend
 * never sees raw payload bytes.  Only the rootHash + txHash are
 * forwarded to the backend after a successful upload.
 */
import { ethers }                    from 'ethers'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir }                    from 'node:os'
import { join }                      from 'node:path'
import { getZeroGRpcUrl, getZeroGStorageUrl } from './config.js'

// Dynamic import so esbuild keeps it external (CJS compat)
async function getSdk() {
  const mod = await import('@0gfoundation/0g-ts-sdk')
  return mod as unknown as {
    ZgFile:  { fromFilePath(p: string): Promise<ZgFileInstance> }
    Indexer: new (url: string) => IndexerInstance
  }
}

interface ZgFileInstance {
  merkleTree(): Promise<[MerkleTreeInstance | null, unknown]>
}
interface MerkleTreeInstance {
  rootHash(): string
}
interface IndexerInstance {
  upload(
    file: ZgFileInstance,
    rpcUrl: string,
    wallet: ethers.Wallet,
    opts: Record<string, unknown>,
  ): Promise<[unknown, unknown]>
  download(rootHash: string, path: string, proof: boolean): Promise<unknown>
}

export async function uploadToZeroG(
  dealId: string,
  encryptedBuffer: Buffer,
  privateKey: string,
): Promise<{ rootHash: string; txHash: string }> {
  const { ZgFile, Indexer } = await getSdk()

  const rpcUrl     = getZeroGRpcUrl()
  const storageUrl = getZeroGStorageUrl()

  const provider = new ethers.JsonRpcProvider(rpcUrl)
  const wallet   = new ethers.Wallet(privateKey, provider)
  const indexer  = new Indexer(storageUrl)

  const tmpPath = join(tmpdir(), `phantom-${dealId}-${Date.now()}.enc`)
  writeFileSync(tmpPath, encryptedBuffer)

  const MAX_ATTEMPTS = 3
  let lastError: Error | undefined

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const zgFile            = await ZgFile.fromFilePath(tmpPath)
        const [tree, treeErr]   = await zgFile.merkleTree()
        if (treeErr || !tree) throw new Error(`Merkle tree error: ${treeErr}`)

        const rootHash = tree.rootHash()

        const [txResult, uploadErr] = await indexer.upload(zgFile, rpcUrl, wallet, {})
        if (uploadErr) throw new Error(`0G upload error: ${uploadErr}`)

        const txHash = txResult !== null && typeof txResult === 'object' && 'txHash' in txResult
          ? (txResult as { txHash: string }).txHash
          : String(txResult)

        return { rootHash, txHash }
      } catch (e: unknown) {
        lastError = e as Error
        if (attempt < MAX_ATTEMPTS) {
          const delay = attempt * 5000
          await new Promise((r) => setTimeout(r, delay))
        }
      }
    }
    throw lastError
  } finally {
    try { unlinkSync(tmpPath) } catch { /* ignore */ }
  }
}

/** Query OG (native) balance for an address on 0G Galileo. */
export async function getZeroGBalance(address: string): Promise<string> {
  const provider = new ethers.JsonRpcProvider(getZeroGRpcUrl())
  const raw      = await provider.getBalance(address)
  return ethers.formatEther(raw)
}
