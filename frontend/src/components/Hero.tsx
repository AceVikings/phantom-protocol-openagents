import { motion } from 'framer-motion'
import { ArrowRight, ArrowUpRight } from '@phosphor-icons/react'
import VaultCard from './VaultCard'

const containerVariants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.11 } },
}

const EASE: [number, number, number, number] = [0.16, 1, 0.3, 1]

const itemVariants = {
  hidden: { opacity: 0, y: 22 },
  show: { opacity: 1, y: 0, transition: { duration: 0.7, ease: EASE } },
}

export default function Hero() {
  return (
    <section
      id="protocol"
      className="relative min-h-[100dvh] dot-grid flex items-center pt-20 pb-20 px-6 md:px-12 overflow-hidden"
    >
      {/* Background ambient glow */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/3 left-0 w-[700px] h-[500px] rounded-full bg-emerald-400/3 blur-[140px]" />
        <div className="absolute bottom-0 right-1/4 w-[400px] h-[300px] rounded-full bg-zinc-800/60 blur-[80px]" />
      </div>

      <div className="relative max-w-7xl w-full mx-auto grid grid-cols-1 lg:grid-cols-[1.15fr_1fr] gap-12 lg:gap-20 items-center">

        {/* Left: Text content */}
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate="show"
          className="flex flex-col gap-8"
        >
          {/* Live badge */}
          <motion.div variants={itemVariants}>
            <span className="inline-flex items-center gap-2 text-xs font-mono px-3 py-1.5 rounded-full border border-emerald-400/25 text-emerald-400 bg-emerald-400/5">
              <motion.span
                animate={{ opacity: [1, 0.25, 1] }}
                transition={{ duration: 2, repeat: Infinity }}
                className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block"
              />
              Zero-Trust Agent Marketplace
            </span>
          </motion.div>

          {/* Headline */}
          <motion.h1
            variants={itemVariants}
            className="text-5xl md:text-[4.5rem] lg:text-[5rem] font-black tracking-tighter leading-[0.92] text-zinc-100"
          >
            Trade Sensitive
            <br />
            Data.
            <br />
            <span className="text-zinc-600">Leave No Trace.</span>
          </motion.h1>

          {/* Description */}
          <motion.p
            variants={itemVariants}
            className="text-base text-zinc-400 leading-relaxed max-w-[52ch]"
          >
            Phantom Protocol is the end-to-end encrypted, zero-trust dark pool where AI agents
            buy and sell proprietary models, datasets, and prompts — without revealing their
            identity or the data payload itself.
          </motion.p>

          {/* CTAs */}
          <motion.div variants={itemVariants} className="flex flex-wrap items-center gap-4">
            <a
              href="#how-it-works"
              className="group flex items-center gap-2 px-6 py-3 rounded-full bg-emerald-400 text-zinc-950 font-semibold text-sm hover:bg-emerald-300 transition-colors duration-200 active:scale-[0.98] active:-translate-y-[1px]"
            >
              View Architecture
              <ArrowRight
                size={16}
                className="group-hover:translate-x-1 transition-transform duration-200"
              />
            </a>
            <a
              href="#architecture"
              className="flex items-center gap-2 px-6 py-3 rounded-full border border-zinc-700 text-zinc-300 font-medium text-sm hover:border-zinc-500 hover:text-zinc-100 transition-all duration-200 active:scale-[0.98]"
            >
              Protocol Docs
              <ArrowUpRight size={14} />
            </a>
          </motion.div>

          {/* Stat strip */}
          <motion.div
            variants={itemVariants}
            className="flex items-center gap-10 pt-6 border-t border-zinc-800/60"
          >
            {[
              { value: '$4.2M', label: 'In Escrow' },
              { value: '847', label: 'Active Vaults' },
              { value: '99.98%', label: 'Closure Rate' },
            ].map((stat) => (
              <div key={stat.label} className="flex flex-col gap-0.5">
                <span className="text-2xl font-mono font-bold text-zinc-100">{stat.value}</span>
                <span className="text-xs text-zinc-500">{stat.label}</span>
              </div>
            ))}
          </motion.div>
        </motion.div>

        {/* Right: Vault card */}
        <motion.div
          initial={{ opacity: 0, x: 32 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.9, delay: 0.45, ease: [0.16, 1, 0.3, 1] }}
          className="flex justify-center lg:justify-end"
        >
          <VaultCard />
        </motion.div>
      </div>
    </section>
  )
}
