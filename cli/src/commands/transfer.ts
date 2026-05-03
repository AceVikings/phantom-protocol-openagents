/**
 * phantom transfer eth — send ETH from the default wallet
 */
import chalk from 'chalk'
import { loadOrCreateWallet } from '../lib/wallet.js'
import { transferEth }        from '../lib/vault.js'

export async function cmdTransferEth(to: string, amount: string): Promise<void> {
  const wallet = loadOrCreateWallet()
  const spin   = (await import('ora')).default(`Sending ${amount} ETH to ${to}…`).start()
  try {
    const { txHash } = await transferEth({ to, amountEth: amount, privateKey: wallet.privateKey })
    spin.succeed(chalk.green(`ETH sent`))
    printTx({ to, amount, symbol: 'ETH', txHash, from: wallet.address })
  } catch (e: unknown) {
    spin.fail(chalk.red(`Transfer failed: ${(e as Error).message}`))
    process.exit(1)
  }
}


function printTx(opts: { from: string; to: string; amount: string; symbol: string; txHash: string }): void {
  console.log()
  console.log(chalk.dim('  ─────────────────────────────────────────────────────'))
  console.log(`  ${chalk.bold('From')}      ${chalk.dim(opts.from)}`)
  console.log(`  ${chalk.bold('To')}        ${chalk.white(opts.to)}`)
  console.log(`  ${chalk.bold('Amount')}    ${chalk.white(opts.amount)} ${opts.symbol}`)
  console.log(`  ${chalk.bold('Tx')}        ${chalk.cyan(opts.txHash)}`)
  console.log(`  ${chalk.bold('Explorer')} ${chalk.dim(`https://sepolia.etherscan.io/tx/${opts.txHash}`)}`)
  console.log()
}
