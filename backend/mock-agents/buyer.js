/**
 * Phantom Protocol — Mock Buyer Agent
 *
 * Registers as a buyer, discovers the first available offer, creates a deal,
 * then spins up a tiny webhook server to receive deal events.
 * Automatically locks funds when the seller accepts.
 *
 * Usage (with backend + seller already running):
 *   cd backend
 *   node mock-agents/buyer.js
 *
 *   # Or target a specific offer:
 *   OFFER_ID=<uuid> node mock-agents/buyer.js
 *
 * Environment:
 *   BACKEND_URL        — default http://localhost:3001
 *   BUYER_WEBHOOK_PORT — local port for webhook receiver (default 3003)
 *   OFFER_ID           — target a specific offer (otherwise picks first active)
 */

import express from 'express';
import {
  BASE,
  api,
  log,
  randomAxlPubkey,
  randomEphemeralAddress,
  randomTxHash,
} from './utils.js';

const WEBHOOK_PORT = parseInt(process.env.BUYER_WEBHOOK_PORT || '3003', 10);
const WEBHOOK_URL = `http://localhost:${WEBHOOK_PORT}/webhook`;

// ---------------------------------------------------------------------------
// Agent state
// ---------------------------------------------------------------------------
let buyerApiKey = null;
let buyerAgentId = null;
let activeDealId = null;

// ---------------------------------------------------------------------------
// Webhook handler
// ---------------------------------------------------------------------------
async function handleWebhook(event) {
  const { event: type, dealId, status } = event;
  log('INFO', `Buyer received event: ${type}${status ? ` (status=${status})` : ''} (deal=${dealId?.slice(0, 8)}…)`);

  if (type === 'DEAL_STATUS_CHANGE' && status === 'LOCKING') {
    // Seller has accepted — simulate locking funds in vault
    const mockTxHash = randomTxHash();
    console.log('');
    log('STEP', '════════ LOCKING FUNDS IN VAULT ════════');
    log('INFO', `Seller accepted deal — committing escrow…`);
    log('INFO', `Contract : PhantomVault (Sepolia)`);
    log('INFO', `Amount   : 5.00 USDC`);
    log('INFO', `Tx hash  : ${mockTxHash.slice(0, 26)}…`);

    const { ok, data } = await api(
      'POST',
      `/api/deals/${dealId}/lock`,
      { lockTxHash: mockTxHash },
      buyerApiKey,
    );

    if (ok) {
      log('PASS', `Escrow locked — status: ${data.status}`);
      log('PASS', `Seller may now upload the payload`);
      log('STEP', '═══════════════════════════════════════');
      console.log('');
    } else {
      log('FAIL', `Lock failed: ${JSON.stringify(data)}`);
    }
  }

  if (type === 'DEAL_STATUS_CHANGE' && status === 'VERIFYING') {
    console.log('');
    log('INFO', `Payload uploaded by seller to 0G Storage`);
    log('INFO', `Verifying rootHash exists on-chain…`);
    log('INFO', `Querying 0G Galileo storage nodes…`);
  }

  if (type === 'DEAL_STATUS_CHANGE' && status === 'EXECUTING') {
    log('PASS', `Storage verification passed`);
    log('PASS', `rootHash confirmed on 0G Galileo testnet`);
    log('INFO', `Arbiter (KeeperHub) monitoring for payout trigger…`);
    console.log('');
  }

  if (type === 'DEAL_STATUS_CHANGE' && status === 'BURNING') {
    log('INFO', `Payout released — ENS access subnames being destroyed…`);
  }

  if (type === 'DEAL_STATUS_CHANGE' && status === 'COMPLETE') {
    console.log('');
    log('PASS', '════════════════════════════════════════════');
    log('PASS', `  DEAL COMPLETE`);
    log('PASS', `  ID      : ${dealId}`);
    log('PASS', `  Payload : delivered and verified on 0G Storage`);
    log('PASS', `  Escrow  : 5.00 USDC paid to seller`);
    log('PASS', `  Privacy : ENS subnames destroyed — no trace`);
    log('PASS', '════════════════════════════════════════════');
    console.log('');
    log('INFO', 'You can now Ctrl+C to exit.');
  }

  if (type === 'DEAL_STATUS_CHANGE' && status === 'FAILED') {
    log('FAIL', `Deal ${dealId} FAILED — check seller logs`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // 1. Register
  const axlPubkey = randomAxlPubkey();
  const ephemeralAddress = randomEphemeralAddress();

  log('INFO', `Registering buyer…`);
  log('INFO', `webhookUrl: ${WEBHOOK_URL}`);

  const { status, data } = await api('POST', '/api/agents/register', {
    axlPubkey,
    ephemeralAddress,
    role: 'buyer',
    capabilities: [],
    webhookUrl: WEBHOOK_URL,
  });

  if (status !== 201) {
    log('FAIL', `Registration failed (${status}): ${JSON.stringify(data)}`);
    process.exit(1);
  }

  buyerApiKey = data.apiKey;
  buyerAgentId = data.agentId;
  log('PASS', `Registered as buyer — agentId: ${buyerAgentId}`);

  // 2. Start webhook server early so the seller can notify us
  const app = express();
  app.use(express.json());

  app.post('/webhook', (req, res) => {
    res.sendStatus(200);
    handleWebhook(req.body).catch((err) =>
      log('FAIL', `Webhook handler error: ${err.message}`),
    );
  });

  await new Promise((resolve) =>
    app.listen(WEBHOOK_PORT, () => {
      log('PASS', `Buyer webhook listening on :${WEBHOOK_PORT}`);
      resolve();
    }),
  );

  // 3. Find an offer
  let offerId = process.env.OFFER_ID || null;

  if (!offerId) {
    log('INFO', 'Fetching offers from marketplace…');
    const { ok, data: offers } = await api('GET', '/api/offers');
    if (!ok || !Array.isArray(offers) || offers.length === 0) {
      log('FAIL', 'No active offers found. Start seller.js first.');
      process.exit(1);
    }
    offerId = offers[0].offerId;
    log('INFO', `Found ${offers.length} offer(s). Picking: ${offerId}`);
    log('INFO', `  ${offers[0].description} — $${offers[0].priceUSDC} USDC`);
  } else {
    log('INFO', `Using offer from env: ${offerId}`);
  }

  // 4. Create deal
  const { status: dealStatus, data: dealData } = await api(
    'POST',
    '/api/deals',
    { offerId },
    buyerApiKey,
  );

  if (dealStatus !== 201) {
    log('FAIL', `Deal creation failed (${dealStatus}): ${JSON.stringify(dealData)}`);
    process.exit(1);
  }

  activeDealId = dealData.dealId;
  log('PASS', `Deal created — dealId: ${activeDealId}`);
  console.log('');
  log('INFO', '════════════════════════════════════════');
  log('INFO', `Deal ID: ${activeDealId}`);
  log('INFO', 'Waiting for seller to accept…  (Ctrl+C to exit)');
  log('INFO', '════════════════════════════════════════');
  console.log('');
}

main().catch((err) => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
