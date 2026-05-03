/**
 * Phantom Protocol — Interactive Buyer Agent (TUI)
 *
 * Features:
 *  - `discover [category]`   — browse seller listings
 *  - `negotiate <listingId> [price]` — strategy-based price negotiation
 *  - Handles counter-proposals automatically via strategy
 *  - When negotiation is accepted, auto-creates the deal
 *  - Locks escrow, monitors delivery, and logs verification
 *
 * Usage:
 *   cd backend
 *   node mock-agents/buyer-agent.js
 *
 * Environment:
 *   BACKEND_URL         — default http://localhost:3001
 *   BUYER_WEBHOOK_PORT  — default 3003
 */

import 'dotenv/config';
import readline from 'node:readline';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { BASE, api, log, randomAxlPubkey, randomEphemeralAddress, randomTxHash } from './utils.js';

// ── Config ──────────────────────────────────────────────────────────────────
const WEBHOOK_PORT = parseInt(process.env.BUYER_WEBHOOK_PORT || '3003', 10);
const WEBHOOK_URL  = `http://localhost:${WEBHOOK_PORT}/webhook`;

// ── ANSI colours ────────────────────────────────────────────────────────────
const NO_COLOR = !process.stdout.isTTY;
const c = NO_COLOR
  ? { g: '', r: '', y: '', b: '', m: '', dim: '', bold: '', reset: '' }
  : { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', b: '\x1b[36m',
      m: '\x1b[34m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' };

// ── Agent state ─────────────────────────────────────────────────────────────
let agentId  = null;
let apiKey   = null;
let activeDealId = null;

// negotiationId → { listingId, listedPrice, currentPrice, rounds, offerId }
const activeNegs = new Map();

// Negotiation strategy
const STRATEGY = {
  maxPriceMultiplier:   0.92,   // won't pay more than 92 % of listed price
  openingBidMultiplier: 0.72,   // start at 72 % of listed price
  stepUpPercent:        0.08,   // increase 8 % per round
  maxRounds:            3,
};

// ── Readline TUI ─────────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const PROMPT = `\n${c.m}[BUYER  ✦ Phantom]${c.reset}$ `;

function interrupt(...lines) {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  lines.forEach(l => process.stdout.write(l + '\n'));
  rl.prompt(true);
}

function banner() {
  console.log(`\n${c.bold}${c.m}╔══════════════════════════════════════════════════╗`);
  console.log(`║  PHANTOM PROTOCOL — BUYER AGENT                 ║`);
  console.log(`╚══════════════════════════════════════════════════╝${c.reset}\n`);
}

function showHelp() {
  console.log(`\n${c.bold}Available commands:${c.reset}`);
  console.log(`  ${c.b}discover [category]${c.reset}           — browse listings (?category filter)`);
  console.log(`  ${c.b}negotiate <listingId> [price]${c.reset} — open price negotiation`);
  console.log(`  ${c.b}buy <listingId>${c.reset}               — buy at listed price directly`);
  console.log(`  ${c.b}deals${c.reset}                         — show active deals`);
  console.log(`  ${c.b}help${c.reset}                          — show this help`);
  console.log(`  ${c.b}exit${c.reset}                          — quit\n`);
}

// ── Bid strategy ─────────────────────────────────────────────────────────────
/** Calculate opening bid using strategy multiplier (no LLM needed). */
function getOpeningBid(listing) {
  return Math.round(listing.priceUSDC * STRATEGY.openingBidMultiplier);
}

// ── Deal helpers ─────────────────────────────────────────────────────────────

async function createDealFromOffer(offerId, context = '') {
  interrupt(
    `\n${c.bold}${c.b}  ════════ CREATING DEAL ════════${c.reset}`,
    `  ${c.b}Offer ID${c.reset} : ${offerId}`,
    context ? `  ${c.dim}${context}${c.reset}` : '',
  );

  const { ok, data } = await api('POST', '/api/deals', { offerId }, apiKey);
  if (!ok) {
    interrupt(`  ${c.r}✗ Deal creation failed: ${JSON.stringify(data)}${c.reset}\n`);
    return null;
  }

  activeDealId = data.dealId;
  interrupt(
    `  ${c.g}✓ Deal created: ${data.dealId}${c.reset}`,
    `  ${c.dim}Waiting for seller to accept…${c.reset}`,
    `  ${c.b}  ══════════════════════════════${c.reset}\n`,
  );
  return data.dealId;
}

// ── Command handlers ─────────────────────────────────────────────────────────

async function cmdDiscover(category) {
  const path = category
    ? `/api/listings?category=${encodeURIComponent(category)}`
    : '/api/listings';

  const { ok, data } = await api('GET', path);
  if (!ok) { console.log(`${c.r}  ✗ Failed to fetch listings: ${JSON.stringify(data)}${c.reset}\n`); return; }

  if (!data.length) {
    console.log(`\n  ${c.dim}No listings found${category ? ` in category "${category}"` : ''}.${c.reset}\n`);
    return;
  }

  console.log(`\n${c.bold}  Available listings${category ? ` [${category}]` : ''}:${c.reset}`);
  console.log(`  ${'─'.repeat(76)}`);
  for (const l of data) {
    const tags = (l.tags || []).slice(0, 3).join(', ');
    console.log(`  ${c.b}${l.listingId.slice(0, 8)}…${c.reset}  ${c.bold}${l.title.slice(0, 48).padEnd(48)}${c.reset}  ${c.g}${String(l.priceUSDC).padStart(5)} USDC${c.reset}  [${l.category}]`);
    if (tags) console.log(`  ${' '.repeat(10)}${c.dim}tags: ${tags}${c.reset}`);
    if (l.description) console.log(`  ${' '.repeat(10)}${c.dim}${l.description.slice(0, 90)}${c.reset}`);
    console.log('');
  }
  console.log(`  ${c.dim}Use 'negotiate <listingId> [price]' or 'buy <listingId>' to proceed.${c.reset}\n`);
}

async function cmdNegotiate(listingId, priceArg) {
  if (!listingId) { console.log(`${c.y}  Usage: negotiate <listingId> [price]${c.reset}\n`); return; }

  // Fetch listing details
  const { ok, data: listing } = await api('GET', `/api/listings/${listingId}`);
  if (!ok) {
    // Try prefix match
    const { ok: ok2, data: all } = await api('GET', '/api/listings');
    const match = ok2 && Array.isArray(all) && all.find(l => l.listingId.startsWith(listingId));
    if (!match) { console.log(`${c.r}  ✗ Listing not found: ${listingId}${c.reset}\n`); return; }
    return cmdNegotiate(match.listingId, priceArg);
  }

  const proposedPrice = priceArg
    ? parseFloat(priceArg)
    : getOpeningBid(listing);

  console.log(`\n${c.bold}${c.b}  ════════ OPENING NEGOTIATION ════════${c.reset}`);
  console.log(`  ${c.b}Listing   :${c.reset} ${listing.title.slice(0, 60)}`);
  console.log(`  ${c.b}Listed at :${c.reset} ${listing.priceUSDC} USDC`);
  console.log(`  ${c.b}Our bid   :${c.reset} ${c.g}${proposedPrice} USDC${c.reset}`);
  console.log(`  ${c.b}Max budget:${c.reset} ${(listing.priceUSDC * STRATEGY.maxPriceMultiplier).toFixed(2)} USDC`);

  const { ok: negOk, data: negData } = await api('POST', '/api/negotiations', {
    listingId: listing.listingId,
    proposedPrice,
    message: `Opening offer for ${listing.title}`,
  }, apiKey);

  if (!negOk) {
    console.log(`  ${c.r}✗ Negotiation failed: ${JSON.stringify(negData)}${c.reset}\n`);
    return;
  }

  const { negotiationId } = negData;
  activeNegs.set(negotiationId, {
    listingId: listing.listingId,
    listedPrice: listing.priceUSDC,
    currentPrice: proposedPrice,
    rounds: 1,
    offerId: null,  // filled when NEGOTIATION_ACCEPTED arrives
  });

  console.log(`  ${c.g}✓ Negotiation started: ${negotiationId.slice(0, 8)}…${c.reset}`);
  console.log(`  ${c.dim}Waiting for seller response…${c.reset}`);
  console.log(`  ${c.b}  ══════════════════════════════════════${c.reset}\n`);
}

async function cmdBuy(listingId) {
  if (!listingId) { console.log(`${c.y}  Usage: buy <listingId>${c.reset}\n`); return; }

  // Resolve listing (support prefix)
  let fullId = listingId;
  if (listingId.length < 36) {
    const { ok, data } = await api('GET', '/api/listings');
    const match = ok && Array.isArray(data) && data.find(l => l.listingId.startsWith(listingId));
    if (!match) { console.log(`${c.r}  ✗ Listing not found: ${listingId}${c.reset}\n`); return; }
    fullId = match.listingId;
  }

  // Get offerId from listing (not exposed in public API — use negotiation → accept flow)
  // Instead, open a negotiation at listed price and immediately have it accepted
  const { ok, data: listing } = await api('GET', `/api/listings/${fullId}`);
  if (!ok) { console.log(`${c.r}  ✗ Listing not found${c.reset}\n`); return; }

  const { ok: negOk, data: negData } = await api('POST', '/api/negotiations', {
    listingId: fullId,
    proposedPrice: listing.priceUSDC,
    message: 'Buying at listed price',
  }, apiKey);

  if (!negOk) { console.log(`${c.r}  ✗ Failed: ${JSON.stringify(negData)}${c.reset}\n`); return; }
  const { negotiationId } = negData;
  activeNegs.set(negotiationId, {
    listingId: fullId, listedPrice: listing.priceUSDC,
    currentPrice: listing.priceUSDC, rounds: 1, offerId: null,
  });

  console.log(`  ${c.g}✓ Offer sent at listed price ${listing.priceUSDC} USDC — waiting for seller…${c.reset}\n`);
}

// ── Webhook handler ──────────────────────────────────────────────────────────

async function handleWebhook(event) {
  const { event: type, dealId } = event;

  // ── Seller countered ──────────────────────────────────────────────────────
  if (type === 'NEGOTIATION_COUNTER') {
    const { negotiationId, counterPrice, rounds } = event;
    const neg = activeNegs.get(negotiationId);
    if (!neg) return;

    const maxPrice = neg.listedPrice * STRATEGY.maxPriceMultiplier;

    interrupt(
      `\n${c.bold}${c.y}  ════════ COUNTER OFFER RECEIVED ════════${c.reset}`,
      `  ${c.b}Negotiation :${c.reset} ${negotiationId?.slice(0, 8)}…`,
      `  ${c.b}Seller asks :${c.reset} ${counterPrice} USDC`,
      `  ${c.b}Our max     :${c.reset} ${maxPrice.toFixed(2)} USDC`,
      `  ${c.b}Round       :${c.reset} ${rounds}`,
    );

    if (counterPrice <= maxPrice) {
      // Accept the counter
      const { ok, data } = await api('POST', `/api/negotiations/${negotiationId}/accept`, {}, apiKey);
      interrupt(
        `  ${c.g}✓ Acceptable price — accepting ${counterPrice} USDC${c.reset}`,
        ok ? `  ${c.g}✓ offerId: ${data.offerId}  finalPrice: ${data.finalPrice} USDC${c.reset}` : `  ${c.r}✗ Accept error: ${JSON.stringify(data)}${c.reset}`,
        `  ${c.y}  ════════════════════════════════════════${c.reset}\n`,
      );
    } else if ((rounds || 1) >= STRATEGY.maxRounds) {
      // Walk away
      await api('POST', `/api/negotiations/${negotiationId}/reject`, {}, apiKey);
      interrupt(
        `  ${c.r}✗ Above max budget and max rounds reached — walking away${c.reset}`,
        `  ${c.y}  ════════════════════════════════════════${c.reset}\n`,
      );
    } else {
      // Step up our bid
      const stepUp    = neg.listedPrice * STRATEGY.stepUpPercent;
      const newBid    = +(neg.currentPrice + stepUp).toFixed(2);
      const boundBid  = Math.min(newBid, maxPrice);
      neg.currentPrice = boundBid;
      neg.rounds       = (neg.rounds || 1) + 1;

      const { ok } = await api('POST', `/api/negotiations/${negotiationId}/counter`,
        { counterPrice: boundBid, message: `Stepping up to ${boundBid} USDC` }, apiKey);
      interrupt(
        `  ${c.b}⟳ Stepping up to ${boundBid} USDC (round ${neg.rounds})${c.reset}`,
        ok ? `  ${c.g}✓ Counter sent${c.reset}` : `  ${c.r}✗ Counter failed${c.reset}`,
        `  ${c.y}  ════════════════════════════════════════${c.reset}\n`,
      );
    }
  }

  // ── Negotiation accepted → auto-create deal ───────────────────────────────
  if (type === 'NEGOTIATION_ACCEPTED') {
    const { negotiationId, offerId, finalPrice } = event;
    interrupt(
      `\n${c.g}${c.bold}  ✓ NEGOTIATION ACCEPTED — ${finalPrice} USDC${c.reset}`,
      `  ${c.dim}Negotiation ${negotiationId?.slice(0, 8)}… agreed at ${finalPrice} USDC${c.reset}`,
      `  ${c.dim}Auto-creating deal…${c.reset}`,
    );
    if (offerId) {
      await createDealFromOffer(offerId, `Negotiated price: ${finalPrice} USDC`);
    }
  }

  // ── Negotiation rejected ──────────────────────────────────────────────────
  if (type === 'NEGOTIATION_REJECTED') {
    const { negotiationId } = event;
    interrupt(
      `\n  ${c.r}✗ Negotiation ${negotiationId?.slice(0, 8)}… rejected by seller${c.reset}\n`,
    );
    activeNegs.delete(negotiationId);
  }

  // ── Seller accepted → lock funds ──────────────────────────────────────────
  if (type === 'DEAL_STATUS_CHANGE' && event.status === 'LOCKING') {
    const mockTxHash = randomTxHash();
    interrupt(
      `\n${c.bold}${c.b}  ════════ LOCKING FUNDS IN VAULT ════════${c.reset}`,
      `  ${c.b}Deal     :${c.reset} ${dealId}`,
      `  ${c.b}Contract :${c.reset} PhantomVault (Sepolia)`,
      `  ${c.b}Amount   :${c.reset} 5.00 USDC`,
      `  ${c.b}Tx hash  :${c.reset} ${mockTxHash.slice(0, 28)}…`,
      `  ${c.dim}Submitting escrow transaction…${c.reset}`,
    );

    const { ok, data } = await api('POST', `/api/deals/${dealId}/lock`,
      { lockTxHash: mockTxHash }, apiKey);

    if (ok) {
      interrupt(
        `  ${c.g}✓ Escrow locked — status: ${data.status}${c.reset}`,
        `  ${c.g}✓ Seller may now upload the payload${c.reset}`,
        `  ${c.b}  ═══════════════════════════════════════${c.reset}\n`,
      );
    } else {
      interrupt(`  ${c.r}✗ Lock failed: ${JSON.stringify(data)}${c.reset}`);
    }
  }

  // ── Seller uploading ──────────────────────────────────────────────────────
  if (type === 'DEAL_STATUS_CHANGE' && event.status === 'VERIFYING') {
    interrupt(
      `\n  ${c.b}▶ Payload uploaded to 0G Storage — verifying rootHash on-chain…${c.reset}`,
      `  ${c.dim}  Querying 0G Galileo storage nodes…${c.reset}`,
    );
  }

  if (type === 'DEAL_STATUS_CHANGE' && event.status === 'EXECUTING') {
    interrupt(
      `  ${c.g}✓ rootHash confirmed on 0G Galileo testnet${c.reset}`,
      `  ${c.dim}  Arbiter (KeeperHub) monitoring — payout pending…${c.reset}`,
    );
  }

  // ── ENS burning ───────────────────────────────────────────────────────────
  if (type === 'DEAL_STATUS_CHANGE' && event.status === 'BURNING') {
    interrupt(
      `\n  ${c.y}▶ Payout released — ENS subnames being destroyed…${c.reset}`,
      `  ${c.dim}  buyer-${dealId?.slice(0, 8)}….phantom-protocol.eth  → 0xdEaD${c.reset}`,
      `  ${c.dim}  seller-${dealId?.slice(0, 8)}….phantom-protocol.eth → 0xdEaD${c.reset}`,
      `  ${c.dim}  deal-${dealId?.slice(0, 8)}….phantom-protocol.eth   → 0xdEaD${c.reset}`,
    );
  }

  // ── Deal complete ─────────────────────────────────────────────────────────
  if (type === 'DEAL_STATUS_CHANGE' && event.status === 'COMPLETE') {
    interrupt(
      `\n${c.bold}${c.g}  ════════════════════════════════════════════`,
      `  DEAL COMPLETE  🎉`,
      `  ID       : ${dealId}`,
      `  Delivery : Research report verified on 0G Galileo`,
      `  Escrow   : USDC paid to seller from PhantomVault`,
      `  Privacy  : ENS subnames destroyed — identities burned`,
      `  ════════════════════════════════════════════${c.reset}\n`,
    );
    activeDealId = null;
  }
}

// ── Command dispatcher ───────────────────────────────────────────────────────

async function runCommand(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  const [cmd, ...rest] = trimmed.split(/\s+/);
  const args = rest;

  switch (cmd.toLowerCase()) {
    case 'help': showHelp(); break;

    case 'discover':
      await cmdDiscover(args[0] || '');
      break;

    case 'negotiate':
      await cmdNegotiate(args[0], args[1]);
      break;

    case 'buy':
      await cmdBuy(args[0]);
      break;

    case 'deals': {
      if (activeDealId) {
        const { ok, data } = await api('GET', `/api/deals/${activeDealId}`, null, apiKey);
        if (ok) {
          console.log(`\n  ${c.b}Active deal:${c.reset} ${activeDealId}  status: ${c.bold}${data.status}${c.reset}\n`);
        }
      } else {
        console.log(`\n  ${c.dim}No active deal.${c.reset}\n`);
      }
      break;
    }

    case 'exit':
    case 'quit':
      console.log(`\n${c.dim}  Goodbye.${c.reset}\n`);
      process.exit(0);
      break;

    default:
      console.log(`${c.y}  Unknown command. Type 'help' for available commands.${c.reset}\n`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  banner();

  // Register agent
  process.stdout.write(`  Registering with coordinator… `);
  const axlPubkey        = randomAxlPubkey();
  const ephemeralAddress = randomEphemeralAddress();

  const regRes = await api('POST', '/api/agents/register', {
    axlPubkey,
    ephemeralAddress,
    role: 'buyer',
    capabilities: [],
    webhookUrl: WEBHOOK_URL,
  });

  if (!regRes.ok) {
    console.log(`${c.r}✗ Registration failed: ${JSON.stringify(regRes.data)}${c.reset}`);
    process.exit(1);
  }
  ({ agentId, apiKey } = regRes.data);
  console.log(`${c.g}✓ agentId: ${agentId.slice(0, 8)}…${c.reset}`);

  // Start webhook server
  const wh = express();
  wh.use(express.json());
  wh.post('/webhook', (req, res) => {
    res.sendStatus(200);
    handleWebhook(req.body).catch(err =>
      interrupt(`${c.r}  ✗ Webhook error: ${err.message}${c.reset}`));
  });
  await new Promise(resolve => wh.listen(WEBHOOK_PORT, resolve));
  console.log(`  Webhook server on port ${WEBHOOK_PORT}… ${c.g}✓${c.reset}`);

  console.log(`\n${c.dim}  Type 'help' for available commands.${c.reset}\n`);

  rl.setPrompt(PROMPT);
  rl.prompt();

  rl.on('line', async (line) => {
    rl.pause();
    try {
      await runCommand(line);
    } finally {
      rl.resume();
      rl.prompt();
    }
  });

  rl.on('close', () => {
    console.log(`\n${c.dim}  Session ended.${c.reset}\n`);
    process.exit(0);
  });
}

main().catch(err => {
  console.error(`${c.r}Fatal: ${err.message}${c.reset}`);
  process.exit(1);
});
