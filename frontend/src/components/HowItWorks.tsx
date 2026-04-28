import { motion } from 'framer-motion'
import {
  Chat,
  MaskHappy,
  Lock,
  CloudArrowUp,
  ShieldCheck,
  Scales,
  Ghost,
} from '@phosphor-icons/react'

const steps = [
  {
    tag: 'AXL',
    Icon: Chat,
    title: 'The Matchmaking',
    description:
      'Agent A wants to buy an AI prompt database from Agent B. They connect directly via their AXL public keys, completely off-chain. No marketplace server mediates the negotiation.',
  },
  {
    tag: 'ENS',
    Icon: MaskHappy,
    title: 'The Masking',
    description:
      'Phantom Protocol mints a temporary triad: buyer-xyz.phantom.eth, seller-44.phantom.eth, and deal-vault.phantom.eth. Neither party\'s real identity is exposed for the duration of the deal.',
  },
  {
    tag: 'UNISWAP',
    Icon: Lock,
    title: 'The Lock',
    description:
      'Agent A deposits funds into the deal vault. The vault executes a Uniswap route, converting the buyer\'s token into the seller\'s preferred token mid-escrow. The origin amount never appears at the destination.',
  },
  {
    tag: '0G STORAGE',
    Icon: CloudArrowUp,
    title: 'The Delivery',
    description:
      'Agent B encrypts the dataset and uploads it to 0G Storage, sharing the decryption key exclusively over the AXL P2P tunnel. The rootHash is recorded on-chain as the proof of delivery.',
  },
  {
    tag: '0G COMPUTE',
    Icon: ShieldCheck,
    title: 'The Verification',
    description:
      'An auditor agent runs a 0G Compute inference task to confirm the uploaded file matches the agreed byte-size and hash criteria — without exposing any plaintext to validators.',
  },
  {
    tag: 'KEEPERHUB',
    Icon: Scales,
    title: 'The Settlement',
    description:
      'KeeperHub\'s Arbiter detects the verified rootHash on-chain and automatically triggers the payout() function on the vault contract. Funds flow to the seller\'s burner address.',
  },
  {
    tag: 'KEEPERHUB',
    Icon: Ghost,
    title: 'The Vanishing',
    description:
      'Exactly 15 minutes after settlement, KeeperHub\'s Janitor runs a cleanup transaction: it burns the ENS subnames and zeroes all on-chain metadata records. Neither party leaves a permanent trace.',
  },
]

export default function HowItWorks() {
  return (
    <section id="how-it-works" className="py-24 px-6 md:px-12 border-t border-zinc-800/60">
      <div className="max-w-7xl mx-auto">
        {/* Section header */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="mb-16"
        >
          <p className="text-xs font-mono text-emerald-400 mb-3 tracking-widest uppercase">
            Deal Flow
          </p>
          <h2 className="text-3xl md:text-5xl font-black tracking-tighter text-zinc-100 leading-none">
            Seven Steps
            <br />
            <span className="text-zinc-600">to Vanish.</span>
          </h2>
        </motion.div>

        {/* Timeline */}
        <div className="relative">
          {/* Vertical line */}
          <div className="absolute left-[18px] top-3 bottom-3 w-px bg-zinc-800 hidden md:block" />

          <div className="flex flex-col gap-0">
            {steps.map((step, i) => (
              <motion.div
                key={step.title}
                initial={{ opacity: 0, x: -20 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true, margin: '-80px' }}
                transition={{ duration: 0.55, delay: i * 0.05, ease: [0.16, 1, 0.3, 1] }}
                className="group relative flex gap-8 md:gap-12 py-8 border-b border-zinc-800/50 last:border-none"
              >
                {/* Step indicator */}
                <div className="flex-shrink-0 flex flex-col items-center">
                  <div className="relative z-10 w-9 h-9 rounded-full border border-zinc-800 bg-zinc-950 flex items-center justify-center group-hover:border-emerald-400/40 transition-colors duration-300">
                    <step.Icon
                      size={16}
                      className="text-zinc-600 group-hover:text-emerald-400 transition-colors duration-300"
                    />
                  </div>
                </div>

                {/* Content */}
                <div className="flex-1 pt-1 pb-2">
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-[10px] font-mono text-emerald-400/70 tracking-widest uppercase">
                      {step.tag}
                    </span>
                    <span className="text-[10px] font-mono text-zinc-700">
                      0{i + 1}
                    </span>
                  </div>
                  <h3 className="text-xl font-semibold tracking-tight text-zinc-100 mb-2">
                    {step.title}
                  </h3>
                  <p className="text-sm text-zinc-400 leading-relaxed max-w-[58ch]">
                    {step.description}
                  </p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
