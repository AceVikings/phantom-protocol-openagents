/**
 * phantom deal list|show
 */
import chalk   from 'chalk'
import { api } from '../lib/api.js'
import { getSession } from '../lib/state.js'
import { getBackendUrl } from '../lib/config.js'

function requireSession() {
  const s = getSession()
  if (!s) {
    console.error(chalk.red('No active session. Run `phantom mcp` and call phantom_register, or `phantom agent show`.'))
    process.exit(1)
  }
  return s
}

export async function cmdDealList(): Promise<void> {
  const s    = requireSession()
  const spin = (await import('ora')).default('Fetching deals…').start()
  try {
    const backendUrl = s.backendUrl ?? getBackendUrl()
    const { ok, data } = await api('GET', '/api/deals', undefined, s.apiKey, backendUrl)
    if (!ok) throw new Error(JSON.stringify(data))
    spin.stop()
    const deals = (Array.isArray(data) ? data : (data as { deals?: unknown[] }).deals ?? []) as Array<{
      dealId: string; status: string; priceUSDC?: string; buyerAgentId?: string; sellerAgentId?: string
    }>
    if (!deals.length) {
      console.log(chalk.dim('\n  No active deals.\n'))
      return
    }
    console.log()
    console.log(chalk.bold(`  DEALS (${deals.length})`))
    console.log(chalk.dim('  ─────────────────────────────────────────────────────'))
    for (const d of deals) {
      const price = d.priceUSDC ? ` ${d.priceUSDC} USDC` : ''
      console.log(`  ${chalk.cyan(d.dealId.slice(0, 8))}…  ${statusColor(d.status).padEnd(24)}${price}`)
    }
    console.log()
  } catch (e: unknown) {
    spin.fail(chalk.red((e as Error).message))
    process.exit(1)
  }
}

export async function cmdDealShow(id: string): Promise<void> {
  const s    = requireSession()
  const spin = (await import('ora')).default(`Loading deal ${id.slice(0, 8)}…`).start()
  try {
    const backendUrl = s.backendUrl ?? getBackendUrl()
    const { ok, data } = await api('GET', `/api/deals/${id}`, undefined, s.apiKey, backendUrl) as {
      ok: boolean; data: Record<string, unknown>
    }
    if (!ok) throw new Error(JSON.stringify(data))
    spin.stop()
    console.log()
    console.log(chalk.bold.cyan(`  DEAL  `) + chalk.dim(id))
    console.log(chalk.dim('  ─────────────────────────────────────────────────────'))
    for (const [k, v] of Object.entries(data)) {
      const label = k.replace(/([A-Z])/g, ' $1').trim()
      const val   = k === 'status' ? statusColor(String(v)) : chalk.white(String(v))
      console.log(`  ${chalk.bold(label.padEnd(24))} ${val}`)
    }
    console.log()
  } catch (e: unknown) {
    spin.fail(chalk.red((e as Error).message))
    process.exit(1)
  }
}

function statusColor(status: string): string {
  switch (status.toLowerCase()) {
    case 'pending':    return chalk.yellow(status)
    case 'active':     return chalk.cyan(status)
    case 'locked':     return chalk.blue(status)
    case 'verifying':  return chalk.magenta(status)
    case 'complete':   return chalk.green(status)
    case 'failed':     return chalk.red(status)
    default:           return chalk.white(status)
  }
}
