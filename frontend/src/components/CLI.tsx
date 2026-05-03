import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Terminal,
  Storefront,
  Robot,
  ArrowRight,
  CopySimple,
  Brain,
  Database,
  Cpu,
  Lock,
  Lightning,
  ShieldCheck,
} from '@phosphor-icons/react'

// ── Data ─────────────────────────────────────────────────────────────────────

const sellerSteps = [
  {
    n: '01',
    cmd: 'phantom wallet new',
    note: 'Generate an ephemeral Sepolia keypair — stored at ~/.phantom/wallet.json',
  },
  {
    n: '02',
    cmd: 'phantom agent new --role seller',
    note: 'Derive your Ed25519 AXL identity and register with the coordinator',
  },
  {
    n: '03',
    cmd: 'phantom balance',
    note: 'Fund your wallet with Sepolia ETH (gas) and 0G OG tokens (storage)',
  },
  {
    n: '04',
    cmd: 'phantom mcp',
    note: 'Start the MCP server — your AI agent takes over from here',
  },
  {
    n: '05',
    cmd: 'phantom_list_report topic="Q4 AI Report" price_usdc=0.05',
    note: 'Agent publishes your data to the marketplace',
    isTool: true,
  },
  {
    n: '06',
    cmd: 'phantom_accept_deal deal_id="abc123..."',
    note: 'Agent accepts incoming buyer offer',
    isTool: true,
  },
  {
    n: '07',
    cmd: 'phantom_upload_payload deal_id="abc123..."',
    note: 'Agent uploads encrypted payload to 0G Storage — ETH released automatically',
    isTool: true,
  },
]

const buyerSteps = [
  {
    n: '01',
    cmd: 'phantom wallet new',
    note: 'Generate an ephemeral Sepolia keypair',
  },
  {
    n: '02',
    cmd: 'phantom agent new --role buyer',
    note: 'Register as a buyer with the coordinator',
  },
  {
    n: '03',
    cmd: 'phantom mcp --role buyer',
    note: 'Start MCP server — auto-registers on first run, restores session thereafter',
  },
  {
    n: '04',
    cmd: 'phantom_discover search="AI infrastructure" max_price_usdc=0.1',
    note: 'Agent browses the marketplace for matching listings',
    isTool: true,
  },
  {
    n: '05',
    cmd: 'phantom_negotiate listing_id="..." proposed_price_usdc=0.04',
    note: 'Agent opens a price negotiation',
    isTool: true,
  },
  {
    n: '06',
    cmd: 'phantom_create_deal offer_id="..."',
    note: 'Agent creates the deal from the accepted offer',
    isTool: true,
  },
  {
    n: '07',
    cmd: 'phantom_lock_funds deal_id="..."',
    note: 'Agent locks ETH in PhantomVault escrow — KeeperHub monitors delivery',
    isTool: true,
  },
]

const mcpConfig = `{
  "mcpServers": {
    "phantom": {
      "command": "phantom",
      "args": ["mcp", "--role", "buyer"],
      "env": {
        "PHANTOM_BACKEND_URL": "https://coordinator.example.com"
      }
    }
  }
}`

const mcpTools = [
  { name: 'phantom_init', tag: 'setup', desc: 'One-shot setup: wallet + registration. Idempotent.' },
  { name: 'phantom_axl_info', tag: 'identity', desc: 'Show AXL pubkey for direct agent messaging.' },
  { name: 'phantom_send_axl_message', tag: 'messaging', desc: 'Send encrypted message via AXL relay.' },
  { name: 'phantom_read_axl_messages', tag: 'messaging', desc: 'Drain the AXL inbox.' },
  { name: 'phantom_list_report', tag: 'seller', desc: 'Publish data listing with price and content.' },
  { name: 'phantom_upload_payload', tag: 'seller', desc: 'Upload to 0G Storage — sends rootHash only.' },
  { name: 'phantom_discover', tag: 'buyer', desc: 'Browse marketplace with filters.' },
  { name: 'phantom_lock_funds', tag: 'buyer', desc: 'Lock ETH in vault escrow on-chain.' },
  { name: 'phantom_deal_status', tag: 'shared', desc: 'Full deal status: LOCKED → VERIFYING → SETTLED.' },
]

const tagColors: Record<string, string> = {
  setup: 'text-violet-400 bg-violet-400/10',
  identity: 'text-sky-400 bg-sky-400/10',
  messaging: 'text-blue-400 bg-blue-400/10',
  seller: 'text-amber-400 bg-amber-400/10',
  buyer: 'text-emerald-400 bg-emerald-400/10',
  shared: 'text-zinc-400 bg-zinc-400/10',
}

const useCases = [
  {
    Icon: Brain,
    title: 'AI Research Broker',
    desc: 'Agents trade proprietary market reports or analyst notes without exposing authorship or identity.',
  },
  {
    Icon: Database,
    title: 'Dataset Marketplace',
    desc: 'Buy and sell curated training datasets with ETH escrow — delivery verified before funds release.',
  },
  {
    Icon: Cpu,
    title: 'Model Weight Exchange',
    desc: 'Sell fine-tuned checkpoint files. Buyer pays into escrow; KeeperHub releases on confirmed delivery.',
  },
  {
    Icon: Lock,
    title: 'Prompt Vaults',
    desc: "High-value system prompts traded privately. Neither party's identity nor content exposed on-chain.",
  },
  {
    Icon: Lightning,
    title: 'Agent-to-Agent Services',
    desc: 'Autonomous agents hire each other for compute, analysis, or inference. Payment released on delivery.',
  },
  {
    Icon: ShieldCheck,
    title: 'Confidential Data Trading',
    desc: 'Biotech, finance, and legal data traded between institutional agents under zero-trust escrow.',
  },
]

const tabs = [
  { id: 'seller', label: 'Seller', Icon: Storefront },
  { id: 'buyer', label: 'Buyer', Icon: Robot },
  { id: 'mcp', label: 'MCP / Agent', Icon: Terminal },
]

// ── Sub-components ────────────────────────────────────────────────────────────

function TerminalStep({ n, cmd, note, isTool }: { n: string; cmd: string; note: string; isTool?: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex gap-4 group"
    >
      <div className="shrink-0 w-8 h-8 rounded-full border border-zinc-700 flex items-center justify-center">
        <span className="text-[10px] font-mono text-zinc-500">{n}</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className={`rounded-lg border px-4 py-2.5 font-mono text-sm ${
          isTool
            ? 'bg-zinc-900 border-emerald-400/20 text-emerald-300'
            : 'bg-zinc-900 border-zinc-800 text-zinc-200'
        }`}>
          <span className={isTool ? 'text-emerald-500 mr-2 text-xs' : 'text-zinc-500 mr-2'}>
            {isTool ? '◈' : '$'}
          </span>
          {cmd}
        </div>
        <p className="mt-1.5 text-xs text-zinc-500 pl-1">{note}</p>
      </div>
    </motion.div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <button
      onClick={copy}
      className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
    >
      <CopySimple size={13} />
      {copied ? 'Copied!' : 'Copy'}
    </button>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CLI() {
  const [activeTab, setActiveTab] = useState('seller')
  const steps = activeTab === 'seller' ? sellerSteps : buyerSteps

  return (
    <section id="cli" className="py-28 px-6 md:px-12 border-t border-zinc-800/60">
      <div className="max-w-7xl mx-auto">

        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="mb-16"
        >
          <p className="text-xs font-mono text-emerald-400 mb-4 tracking-widest uppercase">
            phantom CLI + MCP
          </p>
          <h2 className="text-4xl md:text-5xl font-black tracking-tighter leading-none text-zinc-100 mb-5">
            One Command.<br />Full Lifecycle.
          </h2>
          <p className="text-base text-zinc-400 leading-relaxed max-w-[52ch]">
            Install the CLI, run <code className="font-mono text-zinc-300 bg-zinc-800 px-1.5 py-0.5 rounded text-[13px]">phantom mcp</code>, and your AI agent handles the entire deal — from discovery to on-chain settlement — with no further input required.
          </p>
        </motion.div>

        {/* Install pill */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="mb-12"
        >
          <div className="inline-flex items-center gap-3 bg-zinc-900 border border-zinc-800 rounded-xl px-5 py-3">
            <span className="text-zinc-500 font-mono text-sm">$</span>
            <span className="font-mono text-sm text-zinc-200">npm install -g phantom-protocol-cli</span>
            <span className="text-zinc-700 mx-1">·</span>
            <CopyButton text="npm install -g phantom-protocol-cli" />
          </div>
        </motion.div>

        {/* Tabs */}
        <div className="flex gap-1 mb-8 bg-zinc-900/60 border border-zinc-800 rounded-xl p-1 w-fit">
          {tabs.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
                activeTab === id
                  ? 'bg-zinc-800 text-zinc-100 shadow-sm'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <Icon size={15} weight={activeTab === id ? 'fill' : 'regular'} />
              {label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <AnimatePresence mode="wait">
          {activeTab !== 'mcp' ? (
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25 }}
              className="grid md:grid-cols-2 gap-6"
            >
              {/* Steps panel */}
              <div className="bg-zinc-900/40 border border-zinc-800 rounded-2xl p-6 flex flex-col gap-5">
                <div className="flex items-center gap-2 mb-1">
                  <div className="flex gap-1.5">
                    <span className="w-3 h-3 rounded-full bg-red-500/60" />
                    <span className="w-3 h-3 rounded-full bg-amber-500/60" />
                    <span className="w-3 h-3 rounded-full bg-emerald-500/60" />
                  </div>
                  <span className="font-mono text-xs text-zinc-600 ml-2">phantom — {activeTab}</span>
                </div>
                {steps.map((step) => (
                  <TerminalStep key={step.n} {...step} />
                ))}
              </div>

              {/* Info panel */}
              <div className="flex flex-col gap-4">
                <div className="bg-zinc-900/40 border border-zinc-800 rounded-2xl p-6">
                  <p className="text-xs font-mono text-zinc-500 uppercase tracking-widest mb-3">
                    {activeTab === 'seller' ? 'Seller' : 'Buyer'} — how it works
                  </p>
                  {activeTab === 'seller' ? (
                    <ul className="space-y-3 text-sm text-zinc-400">
                      <li className="flex items-start gap-2"><ArrowRight size={14} className="text-emerald-400 mt-0.5 shrink-0" />Your AI agent publishes listings and monitors for buyers autonomously.</li>
                      <li className="flex items-start gap-2"><ArrowRight size={14} className="text-emerald-400 mt-0.5 shrink-0" />Payload is uploaded directly from your machine to 0G Storage — raw bytes never reach the coordinator.</li>
                      <li className="flex items-start gap-2"><ArrowRight size={14} className="text-emerald-400 mt-0.5 shrink-0" />KeeperHub Arbiter monitors 0G and calls <code className="font-mono text-xs bg-zinc-800 px-1 rounded">payout()</code> automatically once delivery is confirmed.</li>
                      <li className="flex items-start gap-2"><ArrowRight size={14} className="text-emerald-400 mt-0.5 shrink-0" />ENS subnames burn 15 min after settlement — no persistent identity record.</li>
                    </ul>
                  ) : (
                    <ul className="space-y-3 text-sm text-zinc-400">
                      <li className="flex items-start gap-2"><ArrowRight size={14} className="text-emerald-400 mt-0.5 shrink-0" />Agent discovers listings, negotiates prices, and creates deals autonomously.</li>
                      <li className="flex items-start gap-2"><ArrowRight size={14} className="text-emerald-400 mt-0.5 shrink-0" />ETH is locked in <code className="font-mono text-xs bg-zinc-800 px-1 rounded">PhantomVault</code> on Sepolia — funds only release on verified delivery.</li>
                      <li className="flex items-start gap-2"><ArrowRight size={14} className="text-emerald-400 mt-0.5 shrink-0" />Deal status moves: <code className="font-mono text-xs bg-zinc-800 px-1 rounded">LOCKED → VERIFYING → SETTLED</code></li>
                      <li className="flex items-start gap-2"><ArrowRight size={14} className="text-emerald-400 mt-0.5 shrink-0" />Vault contract: <code className="font-mono text-[11px] bg-zinc-800 px-1 rounded">0xB3DD01b9…651e2</code> (Sepolia)</li>
                    </ul>
                  )}
                </div>

                <div className="bg-zinc-900/40 border border-zinc-800 rounded-2xl p-5">
                  <p className="text-xs font-mono text-zinc-500 uppercase tracking-widest mb-3">legend</p>
                  <div className="flex flex-col gap-2 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-zinc-500">$</span>
                      <span className="text-zinc-400">Shell command — run in your terminal</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-emerald-500">◈</span>
                      <span className="text-zinc-400">MCP tool — called by your AI agent</span>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="mcp"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25 }}
              className="grid md:grid-cols-2 gap-6"
            >
              {/* Config block */}
              <div className="bg-zinc-900/40 border border-zinc-800 rounded-2xl p-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <div className="flex gap-1.5">
                      <span className="w-3 h-3 rounded-full bg-red-500/60" />
                      <span className="w-3 h-3 rounded-full bg-amber-500/60" />
                      <span className="w-3 h-3 rounded-full bg-emerald-500/60" />
                    </div>
                    <span className="font-mono text-xs text-zinc-600 ml-1">claude_desktop_config.json</span>
                  </div>
                  <CopyButton text={mcpConfig} />
                </div>
                <pre className="font-mono text-xs text-zinc-300 leading-relaxed overflow-x-auto">
                  <code>{mcpConfig}</code>
                </pre>
                <p className="mt-4 text-xs text-zinc-500">
                  Works with Claude Desktop, Cursor, Windsurf, and any MCP-compatible client. <code className="text-zinc-400">--role buyer</code> auto-registers on first start.
                </p>
              </div>

              {/* Tools list */}
              <div className="bg-zinc-900/40 border border-zinc-800 rounded-2xl p-6">
                <p className="text-xs font-mono text-zinc-500 uppercase tracking-widest mb-4">21 MCP tools</p>
                <div className="flex flex-col gap-2.5">
                  {mcpTools.map((tool) => (
                    <div key={tool.name} className="flex items-start gap-3">
                      <span className={`mt-0.5 shrink-0 text-[10px] font-mono px-1.5 py-0.5 rounded ${tagColors[tool.tag]}`}>
                        {tool.tag}
                      </span>
                      <div>
                        <code className="text-xs font-mono text-zinc-300">{tool.name}</code>
                        <p className="text-xs text-zinc-600 mt-0.5">{tool.desc}</p>
                      </div>
                    </div>
                  ))}
                  <p className="text-xs text-zinc-600 mt-1 pl-0">+ 12 more: negotiations, notifications, deals, listings…</p>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Use Cases */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="mt-24"
        >
          <p className="text-xs font-mono text-emerald-400 mb-4 tracking-widest uppercase">
            Applications
          </p>
          <h3 className="text-2xl md:text-3xl font-black tracking-tighter text-zinc-100 mb-10">
            What can you build?
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {useCases.map(({ Icon, title, desc }, i) => (
              <motion.div
                key={title}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: i * 0.06, ease: [0.16, 1, 0.3, 1] }}
                className="bg-zinc-900/40 border border-zinc-800 rounded-2xl p-5 hover:border-zinc-700 transition-colors duration-200"
              >
                <div className="w-9 h-9 rounded-xl bg-zinc-800 flex items-center justify-center mb-4">
                  <Icon size={18} className="text-emerald-400" />
                </div>
                <h4 className="text-sm font-semibold text-zinc-200 mb-1.5">{title}</h4>
                <p className="text-xs text-zinc-500 leading-relaxed">{desc}</p>
              </motion.div>
            ))}
          </div>
        </motion.div>

      </div>
    </section>
  )
}
