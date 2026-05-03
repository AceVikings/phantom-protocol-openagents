import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text, useApp, useInput, useStdout } from 'ink'
import { Header }   from './components/Header.js'
import { LogPane }  from './components/LogPane.js'
import { InputBar } from './components/InputBar.js'
import { webhookBus }        from './lib/webhookBus.js'
import { startWebhookServer } from './lib/webhook.js'
import { loadOrCreateWallet } from './lib/wallet.js'
import { pingOllama }         from './lib/llm.js'
import { api }                from './lib/api.js'
import { chat }               from './lib/llm.js'
import {
  cmdWallet, cmdBalance, cmdHelp, randomAxlPubkey, ts,
  type LogLine, type LogColor, type AgentContext, type CommandContext,
} from './commands/shared.js'
import { cmdResearch, cmdList, cmdDeals as sellerDeals, handleSellerWebhook } from './commands/seller.js'
import { cmdDiscover, cmdNegotiate, cmdBuy, cmdDeals as buyerDeals, handleBuyerWebhook } from './commands/buyer.js'

// ── Spinner frames ────────────────────────────────────────────────────────────
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const HEADER_ROWS = 3   // border top + content + border bottom
const INPUT_ROWS  = 3   // border top + content + border bottom

let _logSeq = 0
function nextId() { return ++_logSeq * 1000 + Date.now() % 1000 }

// ── LLM history per-session ───────────────────────────────────────────────────
const SELLER_SYSTEM = `You are a sharp research analyst working inside the Phantom Protocol data marketplace. Help the user with research topics, pricing strategy, and marketplace intelligence. Be concise.`
const BUYER_SYSTEM  = `You are a savvy procurement agent working inside the Phantom Protocol data marketplace. Help the user discover data, negotiate prices, and evaluate listings. Be concise.`

// ── Props ─────────────────────────────────────────────────────────────────────

type HistoryMsg = { role: 'system' | 'user' | 'assistant'; content: string }

export interface AppProps {
  role:        'seller' | 'buyer'
  provider:    'ollama' | 'openai'
  backendUrl:  string
  webhookPort: number
  ollamaModel: string
  ollamaHost:  string
  openaiKey:   string
  openaiModel: string
}

// ── App ───────────────────────────────────────────────────────────────────────

export function App(props: AppProps) {
  const { role, provider, backendUrl, webhookPort, ollamaModel, ollamaHost, openaiKey, openaiModel } = props

  const { stdout }  = useStdout()
  const { exit }    = useApp()
  const cols        = stdout.columns || 100
  const rows        = stdout.rows    || 30
  const logHeight   = Math.max(rows - HEADER_ROWS - INPUT_ROWS - 2, 4)

  // ── State ──────────────────────────────────────────────────────────────────
  const [logs,    setLogs]    = useState<LogLine[]>([])
  const [input,   setInput]   = useState('')
  const [busy,    setBusy]    = useState(false)
  const [spinner, setSpinner] = useState(FRAMES[0]!)
  const [phase,   setPhase]   = useState<'connecting' | 'ready' | 'error'>('connecting')
  const [agentId, setAgentId] = useState<string | null>(null)
  const [walletAddr, setWalletAddr] = useState<string | null>(null)
  const [modelName, setModelName]   = useState(provider === 'openai' ? openaiModel : ollamaModel)

  const agentCtxRef = useRef<AgentContext>({
    apiKey: null, agentId: null, ephemeralAddress: null, wallet: null,
  })

  const historyRef = useRef<HistoryMsg[]>([
    { role: 'system', content: role === 'seller' ? SELLER_SYSTEM : BUYER_SYSTEM },
  ])

  // ── Spinner timer ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!busy) return
    let i = 0
    const id = setInterval(() => {
      i = (i + 1) % FRAMES.length
      setSpinner(FRAMES[i]!)
    }, 80)
    return () => clearInterval(id)
  }, [busy])

  // ── addLog ─────────────────────────────────────────────────────────────────
  const addLog = useCallback((content: string, color?: LogColor) => {
    setLogs(prev => [...prev, { id: nextId(), ts: ts(), content, color }])
  }, [])

  // ── Build CommandContext ───────────────────────────────────────────────────
  const buildCtx = useCallback((): CommandContext => ({
    role, provider, backendUrl,
    ollamaHost, ollamaModel, openaiKey, openaiModel,
    agentCtx: agentCtxRef.current,
    addLog,
    exit,
  }), [role, provider, backendUrl, ollamaHost, ollamaModel, openaiKey, openaiModel, addLog, exit])

  // ── Command dispatch ───────────────────────────────────────────────────────
  const dispatch = useCallback(async (raw: string) => {
    const line    = raw.trim()
    if (!line) return
    const isSlash = line.startsWith('/')
    const parts   = (isSlash ? line.slice(1) : line).split(/\s+/)
    const cmd     = (parts[0] ?? '').toLowerCase()
    const rest    = parts.slice(1)
    const ctx     = buildCtx()

    // ── Shared commands ──
    if (cmd === 'exit' || cmd === 'quit') { addLog('Goodbye.', 'dim'); setTimeout(exit, 300); return }
    if (cmd === 'help')    { cmdHelp(role, addLog); return }
    if (cmd === 'wallet')  { await cmdWallet(ctx);  return }
    if (cmd === 'balance') { await cmdBalance(ctx); return }
    if (cmd === 'deals')   {
      await (role === 'seller' ? sellerDeals(ctx) : buyerDeals(ctx))
      return
    }

    // ── Role-specific commands ──
    if (role === 'seller') {
      if (cmd === 'research') { await cmdResearch(rest.join(' '), ctx); return }
      if (cmd === 'list')     { await cmdList(ctx);                     return }
    } else {
      if (cmd === 'discover')  { await cmdDiscover(rest[0] ?? '', ctx);           return }
      if (cmd === 'negotiate') { await cmdNegotiate(rest[0] ?? '', rest[1], ctx); return }
      if (cmd === 'buy')       { await cmdBuy(rest[0] ?? '', ctx);                return }
    }

    // ── LLM chat (anything else) ──
    const userMsg = line
    addLog(`You: ${userMsg}`, 'dim')
    historyRef.current.push({ role: 'user' as const, content: userMsg })
    let reply = ''
    try {
      reply = await chat(historyRef.current, {
        provider, ollamaHost, ollamaModel, openaiKey, openaiModel,
        onToken: (tok) => { reply += tok },
      })
    } catch (err: unknown) {
      addLog(`LLM error: ${(err as Error).message}`, 'red')
      historyRef.current.pop()
      return
    }
    historyRef.current.push({ role: 'assistant' as const, content: reply })
    addLog('─────────────────────────────────────────', 'dim')
    for (const l of reply.split('\n').slice(0, 20)) addLog('  ' + l, 'white')
    addLog('─────────────────────────────────────────', 'dim')
  }, [buildCtx, role, addLog, exit, provider, ollamaHost, ollamaModel, openaiKey, openaiModel])

  // ── Keyboard input ─────────────────────────────────────────────────────────
  useInput((char, key) => {
    if (key.ctrl && char === 'c') { exit(); return }

    if (key.return) {
      if (!input.trim() || busy) return
      const cmd = input
      setInput('')
      setBusy(true)
      dispatch(cmd).finally(() => setBusy(false))
      return
    }

    if (key.backspace || key.delete) {
      setInput(v => v.slice(0, -1))
      return
    }

    if (char && !key.ctrl && !key.meta && !key.escape) {
      setInput(v => v + char)
    }
  })

  // ── Initialization ─────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    async function init() {
      addLog('Phantom Protocol Agent CLI', 'cyan')
      addLog(`Role: ${role}  │  Provider: ${provider}  │  Model: ${modelName}`, 'dim')
      addLog('─────────────────────────────────────────', 'dim')

      // Load / create wallet
      const walletInfo = loadOrCreateWallet()
      agentCtxRef.current.wallet = walletInfo
      if (!cancelled) setWalletAddr(walletInfo.address)
      addLog(`Wallet: ${walletInfo.address}`, 'dim')

      // Ping Ollama
      if (provider === 'ollama') {
        addLog(`Checking Ollama (${ollamaModel})…`, 'dim')
        const ping = await pingOllama(ollamaHost, ollamaModel)
        if (ping.ok) {
          addLog(`✓ Ollama connected  [${ping.models.slice(0, 3).join(', ')}]`, 'green')
        } else {
          addLog(`⚠ Ollama: ${ping.error}`, 'yellow')
          addLog(`  Run: ollama pull ${ollamaModel}`, 'dim')
        }
      }

      // Start webhook server
      addLog(`Starting webhook server on :${webhookPort}…`, 'dim')
      try {
        await startWebhookServer(webhookPort)
        addLog(`✓ Webhook server ready  http://localhost:${webhookPort}/webhook`, 'green')
      } catch (err: unknown) {
        addLog(`✗ Webhook server failed: ${(err as Error).message}`, 'red')
      }

      // Register agent
      addLog('Registering with coordinator…', 'dim')
      const regRes = await api(
        'POST',
        '/api/agents/register',
        {
          axlPubkey:        randomAxlPubkey(),
          ephemeralAddress: walletInfo.address,
          role,
          capabilities:     [],
          webhookUrl:       `http://localhost:${webhookPort}/webhook`,
        },
        null,
        backendUrl,
      ) as { ok: boolean; data: { agentId?: string; apiKey?: string } }

      if (!cancelled) {
        if (regRes.ok && regRes.data.agentId) {
          const { agentId: aid, apiKey } = regRes.data
          agentCtxRef.current.agentId = aid!
          agentCtxRef.current.apiKey  = apiKey!
          setAgentId(aid!)
          setPhase('ready')
          addLog(`✓ Registered  agentId: ${aid!.slice(0, 8)}…`, 'green')
        } else {
          setPhase('error')
          addLog(`✗ Registration failed: ${JSON.stringify(regRes.data)}`, 'red')
          addLog(`  Is the backend running at ${backendUrl}?`, 'yellow')
        }
      }

      addLog('─────────────────────────────────────────', 'dim')
      addLog(`Type /help for commands.  Ctrl+C to exit.`, 'dim')
    }

    init().catch(err => {
      if (!cancelled) {
        addLog(`Fatal: ${err.message}`, 'red')
        setPhase('error')
      }
    })

    // Subscribe to webhook events
    const onEvent = (event: Record<string, unknown>) => {
      const ctx = buildCtx()
      if (role === 'seller') {
        handleSellerWebhook(event, ctx).catch(err => addLog(`Webhook error: ${err.message}`, 'red'))
      } else {
        handleBuyerWebhook(event, ctx).catch(err => addLog(`Webhook error: ${err.message}`, 'red'))
      }
    }
    webhookBus.on('event', onEvent)

    return () => {
      cancelled = true
      webhookBus.off('event', onEvent)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Header
        role={role}
        model={modelName}
        provider={provider}
        agentId={agentId}
        wallet={walletAddr}
        phase={phase}
        columns={cols}
      />

      <LogPane
        logs={logs}
        height={logHeight}
        columns={cols}
      />

      <InputBar
        value={input}
        busy={busy}
        spinner={spinner}
        columns={cols}
        role={role}
      />
    </Box>
  )
}
