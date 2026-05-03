/**
 * phantom — Phantom Protocol Agent CLI
 *
 * Usage:
 *   phantom --role seller                    # Ollama gemma4:latest (default)
 *   phantom --role buyer  --openai           # OpenAI gpt-4o-mini
 *   phantom --role seller --model gemma3:latest
 *   phantom --role buyer  --backend http://my-server:3001
 *   OPENAI_API_KEY=sk-... phantom --role seller --openai
 *
 * Slash commands (once inside the TUI):
 *   /help               — show available commands
 *   /wallet             — display this session's wallet address
 *   /balance            — show ETH + USDC balance on Sepolia
 *   /research <topic>   — (seller) generate a research report
 *   /list               — (seller) show active listings
 *   /discover [cat]     — (buyer)  browse listings
 *   /negotiate <id>     — (buyer)  open AI-assisted negotiation
 *   /buy <id>           — (buyer)  buy at listed price
 *   /deals              — show active deals
 *   /exit               — quit
 */
import 'dotenv/config'
import React from 'react'
import { render } from 'ink'
import { App } from './App.js'

const argv = process.argv.slice(2)

function flag(name: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && argv[i + 1] !== undefined) return argv[i + 1]!
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1)
  }
  return null
}

const role         = (flag('--role')         ?? 'buyer') as 'seller' | 'buyer'
const provider     = argv.includes('--openai') ? 'openai' : 'ollama' as const
const backendUrl   = flag('--backend')   ?? process.env.BACKEND_URL    ?? 'http://localhost:3001'
const webhookPort  = Number(flag('--port') ?? (role === 'seller' ? '3002' : '3003'))
const ollamaModel  = flag('--model')     ?? process.env.OLLAMA_MODEL   ?? 'gemma4:latest'
const ollamaHost   = flag('--ollama-host') ?? process.env.OLLAMA_HOST  ?? 'http://localhost:11434'
const openaiKey    = flag('--openai-key')  ?? process.env.OPENAI_API_KEY ?? ''
const openaiModel  = flag('--openai-model') ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini'

render(
  <App
    role={role}
    provider={provider}
    backendUrl={backendUrl}
    webhookPort={webhookPort}
    ollamaModel={ollamaModel}
    ollamaHost={ollamaHost}
    openaiKey={openaiKey}
    openaiModel={openaiModel}
  />,
  { exitOnCtrlC: false },
)
