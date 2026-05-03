/**
 * agentWallet.ts
 *
 * Manages a persistent agent Ethereum wallet in localStorage.
 * This wallet is used by the MCP agent on the user's machine.
 * The private key is stored locally and never sent to any server.
 */
import { ethers } from 'ethers'

const STORAGE_KEY = 'phantom_agent_wallet'
const SEPOLIA_RPC  = 'https://sepolia.drpc.org'
const USDC_ADDRESS = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' // Circle testnet USDC

const USDC_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]

export type AgentWallet = {
  address:    string
  privateKey: string
}

/** Load wallet from localStorage or create a new one. */
export function loadOrCreateAgentWallet(): AgentWallet {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as AgentWallet
      if (parsed.address && parsed.privateKey) return parsed
    } catch { /* corrupt — regenerate */ }
  }
  const wallet = ethers.Wallet.createRandom()
  const agentWallet: AgentWallet = {
    address:    wallet.address,
    privateKey: wallet.privateKey,
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(agentWallet))
  return agentWallet
}

/** Clear stored wallet (reset). */
export function clearAgentWallet(): void {
  localStorage.removeItem(STORAGE_KEY)
}

export type Balances = {
  eth:  string
  usdc: string
}

/** Fetch ETH + USDC balances for the given address on Sepolia. */
export async function fetchBalances(address: string): Promise<Balances> {
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC)
  const [rawEth, usdcContract] = await Promise.all([
    provider.getBalance(address),
    Promise.resolve(new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider)),
  ])
  const rawUsdc = await usdcContract.balanceOf(address) as bigint
  return {
    eth:  parseFloat(ethers.formatEther(rawEth)).toFixed(6),
    usdc: parseFloat(ethers.formatUnits(rawUsdc, 6)).toFixed(2),
  }
}
