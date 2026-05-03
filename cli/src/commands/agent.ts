/**
 * phantom agent new|list|show|delete
 */
import chalk      from 'chalk'
import { api }    from '../lib/api.js'
import {
  generateAxlKeypair, saveAgent, loadAgent, listAgents,
  removeAgent, setDefaultAgent, getDefaultAgent, type AgentRecord,
} from '../lib/axl.js'
import { createEphemeralWallet } from '../lib/wallet.js'
import { getBackendUrl }         from '../lib/config.js'

export async function cmdAgentNew(opts: { role?: string; backend?: string }): Promise<void> {
  const role = (opts.role ?? 'seller') as 'buyer' | 'seller'
  const backendUrl = opts.backend ?? getBackendUrl()

  const spin = (await import('ora')).default('Creating agent identity…').start()

  try {
    // Gen Ed25519 keypair + fresh Ethereum wallet
    const { pubkey, privkey } = generateAxlKeypair()
    const wallet = createEphemeralWallet()

    spin.text = 'Registering with coordinator…'

    const { ok, data } = await api(
      'POST', '/api/agents/register',
      {
        axlPubkey:        pubkey,
        ephemeralAddress: wallet.address,
        role,
        capabilities:     [],
        webhookUrl:       null,
      },
      null, backendUrl,
    ) as { ok: boolean; data: { agentId?: string; apiKey?: string; error?: string } }

    if (!ok || !data.agentId || !data.apiKey) {
      spin.fail(chalk.red(`Registration failed: ${data.error ?? JSON.stringify(data)}`))
      process.exit(1)
    }

    const record: AgentRecord = {
      agentId:    data.agentId,
      apiKey:     data.apiKey,
      role,
      axlPubkey:  pubkey,
      axlPrivkey: privkey,
      wallet:     { address: wallet.address, privateKey: wallet.privateKey },
      backendUrl,
      webhookPort: 4040,
      createdAt:   new Date().toISOString(),
    }

    saveAgent(record)
    setDefaultAgent(data.agentId)

    spin.succeed(chalk.green(`Agent created`))
    printAgent(record, true)
  } catch (e: unknown) {
    spin.fail(chalk.red((e as Error).message))
    process.exit(1)
  }
}

export async function cmdAgentList(): Promise<void> {
  const ids     = listAgents()
  const defId   = getDefaultAgent()

  if (!ids.length) {
    console.log(chalk.dim('\n  No agents found. Run `phantom agent new` to create one.\n'))
    return
  }

  console.log()
  console.log(chalk.bold(`  AGENTS (${ids.length})`))
  console.log(chalk.dim('  ─────────────────────────────────────────────────────'))

  for (const id of ids) {
    const r   = loadAgent(id)
    const def = id === defId ? chalk.green(' ★ default') : ''
    if (!r) continue
    console.log(`  ${chalk.cyan(r.agentId.slice(0, 8))}…  ${chalk.bold(r.role.padEnd(6))}  ${chalk.dim(r.wallet.address)}${def}`)
  }
  console.log()
}

export async function cmdAgentShow(id?: string): Promise<void> {
  const resolved = id ?? getDefaultAgent()
  if (!resolved) {
    console.error(chalk.red('No agent specified and no default agent set.'))
    process.exit(1)
  }
  const r = loadAgent(resolved)
  if (!r) {
    console.error(chalk.red(`Agent not found: ${resolved}`))
    process.exit(1)
  }
  printAgent(r, false)
}

export async function cmdAgentDelete(id: string, opts: { yes?: boolean }): Promise<void> {
  const r = loadAgent(id)
  if (!r) {
    console.error(chalk.red(`Agent not found: ${id}`))
    process.exit(1)
  }

  if (!opts.yes) {
    const { createInterface } = await import('node:readline/promises')
    const rl     = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(chalk.yellow(`Delete agent ${id.slice(0, 8)}…? (yes/no): `))
    rl.close()
    if (answer.trim().toLowerCase() !== 'yes') {
      console.log(chalk.dim('Aborted.'))
      return
    }
  }

  // Best-effort deregister on backend
  const spin = (await import('ora')).default('Deregistering…').start()
  try {
    await api('DELETE', `/api/agents/${id}`, undefined, r.apiKey, r.backendUrl)
    spin.succeed('Deregistered from backend')
  } catch {
    spin.warn('Could not deregister from backend (proceeding with local delete)')
  }

  removeAgent(id)
  console.log(chalk.green(`✓ Agent ${id.slice(0, 8)}… deleted`))
}

function printAgent(r: AgentRecord, showKey: boolean): void {
  const masked = showKey ? chalk.yellow(r.apiKey) : chalk.dim(r.apiKey.slice(0, 12) + '…')
  console.log()
  console.log(chalk.bold.cyan(`  AGENT  `) + chalk.dim(`(${r.role})`))
  console.log(chalk.dim('  ─────────────────────────────────────────────────────'))
  console.log(`  ${chalk.bold('Agent ID')}    ${chalk.white(r.agentId)}`)
  console.log(`  ${chalk.bold('API Key')}     ${masked}`)
  console.log(`  ${chalk.bold('AXL Pubkey')} ${chalk.dim(r.axlPubkey)}`)
  console.log(`  ${chalk.bold('Wallet')}      ${chalk.white(r.wallet.address)}`)
  console.log(`  ${chalk.bold('Backend')}     ${chalk.dim(r.backendUrl)}`)
  console.log(`  ${chalk.bold('Created')}     ${chalk.dim(r.createdAt)}`)
  if (showKey) {
    console.log()
    console.log(chalk.dim('  Run `phantom mcp` to start the MCP server with this agent.'))
  }
  console.log()
}
