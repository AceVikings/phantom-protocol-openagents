import { motion } from 'framer-motion'
import { Ghost } from '@phosphor-icons/react'

const links = [
  { label: 'Protocol', href: '#protocol' },
  { label: 'Architecture', href: '#architecture' },
  { label: 'How It Works', href: '#how-it-works' },
  { label: 'CLI & MCP', href: '#cli' },
]

export default function Nav() {
  return (
    <motion.nav
      initial={{ y: -24, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 md:px-12 py-4 border-b border-zinc-800/50 bg-zinc-950/80 backdrop-blur-xl"
    >
      {/* Logo */}
      <div className="flex items-center gap-2.5">
        <Ghost size={18} weight="fill" className="text-emerald-400" />
        <span className="text-sm font-semibold tracking-tight text-zinc-100">
          Phantom Protocol
        </span>
      </div>

      {/* Nav links */}
      <div className="hidden md:flex items-center gap-8">
        {links.map((link) => (
          <a
            key={link.label}
            href={link.href}
            className="text-sm text-zinc-400 hover:text-zinc-100 transition-colors duration-200"
          >
            {link.label}
          </a>
        ))}
      </div>

      {/* CTA */}
      <a
        href="#protocol"
        className="text-xs font-medium px-4 py-2 rounded-full border border-zinc-700 text-zinc-300 hover:border-emerald-400/40 hover:text-emerald-400 transition-all duration-300 active:scale-[0.98]"
      >
        Read Protocol
      </a>
    </motion.nav>
  )
}
