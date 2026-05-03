/** Express webhook server — receives events from the backend, emits on webhookBus. */
import express from 'express'
import { webhookBus } from './webhookBus.js'

export async function startWebhookServer(port: number): Promise<void> {
  const app = express()
  app.use(express.json())

  app.post('/webhook', (req, res) => {
    res.sendStatus(200)
    webhookBus.emit('event', req.body)
  })

  // health check
  app.get('/health', (_req, res) => res.json({ ok: true }))

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => resolve())
    server.once('error', reject)
  })
}
