/**
 * phantom — Phantom Protocol CLI
 *
 * Wallet, balance, agent identity, deal management,
 * and inline MCP server for Claude / AI agents.
 */

import { Command } from 'commander'
import { loadConfig } from './lib/config.js'

// Load ~/.phantom/.env into process.env before anything else
loadConfig()

// ── Command implementations ──────────────────────────────────────────────────

import {
  cmdWalletShow, cmdWalletNew, cmdWalletImport, cmdWalletExport, cmdWalletDelete,
  cmdBalance,
} from './commands/wallet.js'
import { cmdTransferEth } from './commands/transfer.js'
import { cmdAgentNew, cmdAgentList, cmdAgentShow, cmdAgentDelete } from './commands/agent.js'
import { cmdDealList, cmdDealShow } from './commands/deal.js'
import { cmdMcpStart, cmdMcpConfig } from './commands/mcp.js'

// ── Program ──────────────────────────────────────────────────────────────────

const program = new Command()

program
  .name('phantom')
  .description('Phantom Protocol — privacy-preserving AI agent data marketplace')
  .version('1.0.0')

// ── phantom wallet ────────────────────────────────────────────────────────────

const wallet = program.command('wallet').description('Manage the default Ethereum wallet')

wallet
  .command('show')
  .description('Show address and file location (default action)')
  .action(() => cmdWalletShow())

wallet
  .command('new')
  .description('Generate a fresh wallet (overwrites existing with --force)')
  .option('-f, --force', 'Overwrite existing wallet')
  .action((opts) => cmdWalletNew(opts))

wallet
  .command('import <privateKey>')
  .description('Import a wallet from a private key')
  .action((key) => cmdWalletImport(key))

wallet
  .command('export')
  .description('Print the raw private key (requires confirmation)')
  .action(() => cmdWalletExport())

wallet
  .command('delete')
  .description('Delete the wallet file (requires confirmation)')
  .action(() => cmdWalletDelete())

// Default `phantom wallet` → show
wallet.action(() => cmdWalletShow())

// ── phantom balance ───────────────────────────────────────────────────────────

program
  .command('balance [address]')
  .description('Show ETH balance on Sepolia')
  .action((address?: string) => cmdBalance(address))

// ── phantom transfer ──────────────────────────────────────────────────────────

const transfer = program.command('transfer').description('Send tokens from the default wallet')

transfer
  .command('eth <to> <amount>')
  .description('Send ETH (e.g. phantom transfer eth 0xAbc… 0.01)')
  .action((to: string, amount: string) => cmdTransferEth(to, amount))

// ── phantom deposit ───────────────────────────────────────────────────────────

program
  .command('deposit <amount>')
  .description('Deposit ETH into the PhantomVault escrow contract')
  .action(async (amount: string) => {
    const { lockFundsInVault } = await import('./lib/vault.js')
    const { loadOrCreateWallet } = await import('./lib/wallet.js')
    const chalk = (await import('chalk')).default
    const spin  = (await import('ora')).default(`Depositing ${amount} ETH into vault…`).start()
    try {
      const wallet = loadOrCreateWallet()
      const { txHash } = await lockFundsInVault({
        dealId:        'deposit',
        sellerAddress: wallet.address,
        amountEth:     parseFloat(amount),
        privateKey:    wallet.privateKey,
      })
      spin.succeed(chalk.green(`Deposited ${amount} ETH`))
      console.log(`  Tx: ${txHash}`)
      console.log(`  Explorer: https://sepolia.etherscan.io/tx/${txHash}`)
    } catch (e: unknown) {
      spin.fail(chalk.red((e as Error).message))
      process.exit(1)
    }
  })

// ── phantom agent ─────────────────────────────────────────────────────────────

const agent = program.command('agent').description('Manage AI agent identities (AXL + wallet pairs)')

agent
  .command('new')
  .description('Generate a new agent (Ed25519 + wallet) and register it')
  .option('-r, --role <role>', 'Agent role: buyer or seller', 'seller')
  .option('-b, --backend <url>', 'Override backend URL')
  .action((opts) => cmdAgentNew(opts))

agent
  .command('list')
  .description('List all registered agents')
  .action(() => cmdAgentList())

agent
  .command('show [id]')
  .description('Show agent details (defaults to the last-used agent)')
  .action((id?: string) => cmdAgentShow(id))

agent
  .command('delete <id>')
  .description('Deregister and delete an agent')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action((id: string, opts) => cmdAgentDelete(id, opts))

// Default `phantom agent` → list
agent.action(() => cmdAgentList())

// ── phantom deal ──────────────────────────────────────────────────────────────

const deal = program.command('deal').description('View deals from the active session')

deal
  .command('list')
  .description('List active deals')
  .action(() => cmdDealList())

deal
  .command('show <id>')
  .description('Show details of a deal')
  .action((id: string) => cmdDealShow(id))

// Default `phantom deal` → list
deal.action(() => cmdDealList())

// ── phantom mcp ───────────────────────────────────────────────────────────────

const mcp = program.command('mcp').description('MCP server for Claude / AI agents')

mcp
  .command('config')
  .description('Print Claude Desktop JSON snippet')
  .action(() => cmdMcpConfig())

// Default `phantom mcp` → start stdio server
mcp
  .option('-a, --agent <id>', 'Agent ID to use (defaults to last-used)')
  .option('-r, --role <role>', 'Auto-register as this role on first start (buyer or seller)')
  .action((opts) => cmdMcpStart(opts))

// ── Parse ─────────────────────────────────────────────────────────────────────

program.parse()
