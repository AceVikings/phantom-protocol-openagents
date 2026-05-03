/**
 * Shared types and the /wallet /balance /help /exit commands.
 * Seller- and buyer-specific commands live in seller.ts / buyer.ts.
 */
import type { WalletInfo } from '../lib/wallet.js'
import { getBalances }     from '../lib/wallet.js'

// ── Shared types ─────────────────────────────────────────────────────────────

export type LogColor = 'white' | 'green' | 'red' | 'yellow' | 'cyan' | 'magenta' | 'dim'

export interface LogLine {
  id:       number
  ts:       string          // HH:MM:SS
  content:  string
  color?:   LogColor
}

export interface AgentContext {
  apiKey:           string | null
  agentId:          string | null
  ephemeralAddress: string | null
  wallet:           WalletInfo | null
}

export interface CommandContext {
  role:        'seller' | 'buyer'
  provider:    'ollama' | 'openai'
  backendUrl:  string
  ollamaHost:  string
  ollamaModel: string
  openaiKey:   string
  openaiModel: string
  agentCtx:    AgentContext
  addLog:      (content: string, color?: LogColor) => void
  exit:        () => void
}

// ── Utility ───────────────────────────────────────────────────────────────────

export function ts(): string {
  return new Date().toISOString().slice(11, 19)
}

export function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return '0x' + Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function randomAxlPubkey(): string { return randomHex(32) }
export function randomTxHash():    string { return randomHex(32) }

// ── /wallet command ───────────────────────────────────────────────────────────

export async function cmdWallet(ctx: CommandContext): Promise<void> {
  const w = ctx.agentCtx.wallet
  if (!w) { ctx.addLog('Wallet not yet initialized.', 'yellow'); return }

  ctx.addLog('─────────────────────────────────────────', 'dim')
  ctx.addLog('  AGENT WALLET (Sepolia)', 'cyan')
  ctx.addLog(`  Address : ${w.address}`, 'white')
  ctx.addLog(`  Key     : ${w.privateKey.slice(0, 12)}…  (stored at ~/.phantom/wallet.json)`, 'dim')
  ctx.addLog(`  Explorer: https://sepolia.etherscan.io/address/${w.address}`, 'dim')
  ctx.addLog('─────────────────────────────────────────', 'dim')
}

// ── /balance command ──────────────────────────────────────────────────────────

export async function cmdBalance(ctx: CommandContext): Promise<void> {
  const w = ctx.agentCtx.wallet
  if (!w) { ctx.addLog('Wallet not yet initialized.', 'yellow'); return }

  ctx.addLog('Querying Sepolia balances…', 'dim')
  try {
    const bal = await getBalances(w.address)
    const ethF    = parseFloat(bal.eth).toFixed(6)
    const usdcF   = parseFloat(bal.usdc.balance).toFixed(2)
    const chain   = bal.chainId === 11155111 ? 'Sepolia testnet' : `chain ${bal.chainId}`

    ctx.addLog('─────────────────────────────────────────', 'dim')
    ctx.addLog(`  BALANCES on ${chain}`, 'cyan')
    ctx.addLog(`  Address : ${w.address}`, 'dim')
    ctx.addLog(`  ETH     : ${ethF} ETH`, Number(ethF) > 0 ? 'green' : 'yellow')
    ctx.addLog(`  USDC    : ${usdcF} USDC  (${bal.usdc.symbol})`, Number(usdcF) > 0 ? 'green' : 'yellow')
    ctx.addLog('─────────────────────────────────────────', 'dim')
    if (Number(ethF) === 0) {
      ctx.addLog('  ℹ  Faucet: https://cloud.google.com/application/web3/faucet/ethereum/sepolia', 'dim')
    }
  } catch (err: unknown) {
    ctx.addLog(`Balance query failed: ${(err as Error).message}`, 'red')
  }
}

// ── /help command ─────────────────────────────────────────────────────────────

export function cmdHelp(role: 'seller' | 'buyer', addLog: (content: string, color?: LogColor) => void): void {
  addLog('─────────────────────────────────────────', 'dim')
  addLog('  AVAILABLE COMMANDS', 'cyan')
  addLog('', 'white')

  if (role === 'seller') {
    addLog('  /research <topic>   — generate & list a research report', 'white')
    addLog('  /list               — show your active listings', 'white')
  } else {
    addLog('  /discover [cat]     — browse available listings', 'white')
    addLog('  /negotiate <id> [price]  — start AI-assisted negotiation', 'white')
    addLog('  /buy <id>           — buy at listed price', 'white')
  }

  addLog('  /deals              — show active deals', 'white')
  addLog('  /wallet             — show this session\'s wallet address', 'white')
  addLog('  /balance            — ETH + USDC balance on Sepolia', 'white')
  addLog('  /exit               — quit', 'white')
  addLog('', 'white')
  addLog('  Anything else is treated as a chat message to the LLM.', 'dim')
  addLog('─────────────────────────────────────────', 'dim')
}
