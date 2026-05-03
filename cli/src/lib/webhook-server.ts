/**
 * Local webhook server — receives deal/negotiation callbacks from the coordinator.
 * Events are queued in state.ts and surfaced via phantom_notifications.
 *
 * Auto-creates an ephemeral localtunnel if no explicit host is provided.
 */
import express from 'express'
import { queueNotification, mapOfferPayloadToDeal } from './state.js'
import type { Server } from 'node:http'

type LTTunnel = {
  url: string
  on(event: 'close' | 'error', fn: (...args: unknown[]) => void): void
  close(): void
}
type LTModule = { default(opts: { port: number }): Promise<LTTunnel> }

let _server: Server | null = null
let _tunnel: LTTunnel | null = null

export async function startWebhookServer(
  port: number,
  explicitHost?: string,
): Promise<string> {
  if (_server) {
    return explicitHost ?? _tunnel?.url ?? `http://localhost:${port}`
  }

  const app = express()
  app.use(express.json({ limit: '1mb' }))

  app.post('/webhook', (req, res) => {
    const event = req.body as Record<string, unknown>
    if (event['event'] === 'DEAL_OFFER' && event['offerId'] && event['dealId']) {
      mapOfferPayloadToDeal(String(event['offerId']), String(event['dealId']))
    }
    queueNotification(event)
    res.json({ ok: true })
  })

  app.get('/health', (_req, res) => res.json({ ok: true }))

  // Bind to all interfaces so localtunnel can forward to us
  await new Promise<void>((resolve, reject) => {
    _server = app.listen(port, '0.0.0.0', () => resolve())
    _server!.on('error', reject)
  })

  if (explicitHost) return explicitHost

  try {
    const lt = (await import('localtunnel')) as unknown as LTModule
    const tunnel = await lt.default({ port })
    _tunnel = tunnel
    tunnel.on('close', () => process.stderr.write('[phantom] Tunnel closed\n'))
    tunnel.on('error', (e) => process.stderr.write(`[phantom] Tunnel error: ${String(e)}\n`))
    return tunnel.url
  } catch {
    return `http://localhost:${port}`
  }
}

export function stopWebhookServer(): void {
  _tunnel?.close()
  _tunnel = null
  _server?.close()
  _server = null
}
