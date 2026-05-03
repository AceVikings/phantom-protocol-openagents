import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { deals } from '../store.js';
import { DealStatus, transition, canTransition } from '../dealMachine.js';
import { notifyAgent } from '../services/notify.js';
import { sendAxlMessage } from '../services/axl.js';
import { verifyRootHashExists } from '../services/zerog.js';
import { burnDealSubnames } from '../services/ens.js';

export const internalRouter = Router();

function verifySecret(req, res) {
  const secret = req.headers['x-internal-secret'];
  if (process.env.INTERNAL_SECRET && secret !== process.env.INTERNAL_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// GET /internal/root-hash-check/:dealId
// KeeperHub Arbiter polls this to know when to fire payout
internalRouter.get('/root-hash-check/:dealId', async (req, res) => {
  if (!verifySecret(req, res)) return;

  const deal = deals.get(req.params.dealId);
  if (!deal) return res.status(404).json({ verified: false, error: 'Deal not found' });
  if (!deal.rootHash) return res.json({ verified: false });

  const verified = await verifyRootHashExists(deal.rootHash);
  res.json({ verified, dealId: deal.dealId, rootHash: deal.rootHash });
});

// POST /internal/arbiter-fired
// KeeperHub calls this after confirming rootHash on-chain and triggering payout
internalRouter.post('/arbiter-fired', async (req, res) => {
  if (!verifySecret(req, res)) return;

  const { dealId } = req.body;
  if (!dealId) return res.status(400).json({ error: 'dealId is required' });

  const deal = deals.get(dealId);
  if (!deal) return res.status(404).json({ error: 'Deal not found' });

  // Accept both VERIFYING and EXECUTING (compute step may or may not have run yet)
  if (deal.status === DealStatus.VERIFYING) {
    // Advance to EXECUTING first so the machine transition is valid
    deal.status = DealStatus.EXECUTING;
    deal.updatedAt = Date.now();
  }
  if (canTransition(deal.status, DealStatus.BURNING)) {
    transition(deal, DealStatus.BURNING);
  }

  // Notify both parties
  Promise.allSettled([
    sendAxlMessage(deal.buyerAxlPubkey, { type: 'DEAL_DONE', dealId }),
    sendAxlMessage(deal.sellerAxlPubkey, { type: 'DEAL_DONE', dealId }),
  ]).catch(() => {});

  notifyAgent(deal.buyerAgentId, { event: 'DEAL_STATUS_CHANGE', dealId, status: deal.status });
  notifyAgent(deal.sellerAgentId, { event: 'DEAL_STATUS_CHANGE', dealId, status: deal.status });

  res.json({ success: true, status: deal.status });
});

// POST /internal/janitor-fired
// KeeperHub calls this after burning ENS subnames
internalRouter.post('/janitor-fired', async (req, res) => {
  if (!verifySecret(req, res)) return;

  const { dealId } = req.body;
  if (!dealId) return res.status(400).json({ error: 'dealId is required' });

  const deal = deals.get(dealId);
  if (!deal) return res.status(404).json({ error: 'Deal not found' });

  if (canTransition(deal.status, DealStatus.COMPLETE)) {
    transition(deal, DealStatus.COMPLETE);
  }

  // Burn ENS subnames (fire-and-forget — non-blocking, deal is already done)
  burnDealSubnames(deal.dealId).catch((err) =>
    console.error(`[ENS] Failed to burn subnames for deal ${dealId}:`, err.message),
  );

  // Notify both parties the deal is wiped
  Promise.allSettled([
    sendAxlMessage(deal.buyerAxlPubkey, { type: 'BURNED', dealId }),
    sendAxlMessage(deal.sellerAxlPubkey, { type: 'BURNED', dealId }),
  ]).catch(() => {});

  notifyAgent(deal.buyerAgentId, { event: 'DEAL_STATUS_CHANGE', dealId, status: deal.status });
  notifyAgent(deal.sellerAgentId, { event: 'DEAL_STATUS_CHANGE', dealId, status: deal.status });

  // Wipe deal from in-memory store after 5-min audit window
  setTimeout(() => {
    deals.delete(dealId);
    console.log(`[STORE] Deal ${dealId} wiped from memory`);
  }, 5 * 60 * 1000);

  res.json({ success: true, status: deal.status });
});

// ---------------------------------------------------------------------------
// DEV-ONLY: POST /internal/dev/advance
// Skips 0G upload and advances a deal from UPLOADING → VERIFYING → EXECUTING.
// Useful when 0G Storage / Compute are not configured locally.
// NOT registered in production.
// ---------------------------------------------------------------------------
if (process.env.NODE_ENV !== 'production') {
  internalRouter.get('/dev/deals', (req, res) => {
    const all = [];
    for (const [id, deal] of deals.entries()) {
      all.push({ id, status: deal.status, offerId: deal.offerId, createdAt: deal.createdAt, updatedAt: deal.updatedAt, rootHash: deal.rootHash || null });
    }
    res.json(all);
  });

  internalRouter.post('/dev/advance', (req, res) => {
    const { dealId } = req.body;
    if (!dealId) return res.status(400).json({ error: 'dealId is required' });

    const deal = deals.get(dealId);
    if (!deal) return res.status(404).json({ error: 'Deal not found' });

    if (deal.status !== DealStatus.UPLOADING) {
      return res.status(409).json({
        error: `Expected UPLOADING, deal is currently ${deal.status}`,
      });
    }

    deal.rootHash = '0x' + randomBytes(32).toString('hex');
    transition(deal, DealStatus.VERIFYING); // UPLOADING → VERIFYING
    transition(deal, DealStatus.EXECUTING); // VERIFYING  → EXECUTING

    console.log(`[DEV] Advanced deal ${dealId} to ${deal.status} with mock rootHash`);
    res.json({ dealId, status: deal.status, rootHash: deal.rootHash });
  });
}
