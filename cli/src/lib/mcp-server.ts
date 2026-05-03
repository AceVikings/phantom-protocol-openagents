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
  loadSession, saveSession, getSession, clearSession,
  getCurrentIdentity, setCurrentIdentity,
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

const ENS_PARENT = 'phantom-protocol.eth'
function ensLine(role: string): string {
  return `ENS: ${role}-<dealId>.${ENS_PARENT}  (subname minted when deal starts)`
}

function dealEnsBlock(dealId: string): string {
  return (
    `ENS SUBNAMES (ephemeral, Sepolia NameWrapper — each deal gets unique on-chain identities)
` +
    `  buyer-${dealId}.${ENS_PARENT}  →  buyer's ephemeral address\n` +
    `  seller-${dealId}.${ENS_PARENT}  →  seller's ephemeral address\n` +
    `  deal-${dealId}.${ENS_PARENT}   →  vault escrow address`
  )
}

async function fetchBalances(address: string): Promise<string> {
  const [ethBal, ogRaw] = await Promise.all([
    getEthBalance(address).catch(() => null),
    getZeroGBalance(address).catch(() => null),
  ])
  const eth = ethBal ? `${parseFloat(ethBal.eth).toFixed(6)} ETH` : 'unknown'
  const og  = ogRaw  ? `${parseFloat(ogRaw).toFixed(6)} OG`        : 'unknown'
  return `  ETH (Sepolia): ${eth}\n  OG  (0G):      ${og}`
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
      'Poll for pending protocol events (incoming deals, negotiation counters, status changes). ' +
      'Returns queued events and clears the queue. ' +
      'IMPORTANT: You MUST call this repeatedly while waiting — events are push-delivered via webhook. ' +
      'Seller flow: after listing, call phantom_notifications every few seconds until NEGOTIATION_PROPOSAL or DEAL_OFFER arrives. ' +
      'Buyer flow: after phantom_negotiate, call phantom_watch_negotiation to block until seller responds (preferred). ' +
      'If no webhook events arrive, also call phantom_my_negotiations / phantom_my_deals to poll backend directly.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'phantom_list_report',
    description:
      'SELLER: Publish a research report on the Phantom marketplace.',
    inputSchema: {
      type: 'object',
      properties: {
        topic:      { type: 'string' },
        content:    { type: 'string' },
        price_eth:  { type: 'number', description: 'Price in Sepolia ETH (NOT USDC — the vault locks ETH).' },
        category:   { type: 'string' },
      },
      required: ['topic', 'content', 'price_eth'],
    },
  },
  {
    name: 'phantom_my_listings',
    description: 'SELLER: Show your active listings.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'phantom_accept_deal',
    description: 'SELLER (or BUYER for self-deals): Accept an incoming deal offer. For self-deals (same wallet acting as buyer + seller), the buyer identity can also call this to unblock a deal stuck in MATCHMAKING status. Use phantom_deal_status to check current status first.',

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
        category:      { type: 'string' },
        search:        { type: 'string' },
        max_price_eth: { type: 'number', description: 'Max price in Sepolia ETH.' },
      },
    },
  },
  {
    name: 'phantom_negotiate',
    description: 'BUYER: Open a price negotiation on a listing.',
    inputSchema: {
      type: 'object',
      properties: {
        listing_id:         { type: 'string' },
        proposed_price_eth: { type: 'number', description: 'Proposed price in Sepolia ETH (NOT USDC).' },
        message:            { type: 'string' },
      },
      required: ['listing_id', 'proposed_price_eth'],
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
      'Call this first before any other phantom tool. ' +
      'Called with NO arguments → auto-registers BOTH a buyer and a seller identity sharing the same wallet. ' +
      'After dual-init, buyer-side tools (discover, negotiate, lock_funds, create_deal) automatically use the buyer identity ' +
      'and seller-side tools (my_listings, accept_deal, upload_payload) automatically use the seller identity — ' +
      'no manual phantom_switch_identity needed. ' +
      'Called with role= → registers a single identity for that role. ' +
      'If you receive "Invalid API key" errors, the backend was restarted — call phantom_init with force=true to re-register.',
    inputSchema: {
      type: 'object',
      properties: {
        role:         { type: 'string', enum: ['buyer', 'seller'], description: 'Agent role. Omit to auto-register both buyer and seller identities sharing one wallet.' },
        identity:     { type: 'string', description: 'Named persona (default: "default"). Use different names to run buyer and seller in the same session, e.g. identity="alice-seller".' },
        display_name: { type: 'string', description: 'Human-readable label stored with the identity (e.g. "Alice the Data Seller"). Shown in all outputs.' },
        force:        { type: 'boolean', description: 'Force re-registration even if a session already exists. Use when the backend was restarted and the saved API key is no longer valid (error: "Invalid API key").' },
      },
    },
  },
  {
    name: 'phantom_switch_identity',
    description:
      'Switch the active persona to a previously registered identity. ' +
      'After switching, all tools act as the switched-to identity. ' +
      'Use phantom_init to create a new identity, then phantom_switch_identity to toggle between them.',
    inputSchema: {
      type: 'object',
      properties: {
        identity: { type: 'string', description: 'The identity name to switch to (must have been created with phantom_init).' },
      },
      required: ['identity'],
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
      'Includes negotiation IDs, price rounds, and required next actions. ' +
      'POLLING: call this every few seconds while waiting, OR use phantom_watch_negotiation to block until a change occurs.',
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
  {
    name: 'phantom_watch_negotiation',
    description:
      'Block until a negotiation changes status or a new round is added (counter offer / acceptance / rejection). ' +
      'PREFERRED WAITING MECHANISM — use instead of polling phantom_notifications manually. ' +
      'After phantom_negotiate (buyer) or phantom_counter_negotiation (seller), immediately call this to wait for the other party. ' +
      'Returns immediately on any change with full state and NEXT_ACTION hint — follow the hint automatically. ' +
      'Times out after timeout_seconds (default 90) — if timed out, call again to keep waiting. ' +
      'Autonomous loop: phantom_negotiate → phantom_watch_negotiation → [counter or accept] → phantom_watch_negotiation → phantom_create_deal → phantom_lock_funds.',
    inputSchema: {
      type: 'object',
      properties: {
        negotiation_id:  { type: 'string', description: 'The negotiation UUID to watch.' },
        timeout_seconds: { type: 'number',  description: 'Max seconds to wait before returning (default 90, max 300).' },
      },
      required: ['negotiation_id'],
    },
  },
]

// ── Tool handlers ─────────────────────────────────────────────────────────────

/** Push the current webhookHost to the backend for an already-registered agent. */
async function refreshWebhookUrl(backendUrl: string, webhookHost: string, apiKey: string): Promise<void> {
  const webhookUrl = `${webhookHost}/webhook`
  const { ok } = await api('PATCH', '/api/agents/me', { webhookUrl }, apiKey, backendUrl)
  if (!ok) process.stderr.write(`[phantom] WARNING: Could not refresh webhook URL on backend\n`)
  else     process.stderr.write(`[phantom] Webhook URL refreshed → ${webhookUrl}\n`)
}

async function handleRegister(
  args: { role: 'buyer' | 'seller'; displayName?: string },
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

  saveSession({
    agentId: data.agentId, apiKey: data.apiKey, role: args.role,
    webhookPort, backendUrl, displayName: args.displayName,
  })

  const identity   = getCurrentIdentity()
  const sessionPath = identity === 'default' ? '~/.phantom/session.json' : `~/.phantom/${identity}-session.json`
  const label      = args.displayName ? `${args.displayName} (${identity})` : identity
  const balances   = await fetchBalances(wallet.address)

  return ok(
    `REGISTERED\n` +
    `IDENTITY:   ${label}\n` +
    `AGENT_ID:   ${data.agentId}\n` +
    `ROLE:       ${args.role}\n` +
    `\n━━ WALLET (Sepolia) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `  ADDRESS:  ${wallet.address}\n` +
    `  AXL KEY:  ${axlPubkey}\n` +
    `  ENS:      ${args.role}-<dealId>.${ENS_PARENT}  (per-deal ephemeral)\n` +
    `${balances}\n` +
    `\n  ⚡ FUND THIS ADDRESS to participate in the marketplace:\n` +
    `     Sepolia ETH → https://sepoliafaucet.com  (for gas + escrow)\n` +
    `     0G OG       → https://hub.0g.ai/faucet   (for data storage)\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `WEBHOOK:    ${webhookUrl}\n` +
    `SESSION:    ${sessionPath}`,
  )
}

async function handleWallet() {
  const w        = loadOrCreateWallet()
  const s        = getSession()
  const identity = getCurrentIdentity()
  const walletPath = identity === 'default' ? '~/.phantom/wallet.json' : `~/.phantom/${identity}-wallet.json`
  const label    = s?.displayName ? `${s.displayName} (${identity})` : identity
  const balances = await fetchBalances(w.address)
  const ensInfo  = s ? `\n  ENS:      ${s.role}-<dealId>.${ENS_PARENT}  (per-deal ephemeral)` : ''
  return ok(
    `WALLET\n` +
    `IDENTITY:  ${label}\n` +
    `\n━━ WALLET (Sepolia) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `  ADDRESS:  ${w.address}${ensInfo}\n` +
    `${balances}\n` +
    `\n  ⚡ SEND FUNDS TO THIS ADDRESS:\n` +
    `     Sepolia ETH → https://sepoliafaucet.com\n` +
    `     0G OG       → https://hub.0g.ai/faucet\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `EXPLORER:  https://sepolia.etherscan.io/address/${w.address}\n` +
    `KEY FILE:  ${walletPath}`,
  )
}

async function handleBalance() {
  const w = loadOrCreateWallet()
  const [sepoliaBalance, ogRaw] = await Promise.all([
    getEthBalance(w.address),
    getZeroGBalance(w.address).catch(() => null),
  ])
  const eth = parseFloat(sepoliaBalance.eth).toFixed(6)
  const og  = ogRaw !== null ? parseFloat(ogRaw).toFixed(6) : null
  const identity = getCurrentIdentity()
  const s = getSession()
  const label = s?.displayName ? `${s.displayName} (${identity})` : identity
  return ok(
    `BALANCES\n` +
    `IDENTITY:  ${label}\n` +
    `\n━━ SEND FUNDS HERE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `  ADDRESS:       ${w.address}\n` +
    `  ETH (Sepolia): ${eth} ETH  ← gas + escrow payments\n` +
    (og !== null ? `  OG  (0G):      ${og} OG   ← data storage\n` : '') +
    `\n  Faucets:\n` +
    `     Sepolia ETH → https://sepoliafaucet.com\n` +
    `     0G OG       → https://hub.0g.ai/faucet\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
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
  args: { topic: string; content: string; price_eth: number; category?: string },
  backendUrl: string,
) {
  const s        = requireSession()
  const buf      = Buffer.from(args.content, 'utf8')
  const sha256   = createHash('sha256').update(buf).digest('hex')
  const category = args.category ?? 'research'

  const { ok: offerOk, data: offerData } = await api(
    'POST', '/api/offers',
    { description: args.content.slice(0, 200), payloadType: category, priceUSDC: args.price_eth,
      tokenOut: 'ETH', expectedSizeBytes: buf.length, expectedSha256: sha256 },
    s.apiKey, backendUrl,
  ) as { ok: boolean; data: { offerId?: string; error?: string } }

  if (!offerOk || !offerData.offerId) throw new Error(`Offer creation failed: ${offerData.error}`)
  storeOfferPayload(offerData.offerId, buf)

  const { ok: listOk, data: listData } = await api(
    'POST', '/api/listings',
    { title: `${args.topic.slice(0, 80)} — Research Report`, description: args.content.slice(0, 200),
      category, tags: args.topic.toLowerCase().split(/\s+/).slice(0, 5),
      priceUSDC: args.price_eth, offerId: offerData.offerId },
    s.apiKey, backendUrl,
  ) as { ok: boolean; data: { listingId?: string; error?: string } }

  if (!listOk || !listData.listingId) throw new Error(`Listing creation failed: ${listData.error}`)

  return ok(
    `LISTED\nLISTING_ID: ${listData.listingId}\nOFFER_ID: ${offerData.offerId}\nTOPIC: ${args.topic}\nPRICE: ${args.price_eth} ETH (Sepolia)\n\n` +
    `NEXT_ACTION (SELLER — you must wait and respond):\n` +
    `  phantom_my_negotiations          ← poll for incoming buyer proposals\n` +
    `  OR phantom_notifications         ← poll for NEGOTIATION_PROPOSAL events\n` +
    `  When proposal arrives → phantom_get_negotiation → phantom_counter_negotiation OR phantom_accept_negotiation`,
  )
}

async function handleMyListings(backendUrl: string) {
  const s = requireSession()
  const { ok: fetchOk, data } = await api('GET', '/api/listings', undefined, s.apiKey, backendUrl)
  if (!fetchOk) throw new Error(`Failed: ${JSON.stringify(data)}`)
  const listings = (data as Array<{ listingId: string; title: string; priceUSDC: number; category: string; active: boolean }>).filter(l => l.active)
  if (!listings.length) return ok('NO_ACTIVE_LISTINGS')
  return ok(
    `YOUR LISTINGS (${listings.length})\n` +
    listings.map(l => `  ${l.listingId}  ${l.title.slice(0, 55).padEnd(55)}  ${l.priceUSDC} ETH  [${l.category}]`).join('\n') +
    `\n\nSELLER WAITING LOOP:\n` +
    `  phantom_my_negotiations  ← check for incoming proposals (call repeatedly)\n` +
    `  phantom_my_deals         ← check for accepted deals awaiting your action\n` +
    `  phantom_notifications    ← drain webhook event queue`,
  )
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
  return ok(`COUNTER_SENT\nNEGOTIATION_ID: ${args.negotiation_id}\nCOUNTER_PRICE: ${args.counter_price} ETH (Sepolia)`)
}

async function handleAcceptNegotiation(args: { negotiation_id: string }, backendUrl: string) {
  const s = requireSession()
  const { ok: aOk, data } = await api('POST', `/api/negotiations/${args.negotiation_id}/accept`, {}, s.apiKey, backendUrl) as { ok: boolean; data: { offerId?: string; finalPrice?: number; error?: string } }
  if (!aOk) throw new Error(`Accept failed: ${data.error}`)
  return ok(`NEGOTIATION_ACCEPTED\nNEGOTIATION_ID: ${args.negotiation_id}\nFINAL_PRICE: ${data.finalPrice} ETH (Sepolia)\nOFFER_ID: ${data.offerId ?? 'n/a'}`)
}

async function handleRejectNegotiation(args: { negotiation_id: string }, backendUrl: string) {
  const s = requireSession()
  const { ok: rOk, data } = await api('POST', `/api/negotiations/${args.negotiation_id}/reject`, {}, s.apiKey, backendUrl) as { ok: boolean; data: Record<string, unknown> }
  if (!rOk) throw new Error(`Reject failed: ${JSON.stringify(data)}`)
  return ok(`NEGOTIATION_REJECTED\nNEGOTIATION_ID: ${args.negotiation_id}`)
}

async function handleDiscover(args: { category?: string; search?: string; max_price_eth?: number }, backendUrl: string) {
  let path = '/api/listings?'
  if (args.category)      path += `category=${encodeURIComponent(args.category)}&`
  if (args.search)        path += `search=${encodeURIComponent(args.search)}&`
  if (args.max_price_eth) path += `maxPrice=${args.max_price_eth}&`

  const { ok: fetchOk, data } = await api('GET', path.replace(/&$/, ''), undefined, undefined, backendUrl)
  if (!fetchOk) throw new Error(`Discover failed: ${JSON.stringify(data)}`)
  const listings = data as Array<{ listingId: string; title: string; priceUSDC: number; category: string }>
  if (!listings.length) return ok('NO_LISTINGS')
  return ok(`LISTINGS (${listings.length})\n` + listings.map(l =>
    `  ${l.listingId}  ${l.title.slice(0, 60).padEnd(60)}  ${l.priceUSDC} ETH  [${l.category}]`).join('\n'))
}

async function handleNegotiate(args: { listing_id: string; proposed_price_eth: number; message?: string }, backendUrl: string) {
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
    { listingId, proposedPrice: args.proposed_price_eth, message: args.message ?? `Opening bid` },
    s.apiKey, backendUrl) as { ok: boolean; data: { negotiationId?: string; status?: string; error?: string } }
  if (!negOk || !data.negotiationId) throw new Error(`Negotiation failed: ${data.error}`)
  return ok(
    `NEGOTIATION_OPENED\nNEGOTIATION_ID: ${data.negotiationId}\nLISTING_ID: ${listingId}\nPROPOSED_PRICE: ${args.proposed_price_eth} ETH (Sepolia)\n\n` +
    `NEXT_ACTION: phantom_watch_negotiation negotiation_id="${data.negotiationId}"  ← blocks until seller responds`,
  )
}

async function handleCreateDeal(args: { offer_id: string }, backendUrl: string) {
  const s = requireSession()
  const { ok: dealOk, data } = await api('POST', '/api/deals', { offerId: args.offer_id }, s.apiKey, backendUrl) as { ok: boolean; data: { dealId?: string; selfDeal?: boolean; status?: string; error?: string } }
  if (!dealOk || !data.dealId) throw new Error(`Deal creation failed: ${data.error}`)
  const selfNote = data.selfDeal ? '\nSELF_DEAL: auto-accepted (same wallet — skip phantom_accept_deal)' : ''
  return ok(
    `DEAL_CREATED\nDEAL_ID:   ${data.dealId}\nOFFER_ID:  ${args.offer_id}\nSTATUS:    ${data.status ?? 'MATCHMAKING'}${selfNote}\n\n` +
    `${dealEnsBlock(data.dealId)}\n\n` +
    `Next: phantom_lock_funds deal_id=${data.dealId}`,
  )
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
  const lines = (deals as Array<{ dealId: string; status: string; priceUSDC?: string; lockTxHash?: string; txHash?: string; rootHash?: string }>).map(d => {
    const hint =
      d.status === 'MATCHMAKING' ? `  ← phantom_accept_deal deal_id="${d.dealId}"  (stuck? call accept — works for self-deals too)` :
      d.status === 'LOCKING'     ? `  ← phantom_lock_funds deal_id="${d.dealId}"` :
      d.status === 'UPLOADING'   ? `  ← phantom_upload_payload deal_id="${d.dealId}"` :
      ''
    const txLine = [
      d.lockTxHash ? `    🔗 ETH: https://sepolia.etherscan.io/tx/${d.lockTxHash}` : '',
      d.txHash     ? `    🔗 0G:  https://chainscan-galileo.0g.ai/tx/${d.txHash}` : '',
      d.rootHash   ? `    📦 rootHash: ${d.rootHash}` : '',
    ].filter(Boolean).join('\n')
    return (
      `  ${d.dealId}  ${d.status}  ${d.priceUSDC ?? '?'} ETH${hint}\n` +
      `    └─ buyer-${d.dealId}.${ENS_PARENT}\n` +
      `       seller-${d.dealId}.${ENS_PARENT}\n` +
      `       deal-${d.dealId}.${ENS_PARENT}` +
      (txLine ? `\n${txLine}` : '')
    )
  })
  return ok(`YOUR DEALS (${deals.length})\n` + lines.join('\n'))
}

async function handleDealStatus(args: { deal_id: string }, backendUrl: string) {
  const s = requireSession()
  const { ok: fetchOk, data } = await api('GET', `/api/deals/${args.deal_id}`, undefined, s.apiKey, backendUrl) as { ok: boolean; data: Record<string, unknown> }
  if (!fetchOk) throw new Error(`Deal not found: ${JSON.stringify(data)}`)
  const fields = Object.entries(data).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join('\n')
  const status = (data.status as string) ?? ''
  const selfDealHint = (data.buyerEphemeralAddress as string)?.toLowerCase() === (data.sellerEphemeralAddress as string)?.toLowerCase()
    ? ' (self-deal: buyer and seller share the same wallet)'
    : ''
  const nextAction =
    status === 'MATCHMAKING'  ? `\nNEXT_ACTION: phantom_accept_deal deal_id="${args.deal_id}"  ← seller (or buyer for self-deals) must accept first${selfDealHint}` :
    status === 'LOCKING'     ? `\nNEXT_ACTION: phantom_lock_funds deal_id="${args.deal_id}"` :
    status === 'UPLOADING'   ? `\nNEXT_ACTION: phantom_upload_payload deal_id="${args.deal_id}"` :
    status === 'EXECUTING'   ? `\nNEXT_ACTION: phantom_get_deal_result deal_id="${args.deal_id}"  (or call phantom_release_payment)` :
    status === 'FAILED'      ? `\nNEXT_ACTION: phantom_refund deal_id="${args.deal_id}"  (deal failed — buyer can request refund)` :
    ''

  // Explorer links for on-chain transactions
  const lockTx  = data.lockTxHash  as string | undefined
  const zerogTx = data.txHash       as string | undefined
  const rootHash = data.rootHash    as string | undefined
  const txLinks = [
    lockTx  ? `  ETH (Sepolia vault lock) : https://sepolia.etherscan.io/tx/${lockTx}` : '',
    zerogTx ? `  0G Storage upload tx    : https://chainscan-galileo.0g.ai/tx/${zerogTx}` : '',
    rootHash ? `  0G file root hash       : ${rootHash}` : '',
  ].filter(Boolean).join('\n')

  return ok(
    `DEAL_STATUS\n${fields}\n\n` +
    (txLinks ? `━━ ON-CHAIN TRANSACTIONS ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n${txLinks}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` : '') +
    `${dealEnsBlock(args.deal_id)}${nextAction}`,
  )
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
    currentPrice: number; status: string; rounds: unknown[]; role: string; offerId?: string
  }>
  if (!negs.length) return ok('NO_NEGOTIATIONS\nNo active or past negotiations.')

  const lines = negs.map(n => {
    const action =
      n.status === 'PENDING'   && n.role === 'seller' ? ' ← COUNTER or ACCEPT needed' :
      n.status === 'COUNTERED' && n.role === 'buyer'  ? ' ← COUNTER or ACCEPT needed' :
      n.status === 'ACCEPTED' && n.offerId            ? ` ← phantom_create_deal offer_id="${n.offerId}"` :
      n.status === 'ACCEPTED'                         ? ' ← CREATE DEAL now (check notifications for offerId)' : ''
    return (
      `  ${n.negotiationId}  [${n.status.padEnd(9)}]  ` +
      `listed ${n.listedPrice} → current ${n.currentPrice} ETH  ` +
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
    `  [${i + 1}] ${r.by.toUpperCase().padEnd(6)}  ${r.price} ETH  "${r.message}"  ${new Date(r.at).toISOString().slice(11, 19)}`
  ).join('\n')

  const offerId = data.offerId as string | undefined
  const actionHint =
    data.status === 'PENDING'   && data.role === 'seller' ?
      '\nNEXT_ACTION: phantom_counter_negotiation OR phantom_accept_negotiation' :
    data.status === 'COUNTERED' && data.role === 'buyer'  ?
      '\nNEXT_ACTION: phantom_counter_negotiation OR phantom_accept_negotiation' :
    data.status === 'ACCEPTED' && offerId ?
      `\nNEXT_ACTION: phantom_create_deal offer_id="${offerId}"` :
    data.status === 'ACCEPTED' ?
      '\nNEXT_ACTION: phantom_create_deal (check phantom_notifications for offerId)' :
    data.status === 'REJECTED' ?
      '\nSTATUS: Rejected — start a new negotiation with phantom_negotiate' : ''

  return ok(
    `NEGOTIATION: ${args.negotiation_id}\n` +
    `STATUS: ${data.status}   ROLE: ${data.role}\n` +
    `LISTED_PRICE: ${data.listedPrice} ETH   CURRENT_PRICE: ${data.currentPrice} ETH\n` +
    `LISTING_ID: ${data.listingId}\n` +
    (offerId ? `OFFER_ID: ${offerId}\n` : '') +
    `ROUNDS:\n${rounds || '  (no rounds yet)'}` +
    actionHint,
  )
}

async function handleInit(
  args: { role?: 'buyer' | 'seller'; identity?: string; display_name?: string; force?: boolean },
  backendUrl: string,
  webhookHost: string,
  webhookPort: number,
) {
  // ── Dual-identity auto-init ──────────────────────────────────────────────────
  // Called with no role and no explicit identity → register both buyer + seller
  // sharing the single default wallet (~/.phantom/wallet.json).
  if (!args.role && !args.identity) {
    const results: string[] = []
    for (const role of ['buyer', 'seller'] as const) {
      setCurrentIdentity(role)
      if (args.force) clearSession()
      const existing = getSession()
      if (existing) {
        // Refresh webhook so backend can deliver notifications with new tunnel URL
        try { await refreshWebhookUrl(backendUrl, webhookHost, existing.apiKey) } catch { /* ignore */ }
        results.push(`${role.toUpperCase()}: already registered (agent ${existing.agentId}) — webhook refreshed`)
      } else {
        try {
          await handleRegister({ role }, backendUrl, webhookHost, webhookPort)
          results.push(`${role.toUpperCase()}: registered ✓`)
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e)
          results.push(`${role.toUpperCase()}: failed — ${msg}`)
        }
      }
    }
    setCurrentIdentity('buyer') // default active persona
    const w        = loadOrCreateWallet()
    const balances = await fetchBalances(w.address)
    return ok(
      `DUAL_INIT_COMPLETE\n\n` +
      results.join('\n') + '\n\n' +
      `━━ SHARED WALLET (Sepolia) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `  ADDRESS: ${w.address}\n` +
      `${balances}\n\n` +
      `  ⚡ FUND THIS ADDRESS to participate in the marketplace:\n` +
      `     Sepolia ETH → https://sepoliafaucet.com\n` +
      `     0G OG       → https://hub.0g.ai/faucet\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `ACTIVE: buyer\nUse phantom_switch_identity identity="seller" to act as seller.`,
    )
  }

  // ── Single-identity init (original behaviour) ────────────────────────────────
  setCurrentIdentity(args.identity ?? 'default')
  const identity = getCurrentIdentity()
  if (args.force) clearSession()
  const existing = getSession()
  if (existing) {
    // Refresh webhook URL — localtunnel generates a new URL on each restart
    try { await refreshWebhookUrl(backendUrl, webhookHost, existing.apiKey) } catch { /* ignore */ }
    const w          = loadOrCreateWallet()
    const axlPubkey  = walletToAxlPubkey(w.address)
    const label      = existing.displayName ? `${existing.displayName} (${identity})` : identity
    const balances   = await fetchBalances(w.address)
    return ok(
      `ALREADY_INITIALIZED\n` +
      `IDENTITY:  ${label}\n` +
      `AGENT_ID:  ${existing.agentId}\n` +
      `ROLE:      ${existing.role}\n` +
      `AXL_KEY:   ${axlPubkey}\n` +
      `WEBHOOK:   refreshed ✓\n` +
      `\n━━ WALLET (Sepolia) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `  ADDRESS:  ${w.address}\n` +
      `  ENS:      ${existing.role}-<dealId>.${ENS_PARENT}  (per-deal ephemeral)\n` +
      `${balances}\n` +
      `\n  ⚡ FUND THIS ADDRESS to participate in the marketplace:\n` +
      `     Sepolia ETH → https://sepoliafaucet.com\n` +
      `     0G OG       → https://hub.0g.ai/faucet\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `Use phantom_switch_identity to change persona.`,
    )
  }
  if (!args.role) {
    return ok(`ROLE_REQUIRED\nIDENTITY: ${identity}\nSpecify role: phantom_init role="buyer" or phantom_init role="seller"`)
  }
  return handleRegister({ role: args.role, displayName: args.display_name }, backendUrl, webhookHost, webhookPort)
}

async function handleWatchNegotiation(
  args: { negotiation_id: string; timeout_seconds?: number },
  backendUrl: string,
) {
  const s         = requireSession()
  const timeoutMs = Math.min(args.timeout_seconds ?? 90, 300) * 1000
  const pollMs    = 4000
  const start     = Date.now()

  type NegData = Record<string, unknown> & {
    rounds?: Array<{ by: string; price: number; message: string; at: number }>
    status?: string; currentPrice?: number; listedPrice?: number; role?: string; listingId?: string; offerId?: string
  }

  const fetchNeg = async (): Promise<NegData | null> => {
    const { ok, data } = await api(
      'GET', `/api/negotiations/${args.negotiation_id}`,
      undefined, s.apiKey, backendUrl,
    ) as { ok: boolean; data: NegData }
    return ok ? data : null
  }

  const formatRounds = (rounds: NegData['rounds'] = []) =>
    rounds.map((r, i) =>
      `  [${i + 1}] ${r.by.toUpperCase().padEnd(6)}  ${r.price} ETH  "${r.message}"  ${new Date(r.at).toISOString().slice(11, 19)}`
    ).join('\n')

  const actionHint = (status?: string, role?: string, offerId?: string) =>
    status === 'PENDING'   && role === 'seller' ? '\nNEXT_ACTION: phantom_counter_negotiation OR phantom_accept_negotiation' :
    status === 'COUNTERED' && role === 'buyer'  ? '\nNEXT_ACTION: phantom_counter_negotiation OR phantom_accept_negotiation' :
    status === 'ACCEPTED' && offerId            ? `\nNEXT_ACTION: phantom_create_deal offer_id="${offerId}"` :
    status === 'ACCEPTED'                       ? '\nNEXT_ACTION: phantom_create_deal (check phantom_notifications for offerId)' :
    status === 'REJECTED'                       ? '\nNEXT_ACTION: Rejected — use phantom_negotiate to open a new negotiation' : ''

  // Capture baseline on first poll
  let lastStatus     = ''
  let lastRoundCount = -1

  while (Date.now() - start < timeoutMs) {
    const data = await fetchNeg()
    if (!data) { await new Promise(r => setTimeout(r, pollMs)); continue }

    const status     = (data.status as string) ?? ''
    const roundCount = (data.rounds ?? []).length

    if (lastRoundCount === -1) {
      // First poll — record baseline, don't return yet
      lastStatus     = status
      lastRoundCount = roundCount
      await new Promise(r => setTimeout(r, pollMs))
      continue
    }

    if (status !== lastStatus || roundCount !== lastRoundCount) {
      const changeDesc = status !== lastStatus
        ? `STATUS CHANGED: ${lastStatus} → ${status}`
        : `NEW ROUND (${roundCount} total, was ${lastRoundCount})`
      return ok(
        `NEGOTIATION_UPDATE ⚡\n${changeDesc}\n\n` +
        `NEGOTIATION_ID: ${args.negotiation_id}\n` +
        `STATUS:         ${status}   ROLE: ${data.role}\n` +
        `LISTED_PRICE:   ${data.listedPrice} ETH   CURRENT_PRICE: ${data.currentPrice} ETH\n` +
        `LISTING_ID:     ${data.listingId}\n` +
        (data.offerId ? `OFFER_ID:       ${data.offerId}\n` : '') +
        `ROUNDS:\n${formatRounds(data.rounds) || '  (no rounds yet)'}` +
        actionHint(status, data.role as string, data.offerId),
      )
    }

    await new Promise(r => setTimeout(r, pollMs))
  }

  // Timeout — return current state so agent can decide whether to call again
  const data = await fetchNeg()
  if (!data) return ok(`WATCH_TIMEOUT\nNEGOTIATION_ID: ${args.negotiation_id}\nCould not reach backend.`)
  return ok(
    `WATCH_TIMEOUT\nNEGOTIATION_ID: ${args.negotiation_id}\n` +
    `STATUS: ${data.status}   CURRENT_PRICE: ${data.currentPrice} ETH   ROLE: ${data.role}\n` +
    (data.offerId ? `OFFER_ID: ${data.offerId}\n` : '') +
    `No change detected in ${Math.min(args.timeout_seconds ?? 90, 300)}s.\n` +
    `Call phantom_watch_negotiation again to keep watching.` +
    actionHint(data.status as string, data.role as string, data.offerId),
  )
}

async function handleSwitchIdentity(args: { identity: string }) {
  setCurrentIdentity(args.identity)
  const s = getSession()
  const w = loadOrCreateWallet()
  const balances = await fetchBalances(w.address)
  if (!s) {
    return ok(
      `IDENTITY_SWITCHED\nIDENTITY: ${args.identity}\nSTATUS: No session for this identity.\n` +
      `ADDRESS: ${w.address}\n${balances}\n` +
      `Call phantom_init role=<buyer|seller> identity="${args.identity}" to register.`,
    )
  }
  const label = s.displayName ? `${s.displayName} (${args.identity})` : args.identity
  return ok(
    `IDENTITY_SWITCHED\nIDENTITY:  ${label}\nAGENT_ID:  ${s.agentId}\nROLE:      ${s.role}\n` +
    `ADDRESS:   ${w.address}\n${balances}\n${ensLine(s.role)}\n\n` +
    `All tools now acting as ${label}.`,
  )
}

function handleAxlInfo() {
  const w        = loadOrCreateWallet()
  const axlPubkey = walletToAxlPubkey(w.address)
  const s        = getSession()
  const identity = getCurrentIdentity()
  const sessionLine = s
    ? `AGENT_ID: ${s.agentId}\nROLE: ${s.role}\n${ensLine(s.role)}\nBACKEND: ${s.backendUrl}`
    : 'STATUS: Not registered — call phantom_init first.'
  return ok(
    `AXL IDENTITY\nIDENTITY: ${identity}\nWALLET: ${w.address}\nAXL_PUBKEY: ${axlPubkey}\n` +
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
      action = `ACTION: If satisfied, phantom_negotiate listing_id="${listingId}" proposed_price_eth=<price_in_ETH>`
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
    // Always refresh the webhook URL on startup — localtunnel gives a new URL each run
    try {
      await refreshWebhookUrl(BACKEND_URL, WEBHOOK_HOST, existing.apiKey)
    } catch (e: unknown) {
      process.stderr.write(`[phantom] WARNING: Webhook refresh failed: ${(e as Error).message}\n`)
    }
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

    // ── Auto-identity selection ────────────────────────────────────────────────
    // Tools that are unambiguously buyer-side or seller-side automatically
    // activate the matching identity so the agent never needs to call
    // phantom_switch_identity manually. Both identities remain independent;
    // the switch is non-persistent (reverts after the call).
    const BUYER_TOOLS = new Set([
      'phantom_discover',       // browse listings to buy
      'phantom_negotiate',      // open negotiation as buyer
      'phantom_create_deal',    // create deal from accepted offer
      'phantom_lock_funds',     // lock escrow (buyer action)
      'phantom_ask_seller',     // send pre-purchase inquiry
    ])
    const SELLER_TOOLS = new Set([
      'phantom_my_listings',    // seller's own listings
      'phantom_list_report',    // seller analytics
      'phantom_accept_deal',    // seller accepts deal
      'phantom_upload_payload', // seller delivers data
      'phantom_reply_to_inquiry', // seller answers buyer question
    ])

    const prevIdentity = getCurrentIdentity()
    if (BUYER_TOOLS.has(name) && prevIdentity !== 'buyer') {
      // Only auto-switch if the buyer identity has a session
      const buyerSession = (() => { setCurrentIdentity('buyer'); return getSession() })()
      if (!buyerSession) setCurrentIdentity(prevIdentity) // no buyer session — leave as-is
    } else if (SELLER_TOOLS.has(name) && prevIdentity !== 'seller') {
      const sellerSession = (() => { setCurrentIdentity('seller'); return getSession() })()
      if (!sellerSession) setCurrentIdentity(prevIdentity)
    }

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
        case 'phantom_init':           return await handleInit(args as { role?: 'buyer' | 'seller'; identity?: string; display_name?: string; force?: boolean }, BACKEND_URL, WEBHOOK_HOST, WEBHOOK_PORT)
        case 'phantom_switch_identity':return await handleSwitchIdentity(args as { identity: string })
        case 'phantom_axl_info':       return handleAxlInfo()
        case 'phantom_send_axl_message': return await handleSendAxlMessage(args as Parameters<typeof handleSendAxlMessage>[0], BACKEND_URL)
        case 'phantom_read_axl_messages': return await handleReadAxlMessages(BACKEND_URL)
        case 'phantom_ask_seller':        return await handleAskSeller(args as Parameters<typeof handleAskSeller>[0], BACKEND_URL)
        case 'phantom_reply_to_inquiry':  return await handleReplyToInquiry(args as Parameters<typeof handleReplyToInquiry>[0], BACKEND_URL)
        case 'phantom_my_negotiations':   return await handleMyNegotiations(BACKEND_URL)
        case 'phantom_get_negotiation':   return await handleGetNegotiation(args as { negotiation_id: string }, BACKEND_URL)
        case 'phantom_watch_negotiation': return await handleWatchNegotiation(args as { negotiation_id: string; timeout_seconds?: number }, BACKEND_URL)
        default:                       return err(`Unknown tool: ${name}`)
      }
    } catch (e: unknown) {
      return err((e as Error).message)
    } finally {
      // Restore identity so auto-selection doesn't bleed into subsequent calls
      setCurrentIdentity(prevIdentity)
    }
  })

  const transport = new StdioServerTransport()
  await mcpServer.connect(transport)
}
