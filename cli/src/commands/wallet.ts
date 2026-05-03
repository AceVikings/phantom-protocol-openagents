/**
 * phantom wallet — show, create, import, export
 */
import chalk from 'chalk'
import { createInterface } from 'node:readline/promises'
import {
  loadOrCreateWallet, createNewWallet, importWallet,
  deleteWallet, getEthBalance, type WalletInfo,
} from '../lib/wallet.js'
import { getZeroGBalance } from '../lib/zerog.js'

export async function cmdWalletShow(): Promise<void> {
  const w = loadOrCreateWallet()
  printWallet(w)
}

export async function cmdWalletNew(opts: { force?: boolean }): Promise<void> {
  const existing = (() => {
    try { return loadOrCreateWallet() } catch { return null }
  })()

  if (existing && !opts.force) {
    console.log(chalk.yellow('A wallet already exists. Use --force to overwrite.'))
    console.log(chalk.dim(`Current: ${existing.address}`))
    return
  }

  const w = createNewWallet()
  console.log(chalk.green('✓ New wallet created'))
  printWallet(w)
}

export async function cmdWalletImport(privateKey: string): Promise<void> {
  try {
    const w = importWallet(privateKey)
    console.log(chalk.green('✓ Wallet imported'))
    printWallet(w)
  } catch (e: unknown) {
    console.error(chalk.red(`✗ Invalid private key: ${(e as Error).message}`))
    process.exit(1)
  }
}

export async function cmdWalletExport(): Promise<void> {
  const w = loadOrCreateWallet()

  console.log(chalk.yellow('\n⚠  WARNING: Your private key grants full control of your funds.'))
  console.log(chalk.yellow('   Never share it. Never paste it into a website.'))
  console.log(chalk.yellow('   Store it in a password manager or hardware wallet.\n'))

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question('  Type "yes I understand" to reveal: ')
  rl.close()

  if (answer.trim().toLowerCase() !== 'yes i understand') {
    console.log(chalk.dim('\n  Aborted.'))
    return
  }

  console.log()
  console.log(chalk.bold('  Address:     ') + chalk.cyan(w.address))
  console.log(chalk.bold('  Private key: ') + chalk.red(w.privateKey))
  console.log()
}

export async function cmdWalletDelete(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(chalk.red('Delete wallet from disk? This CANNOT be undone. Type "delete" to confirm: '))
  rl.close()

  if (answer.trim().toLowerCase() !== 'delete') {
    console.log(chalk.dim('Aborted.'))
    return
  }

  deleteWallet()
  console.log(chalk.green('✓ Wallet file deleted.'))
}

function printWallet(w: WalletInfo): void {
  console.log()
  console.log(chalk.bold.cyan('  WALLET'))
  console.log(chalk.dim('  ─────────────────────────────────────────────────────'))
  console.log(`  ${chalk.bold('Address')}    ${chalk.white(w.address)}`)
  console.log(`  ${chalk.bold('Key')}        ${chalk.dim('hidden  (run `phantom wallet export` to reveal)')}`)
  console.log(`  ${chalk.bold('File')}       ${chalk.dim('~/.phantom/wallet.json')}`)
  console.log(`  ${chalk.bold('Explorer')}   ${chalk.dim(`https://sepolia.etherscan.io/address/${w.address}`)}`)
  console.log()
}

export async function cmdBalance(address?: string): Promise<void> {
  const w    = address ? { address } : loadOrCreateWallet()
  const spin = (await import('ora')).default('Fetching balances…').start()
  try {
    const [sepoliaBalance, ogRaw] = await Promise.all([
      getEthBalance(w.address),
      getZeroGBalance(w.address).catch(() => null),
    ])
    spin.stop()
    const ethF = parseFloat(sepoliaBalance.eth).toFixed(6)
    const ogF  = ogRaw !== null ? parseFloat(ogRaw).toFixed(6) : 'unavailable'

    console.log()
    console.log(chalk.bold.cyan('  BALANCES'))
    console.log(chalk.dim('  ─────────────────────────────────────────────────────'))
    console.log(`  ${chalk.bold('Address')}   ${chalk.white(w.address)}`)
    console.log()
    console.log(`  ${chalk.bold.dim('Sepolia  (ETH payments)')}`)
    console.log(`  ${chalk.bold('ETH')}       ${chalk.white(ethF)} ETH`)
    console.log()
    console.log(`  ${chalk.bold.dim('0G Galileo  (storage fees)')}`)
    console.log(`  ${chalk.bold('OG')}        ${chalk.white(ogF)} OG`)

    if (parseFloat(ethF) === 0) {
      console.log()
      console.log(chalk.yellow('  💧 Need testnet ETH?'))
      console.log(chalk.dim('     https://cloud.google.com/application/web3/faucet/ethereum/sepolia'))
    }
    if (ogRaw !== null && parseFloat(ogRaw) === 0) {
      console.log()
      console.log(chalk.yellow('  💧 Need OG tokens?  (required for 0G Storage uploads)'))
      console.log(chalk.dim('     https://hub.0g.ai/faucet'))
    }
    console.log()
  } catch (e: unknown) {
    spin.fail(chalk.red(`Failed: ${(e as Error).message}`))
    process.exit(1)
  }
}
