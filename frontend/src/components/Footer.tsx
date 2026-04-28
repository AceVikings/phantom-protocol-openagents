import { Ghost } from '@phosphor-icons/react'

const links = [
  { label: 'Protocol Docs', href: '#protocol' },
  { label: 'Architecture', href: '#architecture' },
  { label: 'How It Works', href: '#how-it-works' },
  {
    label: 'GitHub',
    href: 'https://github.com/AceVikings/phantom-protocol-openagents',
    external: true,
  },
]

export default function Footer() {
  return (
    <footer className="border-t border-zinc-800/60 py-12 px-6 md:px-12">
      <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-start md:items-center justify-between gap-8">
        {/* Logo */}
        <div className="flex items-center gap-2.5">
          <Ghost size={16} weight="fill" className="text-emerald-400" />
          <span className="text-sm font-semibold text-zinc-400">Phantom Protocol</span>
        </div>

        {/* Links */}
        <nav className="flex flex-wrap gap-6">
          {links.map((link) => (
            <a
              key={link.label}
              href={link.href}
              target={link.external ? '_blank' : undefined}
              rel={link.external ? 'noopener noreferrer' : undefined}
              className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors duration-200"
            >
              {link.label}
            </a>
          ))}
        </nav>

        {/* Legal */}
        <p className="text-xs font-mono text-zinc-700">
          &copy; 2026 Phantom Protocol. MIT License.
        </p>
      </div>
    </footer>
  )
}
