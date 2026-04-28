import { useState, useEffect, memo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Ghost, Lock, ArrowDown } from '@phosphor-icons/react'

const STATUSES = [
  'Matchmaking via AXL tunnel...',
  'Minting burner vault subnames...',
  'Locking 1,000 USDC in escrow...',
  'Uploading ciphertext to 0G Storage...',
  'Verifying payload hash on-chain...',
  'Executing payout via KeeperHub...',
  'Burning vault identity — trace erased.',
]

const VaultCard = memo(function VaultCard() {
  const [statusIndex, setStatusIndex] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => {
      setStatusIndex((prev) => (prev + 1) % STATUSES.length)
    }, 2400)
    return () => clearInterval(timer)
  }, [])

  const step = statusIndex + 1

  return (
    <motion.div
      animate={{ y: [0, -10, 0] }}
      transition={{ duration: 5.5, repeat: Infinity, ease: 'easeInOut' }}
      className="w-full max-w-[340px] mx-auto"
    >
      {/* Card */}
      <div className="relative rounded-2xl border border-zinc-800 bg-zinc-900/80 backdrop-blur-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_24px_48px_-12px_rgba(0,0,0,0.6)] overflow-hidden p-6">
        {/* Ambient glow */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-40 h-40 rounded-full bg-emerald-400/4 blur-3xl pointer-events-none" />

        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <Ghost size={15} weight="fill" className="text-emerald-400" />
            <span className="text-[10px] font-mono text-zinc-500 tracking-widest uppercase">
              Phantom Vault
            </span>
          </div>
          <span className="text-[10px] font-mono text-zinc-700">#8F2C</span>
        </div>

        {/* Buyer row */}
        <div className="flex items-center justify-between py-3 border-t border-zinc-800/80">
          <span className="text-[10px] text-zinc-600 uppercase tracking-wider">Buyer</span>
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-zinc-300">0x7f3a...c1d9</span>
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 font-mono">
              AXL
            </span>
          </div>
        </div>

        {/* Connector down */}
        <div className="flex justify-center py-0.5">
          <div className="flex flex-col items-center gap-0.5">
            <motion.div
              animate={{ opacity: [0.3, 1, 0.3] }}
              transition={{ duration: 1.6, repeat: Infinity }}
              className="w-px h-4 bg-emerald-400/30"
            />
            <ArrowDown size={11} className="text-emerald-400/50" />
          </div>
        </div>

        {/* Vault */}
        <div className="py-3 px-4 rounded-xl border border-emerald-400/20 bg-emerald-400/5 my-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-zinc-600 uppercase tracking-wider">Vault</span>
            <motion.div
              animate={{ opacity: [0.5, 1, 0.5] }}
              transition={{ duration: 2, repeat: Infinity }}
            >
              <Lock size={13} weight="fill" className="text-emerald-400" />
            </motion.div>
          </div>
          <p className="text-xs font-mono text-emerald-400 mt-1">deal-vault.phantom.eth</p>
        </div>

        {/* Connector up */}
        <div className="flex justify-center py-0.5">
          <div className="flex flex-col items-center gap-0.5">
            <ArrowDown size={11} className="text-emerald-400/50" />
            <motion.div
              animate={{ opacity: [0.3, 1, 0.3] }}
              transition={{ duration: 1.6, repeat: Infinity, delay: 0.6 }}
              className="w-px h-4 bg-emerald-400/30"
            />
          </div>
        </div>

        {/* Seller row */}
        <div className="flex items-center justify-between py-3 border-b border-zinc-800/80">
          <span className="text-[10px] text-zinc-600 uppercase tracking-wider">Seller</span>
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-zinc-300">0x2b9e...44fa</span>
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-400 border border-orange-500/20 font-mono">
              0G
            </span>
          </div>
        </div>

        {/* Status */}
        <div className="mt-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] text-zinc-600 uppercase tracking-wider">Status</span>
            <span className="text-[10px] font-mono text-zinc-700">
              {step}/7
            </span>
          </div>
          <div className="h-8 flex items-center overflow-hidden">
            <AnimatePresence mode="wait">
              <motion.p
                key={statusIndex}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                className="text-xs font-mono text-emerald-400"
              >
                {STATUSES[statusIndex]}
              </motion.p>
            </AnimatePresence>
          </div>
          {/* Progress track */}
          <div className="h-px bg-zinc-800 rounded-full overflow-hidden">
            <motion.div
              className="h-full bg-emerald-400"
              animate={{ width: `${(step / 7) * 100}%` }}
              transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
            />
          </div>
        </div>
      </div>
    </motion.div>
  )
})

export default VaultCard
