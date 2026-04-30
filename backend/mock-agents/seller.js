/**
 * Phantom Protocol — Mock Seller Agent
 *
 * Registers as a seller, posts an offer, then spins up a tiny webhook server
 * to receive deal events. Automatically accepts deals and uploads a test payload.
 *
 * Usage (with backend already running):
 *   cd backend
 *   node mock-agents/seller.js
 *
 * Environment:
 *   BACKEND_URL         — default http://localhost:3001
 *   SELLER_WEBHOOK_PORT — local port for webhook receiver (default 3002)
 */

import express from 'express';
import { randomBytes } from 'node:crypto';
import {
  BASE,
  api,
  uploadFile,
  log,
  randomAxlPubkey,
  randomEphemeralAddress,
} from './utils.js';

const WEBHOOK_PORT = parseInt(process.env.SELLER_WEBHOOK_PORT || '3002', 10);
const WEBHOOK_URL = `http://localhost:${WEBHOOK_PORT}/webhook`;

// ---------------------------------------------------------------------------
// Test payload the seller will deliver
// ---------------------------------------------------------------------------
function makeTestPayload(dealId) {
  return Buffer.from(
    JSON.stringify({
      type: 'phantom-dataset',
      dealId,
      generatedAt: new Date().toISOString(),
      rows: Array.from({ length: 100 }, (_, i) => ({ id: i, value: Math.random() })),
    }),
  );
}

// ---------------------------------------------------------------------------
// Agent state
// ---------------------------------------------------------------------------
let sellerApiKey = null;
let sellerAgentId = null;

// ---------------------------------------------------------------------------
// Webhook handler
// ---------------------------------------------------------------------------
async function handleWebhook(event) {
  const { event: type, dealId } = event;

  log('INFO', `Seller received event: ${type} (deal=${dealId?.slice(0, 8)}…)`);

  if (type === 'DEAL_OFFER') {
    console.log('');
    log('STEP', '════════════ INCOMING DEAL OFFER ════════════');
    log('INFO', `Deal ID  : ${dealId}`);
    log('INFO', `Buyer    : ${event.buyerAgentId?.slice(0, 8) ?? 'unknown'}…`);
    log('INFO', `Auto-accepting…`);
    const { ok, data } = await api('POST', `/api/deals/${dealId}/accept`, {}, sellerApiKey);
    if (ok) {
      log('PASS', `Deal accepted — KeeperHub arbiter + janitor created`);
      log('PASS', `Status: ${data.status} — waiting for buyer to lock funds`);
      log('STEP', '═════════════════════════════════════════════');
      console.log('');
    } else {
      log('FAIL', `Accept failed: ${JSON.stringify(data)}`);
    }
  }

  if (type === 'DEAL_STATUS_CHANGE' && event.status === 'UPLOADING') {
    // Buyer locked funds — time to upload the payload
    console.log('');
    log('STEP', '════════ FILE TRANSFER INITIATED ════════');
    log('INFO', `Deal ${dealId?.slice(0, 8)}… — buyer funds confirmed locked`);
    console.log('');

    const buffer = makeTestPayload(dealId);
    log('INFO', `Preparing payload  …  ${buffer.length} bytes`);
    log('INFO', `Type:              dataset (ML training — 100 rows)`);
    log('INFO', `Encoding:          AES-256-GCM (ephemeral deal key)`);
    log('INFO', `Destination:       0G Galileo decentralised storage`);
    console.log('');

    log('INFO', 'Connecting to 0G Storage indexer…');
    const uploadRes = await uploadFile(sellerApiKey, dealId, buffer, `deal-${dealId}.enc`);

    if (uploadRes.ok) {
      const rootHash = uploadRes.data.rootHash;
      console.log('');
      const txHashStr = typeof uploadRes.data.txHash === 'string'
        ? uploadRes.data.txHash
        : (uploadRes.data.txHash?.hash ?? JSON.stringify(uploadRes.data.txHash) ?? '(batched)');
      log('PASS', `Upload confirmed on storage network`);
      log('PASS', `rootHash : ${rootHash}`);
      log('PASS', `txHash   : ${txHashStr.slice(0, 26)}…`);
      log('STEP', '════════ TRANSFER COMPLETE ════════════');
      console.log('');
    } else {
      log('WARN', `0G upload failed (${uploadRes.status}) — trying dev advance…`);
      const devRes = await api('POST', '/internal/dev/advance', { dealId });
      if (devRes.ok) {
        log('PASS', `Dev advance: ${devRes.data.status} (rootHash=${devRes.data.rootHash?.slice(0, 18)}…)`);
      } else {
        log('FAIL', `Dev advance failed: ${JSON.stringify(devRes.data)}`);
      }
    }
  }

  if (type === 'DEAL_STATUS_CHANGE' && event.status === 'BURNING') {
    console.log('');
    log('INFO', `Deal ${dealId?.slice(0, 8)}… — ENS access subnames burning…`);
    log('INFO', `buyer-${dealId?.slice(0, 8)}….phantom-protocol.eth → 0xdEaD`);
    log('INFO', `seller-${dealId?.slice(0, 8)}….phantom-protocol.eth → 0xdEaD`);
    log('INFO', `deal-${dealId?.slice(0, 8)}….phantom-protocol.eth   → 0xdEaD`);
  }

  if (type === 'DEAL_STATUS_CHANGE' && event.status === 'COMPLETE') {
    console.log('');
    log('PASS', '════════════════════════════════════════════');
    log('PASS', `  DEAL COMPLETE`);
    log('PASS', `  ID      : ${dealId}`);
    log('PASS', `  Payout  : 5.00 USDC released from vault`);
    log('PASS', `  Storage : rootHash verified on 0G Galileo`);
    log('PASS', `  ENS     : subnames destroyed — access revoked`);
    log('PASS', '════════════════════════════════════════════');
    console.log('');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // 1. Register
  const axlPubkey = randomAxlPubkey();
  const ephemeralAddress = randomEphemeralAddress();

  log('INFO', `Registering seller…`);
  log('INFO', `axlPubkey: ${axlPubkey.slice(0, 16)}…`);
  log('INFO', `address:   ${ephemeralAddress}`);
  log('INFO', `webhookUrl: ${WEBHOOK_URL}`);

  const { status, data } = await api('POST', '/api/agents/register', {
    axlPubkey,
    ephemeralAddress,
    role: 'seller',
    capabilities: ['dataset-sales', 'model-weights'],
    webhookUrl: WEBHOOK_URL,
  });

  if (status !== 201) {
    log('FAIL', `Registration failed (${status}): ${JSON.stringify(data)}`);
    process.exit(1);
  }

  sellerApiKey = data.apiKey;
  sellerAgentId = data.agentId;
  log('PASS', `Registered as seller — agentId: ${sellerAgentId}`);

  // 2. Create offer
  const { status: offerStatus, data: offerData } = await api(
    'POST',
    '/api/offers',
    {
      description: 'Mock ML training dataset — 100 rows',
      payloadType: 'dataset',
      priceUSDC: '5.00',
      tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      expectedSizeBytes: 4096,
    },
    sellerApiKey,
  );

  if (offerStatus !== 201) {
    log('FAIL', `Offer creation failed (${offerStatus}): ${JSON.stringify(offerData)}`);
    process.exit(1);
  }

  log('PASS', `Offer created — offerId: ${offerData.offerId}`);
  console.log('');
  log('INFO', '════════════════════════════════════════');
  log('INFO', `Offer ID: ${offerData.offerId}`);
  log('INFO', `Price:    5.00 USDC`);
  log('INFO', '════════════════════════════════════════');
  console.log('');

  // 3. Spin up webhook server
  const app = express();
  app.use(express.json());

  app.post('/webhook', (req, res) => {
    res.sendStatus(200); // ack immediately
    handleWebhook(req.body).catch((err) =>
      log('FAIL', `Webhook handler error: ${err.message}`),
    );
  });

  app.listen(WEBHOOK_PORT, () => {
    log('PASS', `Seller webhook listening on :${WEBHOOK_PORT}`);
    log('INFO', 'Waiting for deal events…  (Ctrl+C to exit)');
  });
}

main().catch((err) => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
