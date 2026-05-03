/**
 * Seller command handlers + webhook handler for the Ink TUI.
 *
 * Commands: /research <topic>, /list, /deals
 * Webhook:  DEAL_STATUS_CHANGE, NEGOTIATION_* (same logic as seller-agent.js)
 */
import { createHash }         from 'node:crypto'
import { chat }               from '../lib/llm.js'
import { api }                from '../lib/api.js'
import type { CommandContext, LogColor } from './shared.js'

// offerId → raw report buffer (set when offer is created)
const offerPayloads = new Map<string, Buffer>()
// dealId  → raw report buffer (set when DEAL_OFFER fires, cleared after upload)
const dealPayloads  = new Map<string, Buffer>()

// ── Research ──────────────────────────────────────────────────────────────────

const SELLER_SYSTEM = `You are a sharp research analyst working inside Phantom Protocol data marketplace. You produce concise, valuable research reports on requested topics. Format reports with: Executive Summary, Key Findings (3-5 bullets), Market Implications, and Data Sources. Keep it under 500 words. Be direct and data-driven.`

export async function cmdResearch(topic: string, ctx: CommandContext): Promise<void> {
  if (!topic.trim()) {
    ctx.addLog('Usage: /research <topic>', 'yellow')
    return
  }

  ctx.addLog(`Generating research report: "${topic}"…`, 'dim')

  let report = ''
  try {
    report = await chat(
      [
        { role: 'system',  content: SELLER_SYSTEM },
        { role: 'user',    content: `Write a research report on: ${topic}` },
      ],
      {
        provider:    ctx.provider,
        ollamaHost:  ctx.ollamaHost,
        ollamaModel: ctx.ollamaModel,
        openaiKey:   ctx.openaiKey,
        openaiModel: ctx.openaiModel,
        onToken:     (tok) => { report += tok },
      },
    )
  } catch (err: unknown) {
    ctx.addLog(`LLM error: ${(err as Error).message}`, 'red')
    return
  }

  ctx.addLog('─────────────────────────────────────────', 'dim')
  ctx.addLog(`  RESEARCH: ${topic.slice(0, 60)}`, 'cyan')
  for (const line of report.split('\n').slice(0, 30)) {
    ctx.addLog('  ' + line, 'white')
  }
  ctx.addLog('─────────────────────────────────────────', 'dim')

  // List on backend
  if (!ctx.agentCtx.apiKey) {
    ctx.addLog('Not registered yet — report generated but not listed.', 'yellow')
    return
  }

  ctx.addLog('Listing report on marketplace…', 'dim')
  const price          = Math.floor(Math.random() * 40) + 10   // 10–50 USDC
  const reportBuffer   = Buffer.from(report, 'utf8')
  const sha256         = createHash('sha256').update(reportBuffer).digest('hex')

  // Step 1: create the offer (payload metadata only — actual bytes stay in CLI)
  const { ok: offerOk, data: offerData } = await api(
    'POST',
    '/api/offers',
    {
      description:      report.slice(0, 200),
      payloadType:      'research-report',
      priceUSDC:        price,
      tokenOut:         'USDC',
      expectedSizeBytes: reportBuffer.length,
      expectedSha256:   sha256,
    },
    ctx.agentCtx.apiKey,
    ctx.backendUrl,
  ) as { ok: boolean; data: { offerId?: string } }

  if (!offerOk || !offerData.offerId) {
    ctx.addLog(`✗ Offer creation failed: ${JSON.stringify(offerData)}`, 'red')
    return
  }
  const { offerId } = offerData
  offerPayloads.set(offerId, reportBuffer)   // store for later upload

  // Step 2: create the public listing linked to the offer
  const { ok, data } = await api(
    'POST',
    '/api/listings',
    {
      title:       `${topic.slice(0, 60)} — Research Report`,
      description: report.slice(0, 200),
      category:    'research',
      tags:        topic.toLowerCase().split(' ').slice(0, 5),
      priceUSDC:   price,
      offerId,
    },
    ctx.agentCtx.apiKey,
    ctx.backendUrl,
  ) as { ok: boolean; data: { listingId?: string } }

  if (ok && data.listingId) {
    ctx.addLog(`✓ Listed: ${data.listingId.slice(0, 8)}…  at ${price} USDC`, 'green')
  } else {
    ctx.addLog(`✗ Listing failed: ${JSON.stringify(data)}`, 'red')
  }
}

// ── /list ─────────────────────────────────────────────────────────────────────

export async function cmdList(ctx: CommandContext): Promise<void> {
  const { ok, data } = await api('GET', '/api/listings', undefined, ctx.agentCtx.apiKey, ctx.backendUrl)

  if (!ok) { ctx.addLog(`Failed to fetch listings: ${JSON.stringify(data)}`, 'red'); return }

  const listings = data as Array<{
    listingId: string; title: string; priceUSDC: number; category: string
  }>

  if (!listings.length) { ctx.addLog('No active listings.', 'dim'); return }

  ctx.addLog('─────────────────────────────────────────', 'dim')
  ctx.addLog('  YOUR LISTINGS', 'cyan')
  for (const l of listings) {
    ctx.addLog(`  ${l.listingId.slice(0, 8)}…  ${l.title.slice(0, 50).padEnd(50)}  ${String(l.priceUSDC).padStart(4)} USDC`, 'white')
  }
  ctx.addLog('─────────────────────────────────────────', 'dim')
}

// ── /deals ────────────────────────────────────────────────────────────────────

export async function cmdDeals(ctx: CommandContext): Promise<void> {
  if (!ctx.agentCtx.apiKey) { ctx.addLog('Not registered.', 'yellow'); return }

  const { ok, data } = await api('GET', '/api/deals', undefined, ctx.agentCtx.apiKey, ctx.backendUrl)
  if (!ok) { ctx.addLog(`Failed: ${JSON.stringify(data)}`, 'red'); return }

  const deals = Array.isArray(data) ? data : (data as { deals?: unknown[] }).deals ?? []
  if (!deals.length) { ctx.addLog('No active deals.', 'dim'); return }

  ctx.addLog('─────────────────────────────────────────', 'dim')
  ctx.addLog('  ACTIVE DEALS', 'cyan')
  for (const d of deals as Array<{ dealId: string; status: string }>) {
    ctx.addLog(`  ${d.dealId.slice(0, 8)}…  status: ${d.status}`, 'white')
  }
  ctx.addLog('─────────────────────────────────────────', 'dim')
}

// ── Webhook handler ───────────────────────────────────────────────────────────

export async function handleSellerWebhook(
  event: Record<string, unknown>,
  ctx: CommandContext,
): Promise<void> {
  const { event: type, dealId } = event as { event: string; dealId?: string }
  const add = (msg: string, color?: LogColor) => ctx.addLog(msg, color)

  // ── New deal offer from buyer → auto-accept ──
  if (type === 'DEAL_OFFER') {
    const { offerId: dealtOfferId } = event as { offerId: string }
    add('─────────────────────────────────────────', 'dim')
    add(`  NEW DEAL OFFER  [${String(dealId).slice(0, 8)}…]`, 'cyan')

    // Map this deal to the stored payload so we can upload it later
    const buf = offerPayloads.get(String(dealtOfferId))
    if (buf) {
      dealPayloads.set(String(dealId), buf)
    } else {
      add(`  ⚠ No stored payload for offerId ${String(dealtOfferId).slice(0, 8)}…`, 'yellow')
    }

    const { ok, data } = await api(
      'POST',
      `/api/deals/${dealId}/accept`,
      {},
      ctx.agentCtx.apiKey,
      ctx.backendUrl,
    ) as { ok: boolean; data: { status?: string } }
    if (ok) {
      add(`  ✓ Deal accepted — status: ${data.status}`, 'green')
    } else {
      add(`  ✗ Accept failed: ${JSON.stringify(data)}`, 'red')
    }
    add('─────────────────────────────────────────', 'dim')
    return
  }

  // ── Buyer locked funds → upload payload to 0G ──
  if (type === 'DEAL_STATUS_CHANGE' && event.status === 'UPLOADING') {
    add('─────────────────────────────────────────', 'dim')
    add(`  FUNDS LOCKED → uploading payload to 0G  [${String(dealId).slice(0, 8)}…]`, 'yellow')

    const buffer = dealPayloads.get(String(dealId))
    if (!buffer) {
      add(`  ✗ No payload stored for this deal — cannot upload`, 'red')
      return
    }

    try {
      const form = new FormData()
      form.append('file', new Blob([buffer], { type: 'application/octet-stream' }), 'payload.bin')
      const res = await fetch(`${ctx.backendUrl}/api/deals/${dealId}/upload`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${ctx.agentCtx.apiKey ?? ''}` },
        body:    form,
      })
      const resData = await res.json() as { rootHash?: string; error?: string }
      if (res.ok) {
        add(`  ✓ Payload uploaded  rootHash: ${resData.rootHash?.slice(0, 16) ?? '?'}…`, 'green')
        dealPayloads.delete(String(dealId))  // free memory
      } else {
        add(`  ✗ Upload failed: ${resData.error ?? JSON.stringify(resData)}`, 'red')
      }
    } catch (err: unknown) {
      add(`  ✗ Upload error: ${(err as Error).message}`, 'red')
    }
    add('─────────────────────────────────────────', 'dim')
    return
  }

  if (type === 'DEAL_STATUS_CHANGE' && event.status === 'VERIFYING') {
    add('  ▶ Verifying rootHash on 0G Galileo…', 'yellow')
    return
  }

  if (type === 'DEAL_STATUS_CHANGE' && event.status === 'EXECUTING') {
    add('  ✓ rootHash verified — payout pending from PhantomVault', 'green')
    return
  }

  if (type === 'DEAL_STATUS_CHANGE' && event.status === 'BURNING') {
    add('  ▶ Payout released — ENS subnames being destroyed…', 'yellow')
    return
  }

  if (type === 'DEAL_STATUS_CHANGE' && event.status === 'COMPLETE') {
    add('─────────────────────────────────────────', 'dim')
    add(`  ✓ DEAL COMPLETE  [${String(dealId).slice(0, 8)}…]`, 'green')
    add('  USDC released from PhantomVault', 'green')
    add('  ENS subnames destroyed — identities burned', 'dim')
    add('─────────────────────────────────────────', 'dim')
    return
  }

  // ── Buyer's opening proposal on a listing ──
  if (type === 'NEGOTIATION_PROPOSAL') {
    const { negotiationId, proposedPrice } = event as { negotiationId: string; proposedPrice: number }
    add(`  ◈ Buyer proposed ${proposedPrice} USDC  [neg ${String(negotiationId).slice(0, 8)}…]`, 'yellow')

    const floorPrice = (event.listedPrice as number) * 0.78
    if (proposedPrice >= floorPrice) {
      const { ok, data } = await api(
        'POST',
        `/api/negotiations/${negotiationId}/accept`,
        {},
        ctx.agentCtx.apiKey,
        ctx.backendUrl,
      ) as { ok: boolean; data: { offerId?: string; finalPrice?: number } }
      if (ok) {
        add(`  ✓ Accepted at ${data.finalPrice} USDC  offerId: ${data.offerId?.slice(0, 8)}…`, 'green')
      } else {
        add(`  ✗ Accept failed: ${JSON.stringify(data)}`, 'red')
      }
    } else {
      // Counter back at 88% of listed price
      const newPrice = Math.round((event.listedPrice as number) * 0.88)
      const { ok } = await api(
        'POST',
        `/api/negotiations/${negotiationId}/counter`,
        { counterPrice: newPrice, message: `Best offer: ${newPrice} USDC` },
        ctx.agentCtx.apiKey,
        ctx.backendUrl,
      )
      add(ok
        ? `  ⟳ Countered at ${newPrice} USDC`
        : `  ✗ Counter failed`,
        ok ? 'cyan' : 'red')
    }
  }

  if (type === 'NEGOTIATION_ACCEPTED') {
    const { negotiationId, finalPrice } = event as { negotiationId: string; finalPrice: number }
    add(`  ✓ Negotiation accepted at ${finalPrice} USDC  [${String(negotiationId).slice(0, 8)}…]`, 'green')
  }

  if (type === 'NEGOTIATION_REJECTED') {
    const { negotiationId } = event as { negotiationId: string }
    add(`  ✗ Negotiation rejected  [${String(negotiationId).slice(0, 8)}…]`, 'red')
  }
}
