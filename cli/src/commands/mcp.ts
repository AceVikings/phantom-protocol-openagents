/**
 * phantom mcp — start the stdio MCP server
 * phantom mcp config — print Claude Desktop config snippet
 */
import chalk from 'chalk'
import { getDefaultAgent, loadAgent } from '../lib/axl.js'
import { startMcpServer } from '../lib/mcp-server.js'

export async function cmdMcpStart(opts: { agent?: string; role?: string }): Promise<void> {
  // Resolve agent
  const agentId = opts.agent ?? getDefaultAgent()

  if (agentId) {
    const r = loadAgent(agentId)
    if (!r) {
      process.stderr.write(chalk.yellow(`[phantom] Agent ${agentId} not found locally — using global session.\n`))
    } else {
      process.stderr.write(`[phantom] Agent: ${r.agentId} (${r.role})\n`)
    }
  }

  const autoRole = opts.role as 'buyer' | 'seller' | undefined
  if (autoRole && !['buyer', 'seller'].includes(autoRole)) {
    process.stderr.write(`[phantom] Invalid role "${autoRole}" — must be buyer or seller.\n`)
    process.exit(1)
  }
  await startMcpServer(autoRole)
}

export function cmdMcpConfig(): void {
  const agentId = getDefaultAgent()

  const snippet = {
    mcpServers: {
      phantom: {
        command: 'phantom',
        args:    agentId ? ['mcp', '--agent', agentId] : ['mcp'],
        env:     {
          PHANTOM_BACKEND_URL: 'https://phantom-backend-672452518519.us-central1.run.app',
        },
      },
    },
  }

  console.log()
  console.log(chalk.bold('  Claude Desktop — claude_desktop_config.json'))
  console.log(chalk.dim('  ─────────────────────────────────────────────────────'))
  console.log()
  console.log(JSON.stringify(snippet, null, 2).split('\n').map(l => '  ' + l).join('\n'))
  console.log()
  console.log(chalk.dim('  Config file location:'))
  console.log(chalk.dim('    macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json'))
  console.log(chalk.dim('    Windows: %APPDATA%\\Claude\\claude_desktop_config.json'))
  console.log()
  console.log(chalk.dim('  After editing: Restart Claude Desktop (Cmd+Q → reopen)'))
  console.log()
  if (!agentId) {
    console.log(chalk.yellow('  Tip: Run `phantom agent new` first to auto-embed the agent ID.'))
    console.log()
  }
}
