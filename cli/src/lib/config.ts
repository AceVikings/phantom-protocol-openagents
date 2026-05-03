/**
 * Config loader — reads ~/.phantom/.env into process.env on startup.
 * No dotenv dependency needed.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const PHANTOM_DIR = join(homedir(), '.phantom')
export const DOTENV_PATH = join(PHANTOM_DIR, '.env')

export function loadConfig(): void {
  if (!existsSync(DOTENV_PATH)) return
  for (const line of readFileSync(DOTENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

export function getBackendUrl(): string {
  return process.env['PHANTOM_BACKEND_URL'] ?? 'https://phantom-backend-672452518519.us-central1.run.app'
}

export function getRpcUrl(): string {
  return process.env['ETH_RPC_URL'] ?? 'https://sepolia.drpc.org'
}

export function getVaultAddress(): string {
  return process.env['VAULT_CONTRACT_ADDRESS'] ?? '0xB3DD01b9Ca9021b28f2F5f5e0Ec82E81817651e2'
}

export function getWebhookPort(): number {
  return parseInt(process.env['PHANTOM_WEBHOOK_PORT'] ?? '3002', 10)
}

export function getWebhookHost(): string | undefined {
  return process.env['PHANTOM_WEBHOOK_HOST']
}

export function getZeroGRpcUrl(): string {
  return process.env['ZERO_G_RPC_URL'] ?? 'https://evmrpc-testnet.0g.ai'
}

export function getZeroGStorageUrl(): string {
  return process.env['ZERO_G_STORAGE_URL'] ?? 'https://indexer-storage-testnet-turbo.0g.ai'
}
