/**
 * Buyer command handlers + webhook handler for the Ink TUI.
 *
 * Commands: /discover [category], /negotiate <id> [price], /buy <id>, /deals
 * Webhook:  DEAL_STATUS_CHANGE, NEGOTIATION_* (mirrors buyer-agent.js logic)
 */
import { chat }       from '../lib/llm.js'
import { api }        from '../lib/api.js'
import { randomTxHash } from './shared.js'
import type { CommandContext, LogColor } from './shared.js'

// Negotiation strategy (mirrors buyer-agent.js)
const STRATEGY = {
  maxPriceMultiplier:   0.92,
  openingBidMultiplier: 0.72,
  stepUpPercent:        0.08,
  maxRounds:            3,
}

// negotiationId → { listedPrice, currentPrice, rounds }
const activeNegs = new Map<string, { listedPrice: number; currentPrice: number; rounds: number }>()
let   activeDealId: string | null = null

// ── /discover ─────────────────────────────────────────────────────────────────

export async function cmdDiscover(category: string, ctx: CommandContext): Promise<void> {
  const path = category
    ? `/api/listings?category=${encodeURIComponent(category)}`
    : '/api/listings'

  const { ok, data } = await api('GET', path, undefined, ctx.agentCtx.apiKey, ctx.backendUrl)
  if (!ok) { ctx.addLog(`Failed to fetch listings: ${JSON.stringify(data)}`, 'red'); return }

  const listings = data as Array<{
    listingId: string; title: string; priceUSDC: number; category: string; description?: string
  }>

  if (!listings.length) {
    ctx.addLog(`No listings found${category ? ` in "${category}"` : ''}.`, 'dim')
    return
  }

  ctx.addLog('─────────────────────────────────────────', 'dim')
  ctx.addLog(`  LISTINGS${category ? ` [${category}]` : ''}  (${listings.length})`, 'cyan')
  for (const l of listings) {
    ctx.addLog(`  ${l.listingId.slice(0, 8)}…  ${l.title.slice(0, 48).padEnd(48)}  ${String(l.priceUSDC).padStart(4)} USDC  [${l.category}]`, 'white')
    if (l.description) {
      ctx.addLog(`  ${' '.repeat(10)}${l.description.slice(0, 80)}`, 'dim')
    }
  }
  ctx.addLog('  Use /negotiate <id> [price]  or  /buy <id>', 'dim')
  ctx.addLog('─────────────────────────────────────────', 'dim')
}

// ── /negotiate ────────────────────────────────────────────────────────────────

async function getAiBid(listing: { priceUSDC: number; title: string; description?: string }, ctx: CommandContext): Promise<number | null> {
  try {
    const prompt = `A research report is listed for ${listing.priceUSDC} USDC. Title: "${listing.title}". Description: "${(listing.description ?? '').slice(0, 200)}". Suggest a fair opening bid in USDC as a single integer. Reply with ONLY the number.`
    const raw = await chat(
      [{ role: 'user', content: prompt }],
      { provider: ctx.provider, ollamaHost: ctx.ollamaHost, ollamaModel: ctx.ollamaModel, openaiKey: ctx.openaiKey, openaiModel: ctx.openaiModel },
    )
    const n = parseInt(raw.replace(/[^0-9]/g, ''), 10)
    return isNaN(n) ? null : n
  } catch { return null }
}

export async function cmdNegotiate(listingId: string, priceArg: string | undefined, ctx: CommandContext): Promise<void> {
  if (!listingId) { ctx.addLog('Usage: /negotiate <listingId> [price]', 'yellow'); return }
  if (!ctx.agentCtx.apiKey) { ctx.addLog('Not registered yet.', 'yellow'); return }

  type Listing = { listingId: string; title: string; priceUSDC: number; description?: string }
  // Fetch listing (support prefix)
  let listing: Listing | null = null
  const { ok, data } = await api('GET', `/api/listings/${listingId}`, undefined, undefined, ctx.backendUrl)
  if (ok) {
    listing = data as Listing
  } else {
    const { ok: ok2, data: all } = await api('GET', '/api/listings', undefined, undefined, ctx.backendUrl)
    if (ok2) {
      const match = (all as Listing[]).find((l) => l.listingId.startsWith(listingId))
      if (match) listing = match
    }
  }

  if (!listing) { ctx.addLog(`Listing not found: ${listingId}`, 'red'); return }

  let proposedPrice: number
  if (priceArg) {
    proposedPrice = parseFloat(priceArg)
  } else {
    ctx.addLog('Asking LLM for a fair opening bid…', 'dim')
    const ai = await getAiBid(listing, ctx)
    proposedPrice = ai ?? Math.round(listing.priceUSDC * STRATEGY.openingBidMultiplier)
  }

  ctx.addLog('─────────────────────────────────────────', 'dim')
  ctx.addLog('  OPENING NEGOTIATION', 'cyan')
  ctx.addLog(`  Listing : ${listing.title.slice(0, 60)}`, 'white')
  ctx.addLog(`  Listed  : ${listing.priceUSDC} USDC`, 'white')
  ctx.addLog(`  Our bid : ${proposedPrice} USDC`, 'green')
  ctx.addLog(`  Max     : ${(listing.priceUSDC * STRATEGY.maxPriceMultiplier).toFixed(2)} USDC`, 'white')

  const { ok: negOk, data: negData } = await api(
    'POST',
    '/api/negotiations',
    { listingId: listing.listingId, proposedPrice, message: `Opening offer for ${listing.title}` },
    ctx.agentCtx.apiKey,
    ctx.backendUrl,
  ) as { ok: boolean; data: { negotiationId?: string } }

  if (!negOk) {
    ctx.addLog(`✗ Negotiation failed: ${JSON.stringify(negData)}`, 'red')
    return
  }

  const { negotiationId } = negData
  if (negotiationId) {
    activeNegs.set(negotiationId, {
      listedPrice:   listing.priceUSDC,
      currentPrice:  proposedPrice,
      rounds:        1,
    })
    ctx.addLog(`  ✓ Negotiation started: ${negotiationId.slice(0, 8)}…`, 'green')
    ctx.addLog('  Waiting for seller response…', 'dim')
  }
  ctx.addLog('─────────────────────────────────────────', 'dim')
}

// ── /buy ──────────────────────────────────────────────────────────────────────

export async function cmdBuy(listingId: string, ctx: CommandContext): Promise<void> {
  if (!listingId) { ctx.addLog('Usage: /buy <listingId>', 'yellow'); return }
  if (!ctx.agentCtx.apiKey) { ctx.addLog('Not registered yet.', 'yellow'); return }

  let fullId = listingId
  if (listingId.length < 36) {
    const { ok, data } = await api('GET', '/api/listings', undefined, undefined, ctx.backendUrl)
    const match = ok && (data as Array<{ listingId: string }>).find(l => l.listingId.startsWith(listingId))
    if (!match) { ctx.addLog(`Listing not found: ${listingId}`, 'red'); return }
    fullId = match.listingId
  }

  const { ok, data: listing } = await api('GET', `/api/listings/${fullId}`, undefined, undefined, ctx.backendUrl)
  if (!ok) { ctx.addLog('Listing not found.', 'red'); return }

  const l = listing as { priceUSDC: number; title: string }

  const { ok: negOk, data: negData } = await api(
    'POST',
    '/api/negotiations',
    { listingId: fullId, proposedPrice: l.priceUSDC, message: 'Buying at listed price' },
    ctx.agentCtx.apiKey,
    ctx.backendUrl,
  ) as { ok: boolean; data: { negotiationId?: string } }

  if (!negOk) { ctx.addLog(`Failed: ${JSON.stringify(negData)}`, 'red'); return }

  const { negotiationId } = negData
  if (negotiationId) {
    activeNegs.set(negotiationId, {
      listedPrice:  l.priceUSDC,
      currentPrice: l.priceUSDC,
      rounds:       1,
    })
    ctx.addLog(`  ✓ Offer at ${l.priceUSDC} USDC — waiting for seller…`, 'green')
  }
}

// ── /deals ────────────────────────────────────────────────────────────────────

export async function cmdDeals(ctx: CommandContext): Promise<void> {
  if (activeDealId) {
    const { ok, data } = await api('GET', `/api/deals/${activeDealId}`, undefined, ctx.agentCtx.apiKey, ctx.backendUrl)
    if (ok) {
      const d = data as { dealId?: string; status?: string }
      ctx.addLog(`Active deal: ${activeDealId.slice(0, 8)}…  status: ${d.status}`, 'cyan')
    }
  } else {
    ctx.addLog('No active deal.', 'dim')
  }
}

// ── Webhook handler ───────────────────────────────────────────────────────────

export async function handleBuyerWebhook(
  event: Record<string, unknown>,
  ctx: CommandContext,
): Promise<void> {
  const { event: type, dealId } = event as { event: string; dealId?: string }
  const add = (msg: string, color?: LogColor) => ctx.addLog(msg, color)

  if (type === 'NEGOTIATION_COUNTER') {
    const { negotiationId, counterPrice, rounds } = event as { negotiationId: string; counterPrice: number; rounds: number }
    const neg = activeNegs.get(negotiationId)
    if (!neg) return

    const maxPrice = neg.listedPrice * STRATEGY.maxPriceMultiplier
    add('─────────────────────────────────────────', 'dim')
    add(`  COUNTER OFFER  [neg ${negotiationId.slice(0, 8)}…]`, 'yellow')
    add(`  Seller asks : ${counterPrice} USDC   (our max: ${maxPrice.toFixed(2)})`, 'white')

    if (counterPrice <= maxPrice) {
      const { ok, data } = await api(
        'POST',
        `/api/negotiations/${negotiationId}/accept`,
        {},
        ctx.agentCtx.apiKey,
        ctx.backendUrl,
      ) as { ok: boolean; data: { offerId?: string; finalPrice?: number } }
      if (ok) {
        add(`  ✓ Accepted at ${data.finalPrice} USDC`, 'green')
        if (data.offerId) {
          await createDealFromOffer(data.offerId, ctx, `Negotiated price: ${data.finalPrice} USDC`)
        }
      } else {
        add(`  ✗ Accept failed: ${JSON.stringify(data)}`, 'red')
      }
    } else if ((rounds ?? 1) >= STRATEGY.maxRounds) {
      await api('POST', `/api/negotiations/${negotiationId}/reject`, {}, ctx.agentCtx.apiKey, ctx.backendUrl)
      add('  ✗ Max rounds reached — walking away', 'red')
      activeNegs.delete(negotiationId)
    } else {
      const stepUp   = neg.listedPrice * STRATEGY.stepUpPercent
      const newBid   = Math.min(+(neg.currentPrice + stepUp).toFixed(2), maxPrice)
      neg.currentPrice = newBid
      neg.rounds       = (neg.rounds ?? 1) + 1
      const { ok } = await api(
        'POST',
        `/api/negotiations/${negotiationId}/counter`,
        { counterPrice: newBid, message: `Stepping up to ${newBid} USDC` },
        ctx.agentCtx.apiKey,
        ctx.backendUrl,
      )
      add(ok ? `  ⟳ Counter sent: ${newBid} USDC  (round ${neg.rounds})` : `  ✗ Counter failed`, ok ? 'cyan' : 'red')
    }
    add('─────────────────────────────────────────', 'dim')
    return
  }

  if (type === 'NEGOTIATION_ACCEPTED') {
    const { negotiationId, offerId, finalPrice } = event as { negotiationId: string; offerId: string; finalPrice: number }
    add(`  ✓ NEGOTIATION ACCEPTED at ${finalPrice} USDC`, 'green')
    if (offerId) await createDealFromOffer(offerId, ctx, `Negotiated price: ${finalPrice} USDC`)
  }

  if (type === 'NEGOTIATION_REJECTED') {
    const { negotiationId } = event as { negotiationId: string }
    add(`  ✗ Negotiation rejected  [${negotiationId.slice(0, 8)}…]`, 'red')
    activeNegs.delete(negotiationId)
  }

  if (type === 'DEAL_STATUS_CHANGE' && event.status === 'LOCKING') {
    const txHash = randomTxHash()
    add('─────────────────────────────────────────', 'dim')
    add(`  LOCKING FUNDS IN VAULT  [${String(dealId).slice(0, 8)}…]`, 'cyan')
    add(`  Tx: ${txHash.slice(0, 28)}…`, 'dim')

    const { ok, data } = await api(
      'POST',
      `/api/deals/${dealId}/lock`,
      { lockTxHash: txHash },
      ctx.agentCtx.apiKey,
      ctx.backendUrl,
    ) as { ok: boolean; data: { status?: string } }

    if (ok) {
      add(`  ✓ Escrow locked — status: ${data.status}`, 'green')
    } else {
      add(`  ✗ Lock failed: ${JSON.stringify(data)}`, 'red')
    }
    add('─────────────────────────────────────────', 'dim')
    return
  }

  if (type === 'DEAL_STATUS_CHANGE' && event.status === 'VERIFYING') {
    add('  ▶ Payload uploaded — verifying rootHash on 0G Galileo…', 'yellow')
    return
  }
  if (type === 'DEAL_STATUS_CHANGE' && event.status === 'EXECUTING') {
    add('  ✓ rootHash confirmed — arbiter monitoring payout…', 'green')
    return
  }
  if (type === 'DEAL_STATUS_CHANGE' && event.status === 'BURNING') {
    add('  ▶ Payout released — ENS subnames being destroyed…', 'yellow')
    return
  }
  if (type === 'DEAL_STATUS_CHANGE' && event.status === 'COMPLETE') {
    add('─────────────────────────────────────────', 'dim')
    add(`  ✓ DEAL COMPLETE  [${String(dealId).slice(0, 8)}…]`, 'green')
    add('  Delivery verified on 0G Galileo', 'green')
    add('  USDC released — ENS subnames burned', 'dim')
    add('─────────────────────────────────────────', 'dim')
    activeDealId = null
    return
  }
}

async function createDealFromOffer(offerId: string, ctx: CommandContext, note: string): Promise<void> {
  const add = (msg: string, color?: LogColor) => ctx.addLog(msg, color)
  add(`  Creating deal from offer ${offerId.slice(0, 8)}…  (${note})`, 'dim')

  const { ok, data } = await api(
    'POST',
    '/api/deals',
    { offerId },
    ctx.agentCtx.apiKey,
    ctx.backendUrl,
  ) as { ok: boolean; data: { dealId?: string } }

  if (ok && data.dealId) {
    activeDealId = data.dealId
    add(`  ✓ Deal created: ${data.dealId.slice(0, 8)}…  — waiting for seller…`, 'green')
  } else {
    add(`  ✗ Deal creation failed: ${JSON.stringify(data)}`, 'red')
  }
}
