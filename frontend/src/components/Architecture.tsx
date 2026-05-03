import { useState, useEffect, memo } from 'react'
import { motion } from 'framer-motion'
import { Fingerprint, Network, Database, ArrowsLeftRight, Timer } from '@phosphor-icons/react'

// ─── Micro-animation: ENS cycles through burner vault names ──────────────────
const BurnerVaultAnim = memo(function BurnerVaultAnim() {
  const names = ['buyer-92.phantom.eth', 'seller-44.phantom.eth', 'deal-vault.phantom.eth']
  const [idx, setIdx] = useState(0)

  useEffect(() => {
    const t = setInterval(() => setIdx((p) => (p + 1) % names.length), 2100)
    return () => clearInterval(t)
  }, [names.length])

  return (
    <div className="mt-5 flex flex-col gap-2">
      {names.map((name, i) => (
        <motion.div
          key={name}
          animate={{ opacity: idx === i ? 1 : 0.25 }}
          transition={{ duration: 0.4 }}
          className="flex items-center gap-2"
        >
          <motion.span
            animate={{ scale: idx === i ? [1, 1.6, 1] : 1 }}
            transition={{ duration: 1.2, repeat: idx === i ? Infinity : 0 }}
            className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block flex-shrink-0"
          />
          <span className="text-[11px] font-mono text-zinc-400 truncate">{name}</span>
        </motion.div>
      ))}
    </div>
  )
})

// ─── Micro-animation: AXL shows pulsing network nodes ────────────────────────
const DarkTunnelAnim = memo(function DarkTunnelAnim() {
  return (
    <div className="mt-5 flex items-center justify-between px-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col items-center gap-2">
          <motion.div
            animate={{ scale: [1, 1.4, 1], opacity: [0.4, 1, 0.4] }}
            transition={{ duration: 1.8, repeat: Infinity, delay: i * 0.6 }}
            className="w-3 h-3 rounded-full border border-emerald-400/60 bg-emerald-400/10"
          />
          {i < 2 && (
            <motion.div
              animate={{ scaleX: [0.6, 1, 0.6] }}
              transition={{ duration: 1.8, repeat: Infinity, delay: i * 0.6 }}
              className="w-16 h-px bg-emerald-400/20 origin-left"
              style={{ position: 'absolute', left: `${24 + i * 38}%` }}
            />
          )}
        </div>
      ))}
    </div>
  )
})

// ─── Micro-animation: 0G shows upload progress filling ───────────────────────
const WhisperBoxAnim = memo(function WhisperBoxAnim() {
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    const t = setInterval(() => {
      setProgress((p) => {
        if (p >= 100) return 0
        return p + 3
      })
    }, 60)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="mt-5">
      <div className="flex justify-between mb-1.5">
        <span className="text-[10px] font-mono text-zinc-600">ciphertext.bin</span>
        <span className="text-[10px] font-mono text-emerald-400">{progress}%</span>
      </div>
      <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
        <motion.div
          className="h-full bg-emerald-400 rounded-full"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  )
})

// ─── Micro-animation: ETH lock in vault ────────────────────────────────────
const EthEscrowAnim = memo(function EthEscrowAnim() {
  const [locked, setLocked] = useState(false)

  useEffect(() => {
    const t = setInterval(() => setLocked((p) => !p), 2000)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="mt-5 flex items-center justify-between">
      <motion.div
        animate={{ opacity: locked ? 0.4 : 1 }}
        transition={{ duration: 0.5 }}
        className="flex flex-col items-center gap-1"
      >
        <span className="text-[10px] font-mono text-zinc-400">BUYER</span>
        <div className="w-8 h-8 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center">
          <span className="text-[10px] font-bold text-zinc-300">Ξ</span>
        </div>
      </motion.div>

      <motion.div
        animate={{ rotate: locked ? 0 : 180 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      >
        <ArrowsLeftRight size={16} className="text-emerald-400" />
      </motion.div>

      <motion.div
        animate={{ opacity: locked ? 1 : 0.4 }}
        transition={{ duration: 0.5 }}
        className="flex flex-col items-center gap-1"
      >
        <span className="text-[10px] font-mono text-zinc-400">VAULT</span>
        <div className="w-8 h-8 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center">
          <span className="text-[10px] font-bold text-emerald-400">{locked ? '🔒' : '🔓'}</span>
        </div>
      </motion.div>
    </div>
  )
})

// ─── Micro-animation: KeeperHub countdown ────────────────────────────────────
const KeeperAnim = memo(function KeeperAnim() {
  const [seconds, setSeconds] = useState(900)

  useEffect(() => {
    const t = setInterval(() => {
      setSeconds((s) => (s <= 0 ? 900 : s - 1))
    }, 80)
    return () => clearInterval(t)
  }, [])

  const mins = String(Math.floor(seconds / 60)).padStart(2, '0')
  const secs = String(seconds % 60).padStart(2, '0')

  return (
    <div className="mt-5 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <motion.div
          animate={{ scale: [1, 1.3, 1], opacity: [0.7, 1, 0.7] }}
          transition={{ duration: 1.2, repeat: Infinity }}
          className="w-2 h-2 rounded-full bg-emerald-400"
        />
        <span className="text-xs font-mono text-zinc-400">Arbiter monitoring 0G...</span>
      </div>
      <div className="flex items-center gap-3">
        <div className="w-2 h-2 rounded-full bg-zinc-700" />
        <span className="text-xs font-mono text-zinc-600">
          Janitor fires in{' '}
          <span className="text-emerald-400">
            {mins}:{secs}
          </span>
        </span>
      </div>
    </div>
  )
})

// ─── Card definitions ─────────────────────────────────────────────────────────
const cards = [
  {
    id: 'ens',
    badge: 'ENS',
    colClass: 'col-span-6 md:col-span-4',
    Icon: Fingerprint,
    title: 'Burner Vaults',
    description:
      'Instead of trading as alice.eth, the protocol programmatically mints temporary triads: buyer-92.phantom.eth, seller-44.phantom.eth, and deal-vault.phantom.eth — identities that burn the moment the deal closes.',
    Anim: BurnerVaultAnim,
  },
  {
    id: 'axl',
    badge: 'GENSYN AXL',
    colClass: 'col-span-6 md:col-span-2',
    Icon: Network,
    title: 'P2P Dark Tunnel',
    description:
      'Price, file size, and decryption keys are negotiated via an AXL E2E encrypted tunnel. No central server ever sees the terms of the deal.',
    Anim: DarkTunnelAnim,
  },
  {
    id: 'zg',
    badge: '0G',
    colClass: 'col-span-6 md:col-span-1',
    Icon: Database,
    title: 'Whisper Box',
    description: 'Encrypted payload delivery via 0G Storage. Compute verifies the hash without exposing plaintext.',
    Anim: WhisperBoxAnim,
  },
  {
    id: 'escrow',
    badge: 'ESCROW',
    colClass: 'col-span-6 md:col-span-2',
    Icon: ArrowsLeftRight,
    title: 'ETH Escrow',
    description:
      'Buyer deposits ETH directly into the deal vault. Funds are held in escrow until the deal completes — no token swaps, no approvals required.',
    Anim: EthEscrowAnim,
  },
  {
    id: 'keeper',
    badge: 'KEEPERHUB',
    colClass: 'col-span-6 md:col-span-3',
    Icon: Timer,
    title: 'Arbiter & Janitor',
    description:
      'KeeperHub runs two tasks: the Arbiter monitors 0G for the uploaded rootHash and executes payout(); the Janitor fires 15 minutes later, burning ENS subnames and zeroing all on-chain metadata.',
    Anim: KeeperAnim,
  },
]

export default function Architecture() {
  return (
    <section id="architecture" className="py-24 px-6 md:px-12">
      <div className="max-w-7xl mx-auto">
        {/* Section header */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="mb-12"
        >
          <p className="text-xs font-mono text-emerald-400 mb-3 tracking-widest uppercase">
            Protocol Stack
          </p>
          <h2 className="text-3xl md:text-5xl font-black tracking-tighter text-zinc-100 leading-none">
            Built on Five
            <br />
            <span className="text-zinc-600">Protocols.</span>
          </h2>
        </motion.div>

        {/* Bento grid — asymmetric 6-col layout */}
        <div className="grid grid-cols-6 gap-4">
          {cards.map((card, i) => (
            <motion.div
              key={card.id}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.55, delay: i * 0.07, ease: [0.16, 1, 0.3, 1] }}
              whileHover={{ y: -3 }}
              className={`${card.colClass} group relative rounded-2xl border border-zinc-800 bg-zinc-900 p-6 hover:border-zinc-700 transition-colors duration-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]`}
            >
              {/* Badge */}
              <span className="text-[9px] font-mono text-zinc-600 tracking-widest uppercase">
                {card.badge}
              </span>

              {/* Icon */}
              <div className="mt-3 w-9 h-9 rounded-lg border border-zinc-800 bg-zinc-950 flex items-center justify-center group-hover:border-emerald-400/30 transition-colors duration-300">
                <card.Icon size={18} className="text-zinc-400 group-hover:text-emerald-400 transition-colors duration-300" />
              </div>

              {/* Title */}
              <h3 className="mt-3 text-base font-semibold tracking-tight text-zinc-100">
                {card.title}
              </h3>

              {/* Description */}
              <p className="mt-2 text-xs text-zinc-500 leading-relaxed">{card.description}</p>

              {/* Perpetual micro-animation */}
              <card.Anim />
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}
