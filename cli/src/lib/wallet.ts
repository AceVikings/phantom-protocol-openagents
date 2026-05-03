/**
 * Wallet helpers — persistent Ethereum wallet + balance queries.
 *
 * The agent wallet lives at ~/.phantom/wallet.json.
 * On first run a fresh random wallet is generated and saved there.
 * Set PHANTOM_PRIVATE_KEY to override with a specific key.
 */
import { ethers }          from 'ethers'
import { homedir }         from 'node:os'
import { join }            from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { getCurrentIdentity } from './state.js'

const WALLET_DIR  = join(homedir(), '.phantom')
const WALLET_FILE = join(WALLET_DIR, 'wallet.json')

function getWalletFile(): string {
  const id = getCurrentIdentity()
  return id === 'default' ? WALLET_FILE : join(WALLET_DIR, `${id}-wallet.json`)
}

export interface WalletInfo {
  address: string
  privateKey: string
}

export function loadOrCreateWallet(): WalletInfo {
  if (process.env['PHANTOM_PRIVATE_KEY']) {
    const w = new ethers.Wallet(process.env['PHANTOM_PRIVATE_KEY'])
    return { address: w.address, privateKey: w.privateKey }
  }

  const file = getWalletFile()
  if (existsSync(file)) {
    try {
      const json = JSON.parse(readFileSync(file, 'utf8')) as WalletInfo
      if (json.privateKey && json.address) return json
    } catch { /* fall through to regenerate */ }
  }

  mkdirSync(WALLET_DIR, { recursive: true })
  const w = ethers.Wallet.createRandom()
  const info: WalletInfo = { address: w.address, privateKey: w.privateKey }
  writeFileSync(file, JSON.stringify(info, null, 2), { mode: 0o600 })
  return info
}

/** Create a brand-new wallet, replacing whatever is stored. */
export function createNewWallet(): WalletInfo {
  mkdirSync(WALLET_DIR, { recursive: true })
  const w    = ethers.Wallet.createRandom()
  const info: WalletInfo = { address: w.address, privateKey: w.privateKey }
  writeFileSync(WALLET_FILE, JSON.stringify(info, null, 2), { mode: 0o600 })
  return info
}

/** Import a wallet from a private key hex string. Replaces existing. */
export function importWallet(privateKey: string): WalletInfo {
  const w    = new ethers.Wallet(privateKey)
  const info: WalletInfo = { address: w.address, privateKey: w.privateKey }
  mkdirSync(WALLET_DIR, { recursive: true })
  writeFileSync(WALLET_FILE, JSON.stringify(info, null, 2), { mode: 0o600 })
  return info
}

/** Delete the stored wallet. */
export function deleteWallet(): void {
  if (existsSync(WALLET_FILE)) unlinkSync(WALLET_FILE)
}

/** Generate a fresh ephemeral wallet (not saved to disk). */
export function createEphemeralWallet(): WalletInfo {
  const w = ethers.Wallet.createRandom()
  return { address: w.address, privateKey: w.privateKey }
}

/** Returns ETH balance for an address on Sepolia. Batching disabled to stay within free-tier RPC limits. */
export async function getEthBalance(
  address: string,
  rpcUrl = process.env['ETH_RPC_URL'] ?? 'https://sepolia.drpc.org',
): Promise<{ eth: string; chainId: number }> {
  // batchMaxCount:1 disables JSON-RPC batching — drpc free tier caps at 3 per batch
  // but combining getNetwork + getBalance + contract calls easily exceeds that
  const provider = new ethers.JsonRpcProvider(
    rpcUrl,
    undefined,
    { batchMaxCount: 1 },
  )
  const [rawEth, network] = await Promise.all([
    provider.getBalance(address),
    provider.getNetwork(),
  ])
  return { eth: ethers.formatEther(rawEth), chainId: Number(network.chainId) }
}

/** @deprecated use getEthBalance — kept for compatibility */
export const getBalances = async (address: string) => {
  const r = await getEthBalance(address)
  return { ...r, usdc: { symbol: 'USDC', balance: '0', decimals: 6, raw: 0n } }
}

