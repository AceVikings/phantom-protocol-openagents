/**
 * Phantom Protocol — End-to-End Test Runner (no mocks)
 *
 * Runs the full deal lifecycle with no fallbacks. Every external service call
 * must succeed: 0G Storage upload, 0G Compute verification, ENS subname minting,
 * and KeeperHub workflow creation. The test fails fast on the first missing
 * credential or service error.
 *
 * Prerequisites — set all vars in backend/.env before running:
 *   PROTOCOL_PRIVATE_KEY=0x<key>  (funded on 0G Galileo + owns ENS parent)
 *   ETH_RPC_URL=https://...       (mainnet or Sepolia for ENS)
 *   ENS_PARENT_NAME=phantom.eth   (must be owned by PROTOCOL_PRIVATE_KEY)
 *   ZERO_G_RPC_URL=https://evmrpc-testnet.0g.ai
 *   ZERO_G_STORAGE_URL=https://indexer-storage-testnet-turbo.0g.ai
 *   KH_API_KEY=kh_...             (KeeperHub — app.keeperhub.com)
 *   BACKEND_URL=https://...       (publicly reachable URL for KeeperHub callbacks)
 *   INTERNAL_SECRET=<secret>      (shared with backend)
 *   SELLER_AXL_PUBKEY=<64hex>     (real Ed25519 pubkey from AXL node)
 *   BUYER_AXL_PUBKEY=<64hex>      (real Ed25519 pubkey from AXL node)
 *   LOCK_TX_HASH=0x<hash>         (tx hash from a real vault lock on VAULT_CONTRACT_ADDRESS)
 *
 * Usage:
 *   cd backend
 *   node server.js &
 *   node mock-agents/run-test.js
 */

import {
  BASE,
  api,
  internalApi,
  uploadFile,
  log,
  randomEphemeralAddress,
  pollDealStatus,
  sleep,
} from './utils.js';

// ---------------------------------------------------------------------------
// Required env vars — fail fast before hitting the backend
// ---------------------------------------------------------------------------
const REQUIRED_ENV = [
  'SELLER_AXL_PUBKEY',
  'BUYER_AXL_PUBKEY',
  'LOCK_TX_HASH',
];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error('\n[FATAL] Missing required env vars:');
  missing.forEach((k) => console.error(`  • ${k}`));
  console.error('\nSee the prerequisites in the file header.\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
let warned = 0;

function pass(label) {
  log('PASS', label);
  passed++;
}

function fail(label, detail = '') {
  log('FAIL', label + (detail ? ` — ${detail}` : ''));
  failed++;
}

function warn(label) {
  log('WARN', label);
  warned++;
}

function assert(condition, label, detail = '') {
  if (condition) pass(label);
  else {
    fail(label, detail);
    throw new Error(`Assertion failed: ${label}`);
  }
}

function step(n, title) {
  console.log('');
  log('STEP', `STEP ${n}: ${title}`);
}

// ---------------------------------------------------------------------------
// Test payloads
// ---------------------------------------------------------------------------
const SELLER_OFFER = {
  description: 'Mock ML training dataset — 100 rows (Phantom Protocol test)',
  payloadType: 'dataset',
  priceUSDC: '5.00',
  tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC on mainnet
  expectedSizeBytes: 1024,
  expectedSha256: null,
};

const TEST_PAYLOAD = Buffer.from(
  JSON.stringify({
    type: 'phantom-dataset',
    version: 1,
    rows: Array.from({ length: 100 }, (_, i) => ({ id: i, value: Math.random() })),
  }),
);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log('  Phantom Protocol — E2E Test Runner');
  console.log(`  Backend: ${BASE}`);
  console.log('═'.repeat(60) + '\n');

  // ─────────────────────────────────────────────────────────────────
  step(1, 'Health check');
  // ─────────────────────────────────────────────────────────────────
  {
    // Retry for up to 5s to let the server finish starting
    let lastErr;
    for (let i = 0; i < 20; i++) {
      try {
        const { ok, data } = await api('GET', '/api/health');
        assert(ok, 'Backend is reachable', JSON.stringify(data));
        pass(`status: ${data.status}`);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        await sleep(250);
      }
    }
    if (lastErr) throw lastErr;
  }

  // ─────────────────────────────────────────────────────────────────
  step(2, 'Register seller agent');
  // ─────────────────────────────────────────────────────────────────
  let sellerApiKey, sellerAgentId, sellerAxlPubkey, sellerAddress;
  {
    // Real AXL pubkeys must come from a running AXL node (gensyn-axl at COORDINATOR_AXL_API)
    sellerAxlPubkey = process.env.SELLER_AXL_PUBKEY;
    sellerAddress = process.env.SELLER_EPHEMERAL_ADDRESS || randomEphemeralAddress();

    const { status, data } = await api('POST', '/api/agents/register', {
      axlPubkey: sellerAxlPubkey,
      ephemeralAddress: sellerAddress,
      role: 'seller',
      capabilities: ['dataset-sales'],
    });

    assert(status === 201, 'Seller registered (201)', `got ${status}: ${JSON.stringify(data)}`);
    sellerApiKey = data.apiKey;
    sellerAgentId = data.agentId;
    pass(`agentId: ${sellerAgentId}`);
    log('INFO', `axlPubkey: ${sellerAxlPubkey.slice(0, 16)}…`);
  }

  // ─────────────────────────────────────────────────────────────────
  step(3, 'Seller creates offer');
  // ─────────────────────────────────────────────────────────────────
  let offerId;
  {
    const { status, data } = await api('POST', '/api/offers', SELLER_OFFER, sellerApiKey);
    assert(status === 201, 'Offer created (201)', `got ${status}: ${JSON.stringify(data)}`);
    offerId = data.offerId;
    pass(`offerId: ${offerId}`);
  }

  // ─────────────────────────────────────────────────────────────────
  step(4, 'Register buyer agent');
  // ─────────────────────────────────────────────────────────────────
  let buyerApiKey, buyerAgentId;
  {
    // Real AXL pubkeys must come from a running AXL node
    const { status, data } = await api('POST', '/api/agents/register', {
      axlPubkey: process.env.BUYER_AXL_PUBKEY,
      ephemeralAddress: process.env.BUYER_EPHEMERAL_ADDRESS || randomEphemeralAddress(),
      role: 'buyer',
      capabilities: [],
    });

    assert(status === 201, 'Buyer registered (201)', `got ${status}: ${JSON.stringify(data)}`);
    buyerApiKey = data.apiKey;
    buyerAgentId = data.agentId;
    pass(`agentId: ${buyerAgentId}`);
  }

  // ─────────────────────────────────────────────────────────────────
  step(5, 'Buyer fetches offers');
  // ─────────────────────────────────────────────────────────────────
  {
    const { ok, data } = await api('GET', '/api/offers');
    assert(ok, 'GET /api/offers returns 200');
    assert(Array.isArray(data), 'Response is an array');
    const found = data.find((o) => o.offerId === offerId);
    assert(!!found, `Seller's offer appears in marketplace`);
    assert(!('sellerAgentId' in found), 'sellerAgentId is stripped from public listing');
    pass(`${data.length} active offer(s) in marketplace`);
  }

  // ─────────────────────────────────────────────────────────────────
  step(6, 'Buyer creates deal');
  // ─────────────────────────────────────────────────────────────────
  let dealId;
  {
    const { status, data } = await api('POST', '/api/deals', { offerId }, buyerApiKey);
    assert(status === 201, 'Deal created (201)', `got ${status}: ${JSON.stringify(data)}`);
    dealId = data.dealId;
    pass(`dealId: ${dealId}`);
  }

  // ─────────────────────────────────────────────────────────────────
  step(7, 'Verify initial deal state');
  // ─────────────────────────────────────────────────────────────────
  {
    const { ok, data } = await api('GET', `/api/deals/${dealId}`, null, buyerApiKey);
    assert(ok, 'GET /api/deals/:dealId returns 200');
    assert(data.status === 'MATCHMAKING', `Status is MATCHMAKING (got ${data.status})`);
    assert(!('buyerAgentId' in data), 'buyerAgentId is stripped from response');
    assert(!('sellerAgentId' in data), 'sellerAgentId is stripped from response');
    pass(`status: ${data.status}`);
  }

  // ─────────────────────────────────────────────────────────────────
  step(8, 'Seller accepts deal (ENS minting + KeeperHub workflow creation)');
  // ─────────────────────────────────────────────────────────────────
  {
    const { status, data } = await api(
      'POST',
      `/api/deals/${dealId}/accept`,
      {},
      sellerApiKey,
    );
    assert(
      data.status === 'LOCKING',
      `Status advanced to LOCKING (got ${data.status})`,
      JSON.stringify(data),
    );
    // Verify KeeperHub workflow IDs were created (proves KH_API_KEY is valid
    // and backend URL is reachable from KeeperHub)
    const dealState = (await api('GET', `/api/deals/${dealId}`, null, sellerApiKey)).data;
    assert(
      !!dealState.arbiterWorkflowId,
      'KeeperHub Arbiter workflow created',
      'arbiterWorkflowId is null — check KH_API_KEY and BACKEND_URL',
    );
    assert(
      !!dealState.janitorWorkflowId,
      'KeeperHub Janitor workflow created',
      'janitorWorkflowId is null — check KH_API_KEY and BACKEND_URL',
    );
    pass(`arbiter: ${dealState.arbiterWorkflowId}  janitor: ${dealState.janitorWorkflowId}`);
  }

  // ─────────────────────────────────────────────────────────────────
  step(9, 'Buyer confirms vault lock');
  // ─────────────────────────────────────────────────────────────────
  // LOCK_TX_HASH must be an actual on-chain tx hash from calling
  // deposit() on the vault contract (VAULT_CONTRACT_ADDRESS).
  // The buyer wallet must hold USDC and have approved the vault.
  const lockTxHash = process.env.LOCK_TX_HASH;
  {
    const { status, data } = await api(
      'POST',
      `/api/deals/${dealId}/lock`,
      { lockTxHash },
      buyerApiKey,
    );
    assert(
      data.status === 'UPLOADING',
      `Status advanced to UPLOADING (got ${data.status})`,
      JSON.stringify(data),
    );
    pass(`lockTxHash: ${lockTxHash.slice(0, 18)}…`);
  }

  // ─────────────────────────────────────────────────────────────────
  step(10, 'Seller uploads encrypted payload to 0G Storage');
  // ─────────────────────────────────────────────────────────────────
  let rootHash;
  {
    log('INFO', `Uploading ${TEST_PAYLOAD.length} bytes to 0G Storage…`);
    const uploadRes = await uploadFile(sellerApiKey, dealId, TEST_PAYLOAD);
    assert(
      uploadRes.ok,
      '0G Storage upload succeeded',
      `HTTP ${uploadRes.status}: ${JSON.stringify(uploadRes.data)} — ` +
        'Check PROTOCOL_PRIVATE_KEY has 0G Galileo OG tokens (faucet: https://hub.0g.ai/faucet)',
    );
    rootHash = uploadRes.data.rootHash;
    pass(`rootHash: ${rootHash?.slice(0, 18)}…`);
  }

  // ─────────────────────────────────────────────────────────────────
  step(11, 'Wait for 0G Compute verification and EXECUTING state');
  // ─────────────────────────────────────────────────────────────────
  {
    // 0G Compute verification runs asynchronously after upload
    // (UPLOADING → VERIFYING → EXECUTING). Allow up to 90 seconds.
    const deal = await pollDealStatus(
      dealId,
      buyerApiKey,
      ['EXECUTING', 'BURNING', 'COMPLETE'],
      90_000,
    );
    pass(`Status: ${deal.status}`);
  }

  // ─────────────────────────────────────────────────────────────────
  step(12, 'Verify rootHash is confirmed on 0G, then trigger payout (EXECUTING → BURNING)');
  // ─────────────────────────────────────────────────────────────────
  // This replicates exactly what KeeperHub Arbiter does: poll root-hash-check
  // until verified === true, then call arbiter-fired.
  {
    log('INFO', 'Polling /internal/root-hash-check until 0G confirms rootHash…');
    let verified = false;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const { ok, data } = await internalApi('GET', `/internal/root-hash-check/${dealId}`);
      if (ok && data.verified) { verified = true; break; }
      await sleep(3000);
    }
    assert(verified, '0G rootHash confirmed on-chain', `rootHash: ${rootHash}`);

    const { ok, data } = await internalApi('POST', '/internal/arbiter-fired', { dealId });
    assert(ok, 'POST /internal/arbiter-fired returns 200', JSON.stringify(data));
    assert(data.status === 'BURNING', `Status is BURNING (got ${data.status})`);
    pass(`status: ${data.status}`);
  }

  // ─────────────────────────────────────────────────────────────────
  step(13, 'KeeperHub janitor burns ENS subnames (BURNING → COMPLETE)');
  // ─────────────────────────────────────────────────────────────────
  // KeeperHub Janitor fires this after completing ENS subname burns.
  // We call it directly here to test the backend handler.
  {
    const { ok, data } = await internalApi('POST', '/internal/janitor-fired', { dealId });
    assert(ok, 'POST /internal/janitor-fired returns 200', JSON.stringify(data));
    assert(data.status === 'COMPLETE', `Status is COMPLETE (got ${data.status})`);
    pass(`status: ${data.status}`);
  }

  // ─────────────────────────────────────────────────────────────────
  step(14, 'Verify access control');
  // ─────────────────────────────────────────────────────────────────
  {
    // A third random agent should not be able to see the deal
    const { status: regStatus, data: regData } = await api('POST', '/api/agents/register', {
      axlPubkey: randomEphemeralAddress().replace('0x', '').padEnd(64, '0'), // valid 64-hex, not real AXL
      ephemeralAddress: randomEphemeralAddress(),
      role: 'buyer',
    });
    if (regStatus === 201) {
      const thirdApiKey = regData.apiKey;
      const { status: peekStatus } = await api('GET', `/api/deals/${dealId}`, null, thirdApiKey);
      assert(peekStatus === 403, `Third-party access denied (got ${peekStatus})`);
    } else {
      warn('Could not register third agent to test access control');
    }

    // Unauthenticated request must be rejected
    const { status: noAuthStatus } = await api('GET', `/api/deals/${dealId}`);
    assert(noAuthStatus === 401, `Unauthenticated request rejected (got ${noAuthStatus})`);

    pass('Access control is enforced');
  }

  // ─────────────────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  console.log(`  Results: ${passed} passed  ${warned} warned  ${failed} failed`);
  console.log('─'.repeat(60) + '\n');

  if (failed > 0) {
    log('FAIL', 'Test suite FAILED');
    process.exit(1);
  } else {
    log('PASS', 'Test suite PASSED');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});
