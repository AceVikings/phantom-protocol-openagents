/**
 * Phantom Protocol MCP Server — inlined into the CLI.
 * Called by `phantom mcp` to start the stdio MCP transport.
 * All output to stderr; stdin/stdout reserved for MCP protocol.
 */
import { createHash }            from 'node:crypto'
import { Server }                from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport }  from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { loadOrCreateWallet, getEthBalance } from './wallet.js'
import { api }                             from './api.js'
import { lockFundsInVault }               from './vault.js'
import { uploadToZeroG, getZeroGBalance }  from './zerog.js'
import {
  loadSession, saveSession, getSession,
  storeOfferPayload, getDealPayload, deleteDealPayload,
  drainNotifications,
} from './state.js'
import { startWebhookServer } from './webhook-server.js'
import {
  getBackendUrl, getWebhookPort, getWebhookHost,
} from './config.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(text: string)  { return { content: [{ type: 'text' as const, text }] } }
function err(text: string) { return { content: [{ type: 'text' as const, text: `ERROR: ${text}` }], isError: true } }

function requireSession() {
  const s = getSession()
  if (!s) throw new Error('Not registered. Call phantom_register first.')
  return s
}

function walletToAxlPubkey(address: string): string {
  return createHash('sha256').update(address).digest('hex')
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS: Tool[] = [
  {
    name: 'phantom_register',
    description:
      'Register this agent with the Phantom Protocol coordinator. ' +
      'Must be called once before any other operation. ' +
      'Session persists to ~/.phantom/session.json across restarts.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['buyer', 'seller'] },
      },
      required: ['role'],
    },
  },
  {
    name: 'phantom_wallet',
    description: 'Show the agent ephemeral Ethereum wallet address (Sepolia).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'phantom_balance',
    description: 'Check ETH (Sepolia) and OG (0G Galileo) balances.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'phantom_notifications',
    description:
      'Poll for pending protocol events. Returns queued events and clears the queue. ' +
      'Call regularly during active workflows.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'phantom_list_report',
    description:
      'SELLER: Publish a research report on the Phantom marketplace.',
    inputSchema: {
      type: 'object',
      properties: {
        topic:       { type: 'string' },
        content:     { type: 'string' },
        price_usdc:  { type: 'number' },
        category:    { type: 'string' },
      },
      required: ['topic', 'content', 'price_usdc'],
    },
  },
  {
    name: 'phantom_my_listings',
    description: 'SELLER: Show your active listings.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'phantom_accept_deal',
    description: 'SELLER: Accept an incoming deal offer from a buyer.',
    inputSchema: {
      type: 'object',
      properties: { deal_id: { type: 'string' } },
      required: ['deal_id'],
    },
  },
  {
    name: 'phantom_upload_payload',
    description: 'SELLER: Upload the stored research payload to 0G Storage for a deal.',
    inputSchema: {
      type: 'object',
      properties: { deal_id: { type: 'string' } },
      required: ['deal_id'],
    },
  },
  {
    name: 'phantom_counter_negotiation',
    description: 'SELLER or BUYER: Counter a price proposal with a new price.',
    inputSchema: {
      type: 'object',
      properties: {
        negotiation_id: { type: 'string' },
        counter_price:  { type: 'number' },
        message:        { type: 'string' },
      },
      required: ['negotiation_id', 'counter_price'],
    },
  },
  {
    name: 'phantom_accept_negotiation',
    description: 'SELLER or BUYER: Accept the current negotiation price.',
    inputSchema: {
      type: 'object',
      properties: { negotiation_id: { type: 'string' } },
      required: ['negotiation_id'],
    },
  },
  {
    name: 'phantom_reject_negotiation',
    description: 'SELLER or BUYER: Reject a negotiation.',
    inputSchema: {
      type: 'object',
      properties: { negotiation_id: { type: 'string' } },
      required: ['negotiation_id'],
    },
  },
  {
    name: 'phantom_discover',
    description: 'BUYER: Browse available data listings.',
    inputSchema: {
      type: 'object',
      properties: {
        category:       { type: 'string' },
        search:         { type: 'string' },
        max_price_usdc: { type: 'number' },
      },
    },
  },
  {
    name: 'phantom_negotiate',
    description: 'BUYER: Open a price negotiation on a listing.',
    inputSchema: {
      type: 'object',
      properties: {
        listing_id:          { type: 'string' },
        proposed_price_usdc: { type: 'number' },
        message:             { type: 'string' },
      },
      required: ['listing_id', 'proposed_price_usdc'],
    },
  },
  {
    name: 'phantom_create_deal',
    description: 'BUYER: Create a deal from an accepted offer. Next: phantom_lock_funds.',
    inputSchema: {
      type: 'object',
      properties: { offer_id: { type: 'string' } },
      required: ['offer_id'],
    },
  },
  {
    name: 'phantom_lock_funds',
    description: 'BUYER: Lock ETH in the PhantomVault escrow contract for a deal.',
    inputSchema: {
      type: 'object',
      properties: { deal_id: { type: 'string' } },
      required: ['deal_id'],
    },
  },
  {
    name: 'phantom_my_deals',
    description: 'Show all your active deals and their status.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'phantom_deal_status',
    description: 'Get the status and details of a specific deal.',
    inputSchema: {
      type: 'object',
      properties: { deal_id: { type: 'string' } },
      required: ['deal_id'],
    },
  },
  // ── AXL messaging ─────────────────────────────────────────────────────────
  {
    name: 'phantom_init',
    description:
      'One-shot setup: creates a wallet if needed, registers with the coordinator, and saves session. ' +
      'Idempotent — safe to call again if already registered. ' +
      'Call this first before any other phantom tool.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['buyer', 'seller'], description: 'Agent role. Defaults to buyer.' },
      },
    },
  },
  {
    name: 'phantom_axl_info',
    description:
      'Show this agent\'s AXL identity: wallet address, derived AXL public key, and current session. ' +
      'Share your AXL pubkey with counterparties so they can message you directly.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'phantom_send_axl_message',
    description:
      'Send an encrypted AXL message to another agent via the coordinator relay. ' +
      'Use to share offer details, decryption keys, or deal terms off-chain.',
    inputSchema: {
      type: 'object',
      properties: {
        destination_axl_pubkey: { type: 'string', description: '64-char hex Ed25519 public key of the recipient agent.' },
        message: { type: 'string', description: 'Message body (plaintext — AXL encrypts in transit).' },
        deal_id: { type: 'string', description: 'Optional deal ID to attach to the message.' },
      },
      required: ['destination_axl_pubkey', 'message'],
    },
  },
  {
    name: 'phantom_read_axl_messages',
    description:
      'Read pending AXL messages from the coordinator inbox. ' +
      'Returns up to 20 messages and drains the queue. ' +
      'Call after locking funds or after sending a message to check for responses.',
    inputSchema: { type: 'object', properties: {} },
  },
  // ── Agent-to-agent inquiry ─────────────────────────────────────────────────
  {
    name: 'phantom_ask_seller',
    description:
      'BUYER: Ask the seller a question about a listing before negotiating. ' +
      'The question is relayed via AXL encrypted messaging — your identity is not revealed. ' +
      'The seller can answer about data quality, format, methodology, freshness etc WITHOUT sending raw data. ' +
      'Use phantom_read_axl_messages to receive the reply. ' +
      'Typical flow: phantom_discover → phantom_ask_seller → phantom_negotiate → phantom_create_deal → phantom_lock_funds.',
    inputSchema: {
      type: 'object',
      properties: {
        listing_id: { type: 'string', description: 'The listing ID to inquire about.' },
        question:   { type: 'string', description: 'Your question (e.g. "What date range does this cover?", "What format is the data in?", "How many records?").' },
      },
      required: ['listing_id', 'question'],
    },
  },
  {
    name: 'phantom_reply_to_inquiry',
    description:
      'SELLER: Reply to a buyer\'s question about your listing. ' +
      'Answer based on your knowledge of the data — do NOT include raw data content in the reply. ' +
      'Describe format, methodology, coverage, size etc. The buyer receives your reply via AXL. ' +
      'Get buyer_axl_pubkey from the phantom_read_axl_messages output.',
    inputSchema: {
      type: 'object',
      properties: {
        buyer_axl_pubkey: { type: 'string', description: '64-char AXL pubkey of the buyer who asked (from phantom_read_axl_messages fromAxlPubkey field).' },
        listing_id:       { type: 'string', description: 'The listing ID the question was about.' },
        answer:           { type: 'string', description: 'Your answer describing the data without revealing the raw content.' },
      },
      required: ['buyer_axl_pubkey', 'listing_id', 'answer'],
    },
  },
  {
    name: 'phantom_my_negotiations',
    description:
      'SELLER or BUYER: List all your price negotiations and their current status. ' +
      'SELLER: shows incoming buyer proposals you need to counter or accept. ' +
      'BUYER: shows your open bids and any counters from sellers. ' +
      'Includes negotiation IDs, price rounds, and required next actions.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'phantom_get_negotiation',
    description:
      'Get full status, price round history, and next-action hint for a specific negotiation. ' +
      'Shows all rounds (who offered what and when) and what you should do next.',
    inputSchema: {
      type: 'object',
      properties: { negotiation_id: { type: 'string' } },
      required: ['negotiation_id'],
    },
  },
]

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function handleRegister(
  args: { role: 'buyer' | 'seller' },
  backendUrl: string,
  webhookHost: string,
  webhookPort: number,
) {
  const wallet     = loadOrCreateWallet()
  const axlPubkey  = walletToAxlPubkey(wallet.address)
  const webhookUrl = `${webhookHost}/webhook`

  const { ok: regOk, data } = await api(
    'POST', '/api/agents/register',
    { axlPubkey, ephemeralAddress: wallet.address, role: args.role, capabilities: [], webhookUrl },
    null, backendUrl,
  ) as { ok: boolean; data: { agentId?: string; apiKey?: string; error?: string } }

  if (!regOk || !data.agentId || !data.apiKey) {
    throw new Error(`Registration failed: ${data.error ?? JSON.stringify(data)}`)
  }

  saveSession({ agentId: data.agentId, apiKey: data.apiKey, role: args.role, webhookPort, backendUrl })

  return ok(
    `REGISTERED\nAGENT_ID: ${data.agentId}\nROLE: ${args.role}\n` +
    `WALLET: ${wallet.address}\nWEBHOOK: ${webhookUrl}\n` +
    `\nSession saved to ~/.phantom/session.json`,
  )
}

async function handleWallet() {
  const w = loadOrCreateWallet()
  return ok(`WALLET (Sepolia)\nADDRESS: ${w.address}\nEXPLORER: https://sepolia.etherscan.io/address/${w.address}\nKEY FILE: ~/.phantom/wallet.json`)
}

async function handleBalance() {
  const w = loadOrCreateWallet()
  const [sepoliaBalance, ogRaw] = await Promise.all([
    getEthBalance(w.address),
    getZeroGBalance(w.address).catch(() => null),
  ])
  const ogLine = ogRaw !== null ? `\nOG (0G Galileo): ${parseFloat(ogRaw).toFixed(6)} OG` : ''
  return ok(
    `BALANCES\nADDRESS: ${w.address}` +
    `\nETH (Sepolia): ${parseFloat(sepoliaBalance.eth).toFixed(6)} ETH` +
    ogLine,
  )
}

function handleNotifications() {
  const events = drainNotifications()
  if (!events.length) return ok('NO_PENDING_EVENTS')

  const lines = events.map(({ ts, event }) => {
    const e = event as Record<string, unknown>
    const time = new Date(ts).toISOString().slice(11, 19)
    const type = (e.event as string) ?? 'UNKNOWN'

    let action = ''
    if (type === 'NEGOTIATION_PROPOSAL') {
      action = `  → phantom_my_negotiations  (then phantom_get_negotiation negotiation_id="${e.negotiationId}")`
    } else if (type === 'NEGOTIATION_COUNTER') {
      action = `  → phantom_get_negotiation negotiation_id="${e.negotiationId}"  (then counter or accept)`
    } else if (type === 'NEGOTIATION_ACCEPTED') {
      action = `  → phantom_create_deal offer_id="${e.offerId}"  (then phantom_lock_funds)`
    } else if (type === 'NEGOTIATION_REJECTED') {
      action = `  → phantom_negotiate to try again or find another listing`
    } else if (type === 'DEAL_LOCKED') {
      action = `  → phantom_upload_payload deal_id="${e.dealId}"`
    } else if (type === 'DEAL_SETTLED') {
      action = `  → Deal complete. Funds released.`
    }

    return `[${time}] ${type}  ${JSON.stringify(e)}\n${action}`
  })

  return ok(`EVENTS (${events.length})\n\n${lines.join('\n\n')}\n\nQueue cleared.`)
}

async function handleListReport(
  args: { topic: string; content: string; price_usdc: number; category?: string },
  backendUrl: string,
) {
  const s        = requireSession()
  const buf      = Buffer.from(args.content, 'utf8')
  const sha256   = createHash('sha256').update(buf).digest('hex')
  const category = args.category ?? 'research'

  const { ok: offerOk, data: offerData } = await api(
    'POST', '/api/offers',
    { description: args.content.slice(0, 200), payloadType: category, priceUSDC: args.price_usdc,
      tokenOut: 'USDC', expectedSizeBytes: buf.length, expectedSha256: sha256 },
    s.apiKey, backendUrl,
  ) as { ok: boolean; data: { offerId?: string; error?: string } }

  if (!offerOk || !offerData.offerId) throw new Error(`Offer creation failed: ${offerData.error}`)
  storeOfferPayload(offerData.offerId, buf)

  const { ok: listOk, data: listData } = await api(
    'POST', '/api/listings',
    { title: `${args.topic.slice(0, 80)} — Research Report`, description: args.content.slice(0, 200),
      category, tags: args.topic.toLowerCase().split(/\s+/).slice(0, 5),
      priceUSDC: args.price_usdc, offerId: offerData.offerId },
    s.apiKey, backendUrl,
  ) as { ok: boolean; data: { listingId?: string; error?: string } }

  if (!listOk || !listData.listingId) throw new Error(`Listing creation failed: ${listData.error}`)

  return ok(`LISTED\nLISTING_ID: ${listData.listingId}\nOFFER_ID: ${offerData.offerId}\nTOPIC: ${args.topic}\nPRICE: ${args.price_usdc} USDC`)
}

async function handleMyListings(backendUrl: string) {
  const s = requireSession()
  const { ok: fetchOk, data } = await api('GET', '/api/listings', undefined, s.apiKey, backendUrl)
  if (!fetchOk) throw new Error(`Failed: ${JSON.stringify(data)}`)
  const listings = (data as Array<{ listingId: string; title: string; priceUSDC: number; category: string; active: boolean }>).filter(l => l.active)
  if (!listings.length) return ok('NO_ACTIVE_LISTINGS')
  return ok(`YOUR LISTINGS (${listings.length})\n` + listings.map(l =>
    `  ${l.listingId.slice(0, 8)}…  ${l.title.slice(0, 55).padEnd(55)}  ${l.priceUSDC} USDC  [${l.category}]`).join('\n'))
}

async function handleAcceptDeal(args: { deal_id: string }, backendUrl: string) {
  const s = requireSession()
  const { ok: aOk, data } = await api('POST', `/api/deals/${args.deal_id}/accept`, {}, s.apiKey, backendUrl) as { ok: boolean; data: { status?: string; error?: string } }
  if (!aOk) throw new Error(`Accept failed: ${data.error ?? JSON.stringify(data)}`)
  return ok(`DEAL_ACCEPTED\nDEAL_ID: ${args.deal_id}\nSTATUS: ${data.status}`)
}

async function handleUploadPayload(args: { deal_id: string }, backendUrl: string) {
  const s   = requireSession()
  const buf = getDealPayload(args.deal_id)
  if (!buf) throw new Error(`No payload for deal ${args.deal_id}. Re-list to regenerate.`)

  // Upload directly to 0G Storage from the CLI — backend never sees raw bytes
  const wallet = loadOrCreateWallet()
  const { rootHash, txHash } = await uploadToZeroG(args.deal_id, buf, wallet.privateKey)

  // Notify the backend of the rootHash so it can verify & advance the deal state
  const { ok: confOk, data: confData } = await api(
    'POST', `/api/deals/${args.deal_id}/confirm-upload`,
    { rootHash, txHash },
    s.apiKey, backendUrl,
  ) as { ok: boolean; data: { status?: string; error?: string } }

  if (!confOk) throw new Error(`Confirm-upload failed: ${confData.error ?? JSON.stringify(confData)}`)
  deleteDealPayload(args.deal_id)
  return ok(
    `PAYLOAD_UPLOADED\nDEAL_ID: ${args.deal_id}\nROOT_HASH: ${rootHash}\n` +
    `TX_HASH: ${txHash}\nSTATUS: ${confData.status ?? 'VERIFYING'}\n` +
    `\nData uploaded directly to 0G Storage — backend received rootHash only.`,
  )
}

async function handleCounterNegotiation(args: { negotiation_id: string; counter_price: number; message?: string }, backendUrl: string) {
  const s = requireSession()
  const { ok: cOk, data } = await api('POST', `/api/negotiations/${args.negotiation_id}/counter`,
    { counterPrice: args.counter_price, message: args.message ?? '' }, s.apiKey, backendUrl) as { ok: boolean; data: { rounds?: number; error?: string } }
  if (!cOk) throw new Error(`Counter failed: ${data.error}`)
  return ok(`COUNTER_SENT\nNEGOTIATION_ID: ${args.negotiation_id}\nCOUNTER_PRICE: ${args.counter_price} USDC`)
}

async function handleAcceptNegotiation(args: { negotiation_id: string }, backendUrl: string) {
  const s = requireSession()
  const { ok: aOk, data } = await api('POST', `/api/negotiations/${args.negotiation_id}/accept`, {}, s.apiKey, backendUrl) as { ok: boolean; data: { offerId?: string; finalPrice?: number; error?: string } }
  if (!aOk) throw new Error(`Accept failed: ${data.error}`)
  return ok(`NEGOTIATION_ACCEPTED\nNEGOTIATION_ID: ${args.negotiation_id}\nFINAL_PRICE: ${data.finalPrice} USDC\nOFFER_ID: ${data.offerId ?? 'n/a'}`)
}

async function handleRejectNegotiation(args: { negotiation_id: string }, backendUrl: string) {
  const s = requireSession()
  const { ok: rOk, data } = await api('POST', `/api/negotiations/${args.negotiation_id}/reject`, {}, s.apiKey, backendUrl) as { ok: boolean; data: Record<string, unknown> }
  if (!rOk) throw new Error(`Reject failed: ${JSON.stringify(data)}`)
  return ok(`NEGOTIATION_REJECTED\nNEGOTIATION_ID: ${args.negotiation_id}`)
}

async function handleDiscover(args: { category?: string; search?: string; max_price_usdc?: number }, backendUrl: string) {
  let path = '/api/listings?'
  if (args.category)       path += `category=${encodeURIComponent(args.category)}&`
  if (args.search)         path += `search=${encodeURIComponent(args.search)}&`
  if (args.max_price_usdc) path += `maxPrice=${args.max_price_usdc}&`

  const { ok: fetchOk, data } = await api('GET', path.replace(/&$/, ''), undefined, undefined, backendUrl)
  if (!fetchOk) throw new Error(`Discover failed: ${JSON.stringify(data)}`)
  const listings = data as Array<{ listingId: string; title: string; priceUSDC: number; category: string }>
  if (!listings.length) return ok('NO_LISTINGS')
  return ok(`LISTINGS (${listings.length})\n` + listings.map(l =>
    `  ${l.listingId.slice(0, 8)}…  ${l.title.slice(0, 60).padEnd(60)}  ${l.priceUSDC} USDC  [${l.category}]`).join('\n'))
}

async function handleNegotiate(args: { listing_id: string; proposed_price_usdc: number; message?: string }, backendUrl: string) {
  const s = requireSession()
  let listingId = args.listing_id
  if (listingId.length < 36) {
    const { ok: fetchOk, data } = await api('GET', '/api/listings', undefined, undefined, backendUrl)
    if (fetchOk) {
      const match = (data as Array<{ listingId: string }>).find(l => l.listingId.startsWith(listingId))
      if (match) listingId = match.listingId
    }
  }
  const { ok: negOk, data } = await api('POST', '/api/negotiations',
    { listingId, proposedPrice: args.proposed_price_usdc, message: args.message ?? `Opening bid` },
    s.apiKey, backendUrl) as { ok: boolean; data: { negotiationId?: string; status?: string; error?: string } }
  if (!negOk || !data.negotiationId) throw new Error(`Negotiation failed: ${data.error}`)
  return ok(`NEGOTIATION_OPENED\nNEGOTIATION_ID: ${data.negotiationId}\nLISTING_ID: ${listingId}\nPROPOSED_PRICE: ${args.proposed_price_usdc} USDC`)
}

async function handleCreateDeal(args: { offer_id: string }, backendUrl: string) {
  const s = requireSession()
  const { ok: dealOk, data } = await api('POST', '/api/deals', { offerId: args.offer_id }, s.apiKey, backendUrl) as { ok: boolean; data: { dealId?: string; error?: string } }
  if (!dealOk || !data.dealId) throw new Error(`Deal creation failed: ${data.error}`)
  return ok(`DEAL_CREATED\nDEAL_ID: ${data.dealId}\nOFFER_ID: ${args.offer_id}\n\nNext: phantom_lock_funds deal_id=${data.dealId}`)
}

async function handleLockFunds(args: { deal_id: string }, backendUrl: string) {
  const s      = requireSession()
  const wallet = loadOrCreateWallet()
  const { ok: fetchOk, data: deal } = await api('GET', `/api/deals/${args.deal_id}`, undefined, s.apiKey, backendUrl) as { ok: boolean; data: { sellerEphemeralAddress?: string; priceUSDC?: string; error?: string } }
  if (!fetchOk || !deal.sellerEphemeralAddress || !deal.priceUSDC) throw new Error(`Could not fetch deal: ${deal.error}`)

  const { txHash } = await lockFundsInVault({
    dealId: args.deal_id, sellerAddress: deal.sellerEphemeralAddress,
    amountEth: parseFloat(deal.priceUSDC), privateKey: wallet.privateKey,
  })

  const { ok: lockOk, data: lockData } = await api('POST', `/api/deals/${args.deal_id}/lock`,
    { lockTxHash: txHash }, s.apiKey, backendUrl) as { ok: boolean; data: { status?: string; error?: string } }
  if (!lockOk) throw new Error(`Lock notification failed: ${lockData.error}`)

  return ok(`FUNDS_LOCKED\nDEAL_ID: ${args.deal_id}\nTX_HASH: ${txHash}\nAMOUNT: ${deal.priceUSDC} ETH\nEXPLORER: https://sepolia.etherscan.io/tx/${txHash}`)
}

async function handleMyDeals(backendUrl: string) {
  const s = requireSession()
  const { ok: fetchOk, data } = await api('GET', '/api/deals', undefined, s.apiKey, backendUrl)
  if (!fetchOk) throw new Error(`Failed: ${JSON.stringify(data)}`)
  const deals = (Array.isArray(data) ? data : (data as { deals?: unknown[] }).deals ?? []) as Array<{ dealId: string; status: string; priceUSDC?: string }>
  if (!deals.length) return ok('NO_ACTIVE_DEALS')
  return ok(`YOUR DEALS (${deals.length})\n` + deals.map(d => `  ${d.dealId.slice(0, 8)}…  ${d.status}  ${d.priceUSDC ?? '?'} USDC`).join('\n'))
}

async function handleDealStatus(args: { deal_id: string }, backendUrl: string) {
  const s = requireSession()
  const { ok: fetchOk, data } = await api('GET', `/api/deals/${args.deal_id}`, undefined, s.apiKey, backendUrl) as { ok: boolean; data: Record<string, unknown> }
  if (!fetchOk) throw new Error(`Deal not found: ${JSON.stringify(data)}`)
  return ok('DEAL_STATUS\n' + Object.entries(data).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join('\n'))
}

// ── AXL handlers ─────────────────────────────────────────────────────────────

async function handleAskSeller(
  args: { listing_id: string; question: string },
  backendUrl: string,
) {
  const s = requireSession()
  const w = loadOrCreateWallet()
  const myAxlPubkey = walletToAxlPubkey(w.address)

  // Fetch seller's AXL pubkey via the blind contact endpoint — no agentId exposed
  const { ok: contactOk, data: contact } = await api(
    'GET', `/api/listings/${args.listing_id}/contact`,
    undefined, undefined, backendUrl,
  ) as { ok: boolean; data: { sellerAxlPubkey?: string; error?: string } }

  if (!contactOk || !contact.sellerAxlPubkey) {
    throw new Error(`Cannot reach seller for listing ${args.listing_id}: ${contact.error ?? 'not found'}`)
  }

  const payload = {
    type: 'data_inquiry',
    fromAxlPubkey: myAxlPubkey,
    listingId: args.listing_id,
    question: args.question,
    timestamp: new Date().toISOString(),
  }

  const { ok: sendOk, data } = await api(
    'POST', '/api/messages/send',
    { destinationAxlPubkey: contact.sellerAxlPubkey, payload },
    s.apiKey, backendUrl,
  ) as { ok: boolean; data: { error?: string } }

  if (!sendOk) throw new Error(`Failed to send inquiry: ${data.error ?? JSON.stringify(data)}`)

  return ok(
    `INQUIRY_SENT\nLISTING_ID: ${args.listing_id}\nQUESTION: ${args.question}\n\n` +
    `The seller will receive your question encrypted via AXL.\n` +
    `Your AXL pubkey (for seller to reply): ${myAxlPubkey}\n\n` +
    `Use phantom_read_axl_messages to check for the seller's reply.`,
  )
}

async function handleReplyToInquiry(
  args: { buyer_axl_pubkey: string; listing_id: string; answer: string },
  backendUrl: string,
) {
  const s = requireSession()

  const payload = {
    type: 'data_inquiry_reply',
    listingId: args.listing_id,
    answer: args.answer,
    timestamp: new Date().toISOString(),
  }

  const { ok: sendOk, data } = await api(
    'POST', '/api/messages/send',
    { destinationAxlPubkey: args.buyer_axl_pubkey, payload },
    s.apiKey, backendUrl,
  ) as { ok: boolean; data: { error?: string } }

  if (!sendOk) throw new Error(`Failed to send reply: ${data.error ?? JSON.stringify(data)}`)

  return ok(
    `REPLY_SENT\nTO_BUYER: ${args.buyer_axl_pubkey}\nLISTING_ID: ${args.listing_id}\n` +
    `ANSWER: ${args.answer}\n\nThe buyer will receive your reply via AXL. Raw data was NOT sent.`,
  )
}

async function handleMyNegotiations(backendUrl: string) {
  const s = requireSession()
  const { ok: fetchOk, data } = await api('GET', '/api/negotiations', undefined, s.apiKey, backendUrl)
  if (!fetchOk) throw new Error(`Failed: ${JSON.stringify(data)}`)
  const negs = data as Array<{
    negotiationId: string; listingId: string; listedPrice: number;
    currentPrice: number; status: string; rounds: unknown[]; role: string
  }>
  if (!negs.length) return ok('NO_NEGOTIATIONS\nNo active or past negotiations.')

  const lines = negs.map(n => {
    const action =
      n.status === 'PENDING'   && n.role === 'seller' ? ' ← COUNTER or ACCEPT needed' :
      n.status === 'COUNTERED' && n.role === 'buyer'  ? ' ← COUNTER or ACCEPT needed' :
      n.status === 'ACCEPTED'                         ? ' ← CREATE DEAL now' : ''
    return (
      `  ${n.negotiationId.slice(0, 8)}…  [${n.status.padEnd(9)}]  ` +
      `listed ${n.listedPrice} → current ${n.currentPrice} USDC  ` +
      `${n.rounds.length} round(s)  [${n.role}]${action}`
    )
  })
  return ok(
    `YOUR NEGOTIATIONS (${negs.length})\n${lines.join('\n')}\n\n` +
    `Use phantom_get_negotiation negotiation_id=<id> for full round history and action hints.`,
  )
}

async function handleGetNegotiation(args: { negotiation_id: string }, backendUrl: string) {
  const s = requireSession()
  const { ok: fetchOk, data } = await api(
    'GET', `/api/negotiations/${args.negotiation_id}`,
    undefined, s.apiKey, backendUrl,
  ) as { ok: boolean; data: Record<string, unknown> & {
    rounds?: Array<{ by: string; price: number; message: string; at: number }>;
    status?: string; currentPrice?: number; listedPrice?: number; role?: string;
  }}
  if (!fetchOk) throw new Error(`Negotiation not found: ${JSON.stringify(data)}`)

  const rounds = (data.rounds ?? []).map((r, i) =>
    `  [${i + 1}] ${r.by.toUpperCase().padEnd(6)}  ${r.price} USDC  "${r.message}"  ${new Date(r.at).toISOString().slice(11, 19)}`
  ).join('\n')

  const actionHint =
    data.status === 'PENDING'   && data.role === 'seller' ?
      '\nNEXT_ACTION: phantom_counter_negotiation OR phantom_accept_negotiation' :
    data.status === 'COUNTERED' && data.role === 'buyer'  ?
      '\nNEXT_ACTION: phantom_counter_negotiation OR phantom_accept_negotiation' :
    data.status === 'ACCEPTED' ?
      '\nNEXT_ACTION: phantom_create_deal (use offerId from NEGOTIATION_ACCEPTED notification)' :
    data.status === 'REJECTED' ?
      '\nSTATUS: Rejected — start a new negotiation with phantom_negotiate' : ''

  return ok(
    `NEGOTIATION: ${args.negotiation_id}\n` +
    `STATUS: ${data.status}   ROLE: ${data.role}\n` +
    `LISTED_PRICE: ${data.listedPrice} USDC   CURRENT_PRICE: ${data.currentPrice} USDC\n` +
    `LISTING_ID: ${data.listingId}\n` +
    `ROUNDS:\n${rounds || '  (no rounds yet)'}` +
    actionHint,
  )
}


  args: { role?: 'buyer' | 'seller' },
  backendUrl: string,
  webhookHost: string,
  webhookPort: number,
) {
  const existing = getSession()
  if (existing) {
    const w = loadOrCreateWallet()
    const axlPubkey = walletToAxlPubkey(w.address)
    return ok(
      `ALREADY_INITIALIZED\nAGENT_ID: ${existing.agentId}\nROLE: ${existing.role}\n` +
      `WALLET: ${w.address}\nAXL_PUBKEY: ${axlPubkey}\n\n` +
      `Session active from ~/.phantom/session.json\nNo action taken.`,
    )
  }
  return handleRegister({ role: args.role ?? 'buyer' }, backendUrl, webhookHost, webhookPort)
}

function handleAxlInfo() {
  const w = loadOrCreateWallet()
  const axlPubkey = walletToAxlPubkey(w.address)
  const s = getSession()
  const sessionLine = s
    ? `AGENT_ID: ${s.agentId}\nROLE: ${s.role}\nBACKEND: ${s.backendUrl}`
    : 'STATUS: Not registered — call phantom_init first.'
  return ok(
    `AXL IDENTITY\nWALLET: ${w.address}\nAXL_PUBKEY: ${axlPubkey}\n` +
    `EXPLORER: https://sepolia.etherscan.io/address/${w.address}\n${sessionLine}`,
  )
}

async function handleSendAxlMessage(
  args: { destination_axl_pubkey: string; message: string; deal_id?: string },
  backendUrl: string,
) {
  const s = requireSession()
  const payload = {
    type: 'agent_message',
    fromAgentId: s.agentId,
    message: args.message,
    dealId: args.deal_id ?? null,
    timestamp: new Date().toISOString(),
  }
  const { ok: sendOk, data } = await api(
    'POST', '/api/messages/send',
    { destinationAxlPubkey: args.destination_axl_pubkey, payload },
    s.apiKey, backendUrl,
  ) as { ok: boolean; data: { error?: string } }
  if (!sendOk) throw new Error(`AXL send failed: ${data.error ?? JSON.stringify(data)}`)
  return ok(
    `MESSAGE_SENT\nTO: ${args.destination_axl_pubkey}\n` +
    `DEAL_ID: ${args.deal_id ?? 'none'}\nMESSAGE: ${args.message}`,
  )
}

async function handleReadAxlMessages(backendUrl: string) {
  const s = requireSession()
  const { ok: fetchOk, data } = await api('GET', '/api/messages/inbox', undefined, s.apiKey, backendUrl)
  if (!fetchOk) throw new Error(`Inbox fetch failed: ${JSON.stringify(data)}`)
  const messages = data as Array<{ fromPeerId?: string; message: unknown }>
  if (!messages.length) return ok('INBOX_EMPTY\nNo pending AXL messages.')

  const lines = messages.map((m, i) => {
    const msg = m.message as Record<string, unknown>
    const type    = (msg?.type as string) ?? 'unknown'
    const from    = m.fromPeerId ?? (msg?.fromAxlPubkey as string) ?? 'unknown'
    const dealId  = (msg?.dealId as string) ?? null
    const listingId = (msg?.listingId as string) ?? null

    let body = ''
    let action = ''

    if (type === 'data_inquiry') {
      body   = `QUESTION: ${msg.question}`
      action = `ACTION: phantom_reply_to_inquiry buyer_axl_pubkey="${from}" listing_id="${listingId}" answer="<your answer>"`
    } else if (type === 'data_inquiry_reply') {
      body   = `ANSWER: ${msg.answer}`
      action = `ACTION: If satisfied, phantom_negotiate listing_id="${listingId}" proposed_price_usdc=<price>`
    } else if (type === 'agent_message') {
      body   = `MESSAGE: ${msg.message}`
      action = dealId ? `DEAL_ID: ${dealId}` : ''
    } else {
      body = JSON.stringify(msg)
    }

    return (
      `[${i + 1}] TYPE: ${type}  FROM: ${from.slice(0, 16)}…\n` +
      (listingId ? `     LISTING: ${listingId}\n` : '') +
      `     ${body}\n` +
      (action ? `     ${action}` : '')
    )
  })

  return ok(`AXL INBOX (${messages.length} message${messages.length === 1 ? '' : 's'})\n\n${lines.join('\n\n')}`)
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function startMcpServer(autoRole?: 'buyer' | 'seller'): Promise<void> {
  const BACKEND_URL   = getBackendUrl()
  const WEBHOOK_PORT  = getWebhookPort()
  const EXPLICIT_HOST = getWebhookHost()
  let   WEBHOOK_HOST  = EXPLICIT_HOST ?? `http://localhost:${WEBHOOK_PORT}`

  // Start webhook receiver
  try {
    const publicUrl = await startWebhookServer(WEBHOOK_PORT, EXPLICIT_HOST)
    WEBHOOK_HOST = publicUrl
    const isTunnel = publicUrl.includes('localtunnel.me') || publicUrl.includes('loca.lt')
    process.stderr.write(`[phantom] Webhook :${WEBHOOK_PORT} → ${publicUrl}${isTunnel ? ' (ephemeral tunnel)' : ''}\n`)
  } catch (e: unknown) {
    process.stderr.write(`[phantom] WARNING: webhook failed: ${(e as Error).message}\n`)
  }

  const existing = loadSession()
  if (existing) {
    process.stderr.write(`[phantom] Session restored: agentId=${existing.agentId} role=${existing.role}\n`)
  } else if (autoRole) {
    process.stderr.write(`[phantom] No session — auto-registering as ${autoRole}…\n`)
    try {
      const res = await handleRegister({ role: autoRole }, BACKEND_URL, WEBHOOK_HOST, WEBHOOK_PORT)
      process.stderr.write(`[phantom] ${res.content[0].text.split('\n')[0]}\n`)
    } catch (e: unknown) {
      process.stderr.write(`[phantom] Auto-register failed: ${(e as Error).message}\n`)
      process.stderr.write(`[phantom] Call phantom_init role=${autoRole} to retry.\n`)
    }
  } else {
    process.stderr.write(`[phantom] No session — call phantom_init to get started.\n`)
  }
  process.stderr.write(`[phantom] Backend: ${BACKEND_URL}\n[phantom] Ready.\n`)

  const mcpServer = new Server(
    { name: 'phantom-protocol', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params
    try {
      switch (name) {
        case 'phantom_register':       return await handleRegister(args as { role: 'buyer' | 'seller' }, BACKEND_URL, WEBHOOK_HOST, WEBHOOK_PORT)
        case 'phantom_wallet':         return await handleWallet()
        case 'phantom_balance':        return await handleBalance()
        case 'phantom_notifications':  return handleNotifications()
        case 'phantom_list_report':    return await handleListReport(args as Parameters<typeof handleListReport>[0], BACKEND_URL)
        case 'phantom_my_listings':    return await handleMyListings(BACKEND_URL)
        case 'phantom_accept_deal':    return await handleAcceptDeal(args as { deal_id: string }, BACKEND_URL)
        case 'phantom_upload_payload': return await handleUploadPayload(args as { deal_id: string }, BACKEND_URL)
        case 'phantom_counter_negotiation': return await handleCounterNegotiation(args as Parameters<typeof handleCounterNegotiation>[0], BACKEND_URL)
        case 'phantom_accept_negotiation':  return await handleAcceptNegotiation(args as { negotiation_id: string }, BACKEND_URL)
        case 'phantom_reject_negotiation':  return await handleRejectNegotiation(args as { negotiation_id: string }, BACKEND_URL)
        case 'phantom_discover':       return await handleDiscover(args as Parameters<typeof handleDiscover>[0], BACKEND_URL)
        case 'phantom_negotiate':      return await handleNegotiate(args as Parameters<typeof handleNegotiate>[0], BACKEND_URL)
        case 'phantom_create_deal':    return await handleCreateDeal(args as { offer_id: string }, BACKEND_URL)
        case 'phantom_lock_funds':     return await handleLockFunds(args as { deal_id: string }, BACKEND_URL)
        case 'phantom_my_deals':       return await handleMyDeals(BACKEND_URL)
        case 'phantom_deal_status':    return await handleDealStatus(args as { deal_id: string }, BACKEND_URL)
        case 'phantom_init':           return await handleInit(args as { role?: 'buyer' | 'seller' }, BACKEND_URL, WEBHOOK_HOST, WEBHOOK_PORT)
        case 'phantom_axl_info':       return handleAxlInfo()
        case 'phantom_send_axl_message': return await handleSendAxlMessage(args as Parameters<typeof handleSendAxlMessage>[0], BACKEND_URL)
        case 'phantom_read_axl_messages': return await handleReadAxlMessages(BACKEND_URL)
        case 'phantom_ask_seller':        return await handleAskSeller(args as Parameters<typeof handleAskSeller>[0], BACKEND_URL)
        case 'phantom_reply_to_inquiry':  return await handleReplyToInquiry(args as Parameters<typeof handleReplyToInquiry>[0], BACKEND_URL)
        case 'phantom_my_negotiations':   return await handleMyNegotiations(BACKEND_URL)
        case 'phantom_get_negotiation':   return await handleGetNegotiation(args as { negotiation_id: string }, BACKEND_URL)
        default:                       return err(`Unknown tool: ${name}`)
      }
    } catch (e: unknown) {
      return err((e as Error).message)
    }
  })

  const transport = new StdioServerTransport()
  await mcpServer.connect(transport)
}
