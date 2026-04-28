import { motion } from 'framer-motion'

const metrics = [
  { value: '$4.2M', label: 'Total Value Escrowed' },
  { value: '12,847', label: 'Deals Completed' },
  { value: '0', label: 'Identity Leaks' },
  { value: '99.98%', label: 'Successful Closures' },
]

export default function Stats() {
  return (
    <section className="border-t border-b border-zinc-800/60 py-14 px-6 md:px-12">
      <div className="max-w-7xl mx-auto grid grid-cols-2 md:grid-cols-4 gap-10">
        {metrics.map((metric, i) => (
          <motion.div
            key={metric.label}
            initial={{ opacity: 0, y: 18 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.55, delay: i * 0.07, ease: [0.16, 1, 0.3, 1] }}
            className="flex flex-col gap-1.5"
          >
            <span className="text-3xl font-mono font-bold text-zinc-100 tracking-tight">
              {metric.value}
            </span>
            <span className="text-sm text-zinc-500">{metric.label}</span>
          </motion.div>
        ))}
      </div>
    </section>
  )
}
