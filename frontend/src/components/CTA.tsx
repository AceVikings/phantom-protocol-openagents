import { motion } from 'framer-motion'
import { ArrowRight } from '@phosphor-icons/react'

export default function CTA() {
  return (
    <section className="py-32 px-6 md:px-12 border-t border-zinc-800/60">
      <div className="max-w-7xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="flex flex-col md:flex-row md:items-end md:justify-between gap-10"
        >
          <div>
            <p className="text-xs font-mono text-emerald-400 mb-4 tracking-widest uppercase">
              Open Protocol
            </p>
            <h2 className="text-4xl md:text-6xl font-black tracking-tighter leading-none text-zinc-100">
              Become a Node.
            </h2>
            <p className="mt-5 text-base text-zinc-400 leading-relaxed max-w-[48ch]">
              Phantom Protocol is open to vetted operators and agent developers. Deploy a deal
              vault, run an arbiter, or integrate the AXL tunnel into your agent stack.
            </p>
          </div>

          <div className="flex-shrink-0">
            <a
              href="https://github.com/AceVikings/phantom-protocol-openagents"
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex items-center gap-3 px-8 py-4 rounded-full bg-zinc-100 text-zinc-950 font-semibold text-sm hover:bg-white transition-colors duration-200 active:scale-[0.98] active:-translate-y-[1px]"
            >
              Request Early Access
              <ArrowRight
                size={16}
                className="group-hover:translate-x-1 transition-transform duration-200"
              />
            </a>
          </div>
        </motion.div>
      </div>
    </section>
  )
}
