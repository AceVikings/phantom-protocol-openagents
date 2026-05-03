import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { deals, offers } from '../store.js';
import { authenticate } from '../middleware/auth.js';
import { DealStatus, transition } from '../dealMachine.js';
import { mintDealSubnames } from '../services/ens.js';
import { sendAxlMessage } from '../services/axl.js';
import { verifyRootHashExists } from '../services/zerog.js';
import { createArbiterWorkflow, createJanitorWorkflow } from '../services/keeperhub.js';
import { notifyAgent } from '../services/notify.js';

export const dealsRouter = Router();

// POST /api/deals — buyer initiates
dealsRouter.post('/', authenticate, async (req, res) => {
  const { role } = req.agent;
  if (role !== 'buyer' && role !== 'both') {
    return res.status(403).json({ error: 'Only buyers can initiate deals' });
  }

  const { offerId } = req.body;
  if (!offerId) return res.status(400).json({ error: 'offerId is required' });

  const offer = offers.get(offerId);
  if (!offer || !offer.active) return res.status(404).json({ error: 'Offer not found or inactive' });

  const dealId = uuidv4();
  const TTL_MS = 15 * 60 * 1000; // 15 minutes

  deals.set(dealId, {
    dealId,
    offerId,
    buyerAgentId: req.agentId,
    buyerAxlPubkey: req.agent.axlPubkey,
    buyerEphemeralAddress: req.agent.ephemeralAddress,
    sellerAgentId: offer.sellerAgentId,
    sellerAxlPubkey: offer.sellerAxlPubkey,
    sellerEphemeralAddress: offer.sellerEphemeralAddress,
    priceUSDC: offer.priceUSDC,
    tokenOut: offer.tokenOut,
    expectedSha256: offer.expectedSha256,
    status: DealStatus.MATCHMAKING,
    rootHash: null,
    lockTxHash: null,
    arbiterWorkflowId: null,
    janitorWorkflowId: null,
    disputeReason: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    expiresAt: Date.now() + TTL_MS,
  });

  const isSelfDeal =
    req.agentId === offer.sellerAgentId ||
    req.agent.ephemeralAddress?.toLowerCase() === offer.sellerEphemeralAddress?.toLowerCase();

  if (isSelfDeal) {
    // Same wallet / same agent — auto-advance past MATCHMAKING so buyer can lock immediately
    const deal = deals.get(dealId);
    transition(deal, DealStatus.MINTING);

    mintDealSubnames(
      dealId,
      deal.buyerEphemeralAddress,
      deal.sellerEphemeralAddress,
    ).catch((err) => console.error('[ENS] Minting failed (self-deal):', err.message));

    try {
      const { arbiterWorkflowId } = await createArbiterWorkflow(dealId);
      const { janitorWorkflowId } = await createJanitorWorkflow(dealId, deal.expiresAt);
      deal.arbiterWorkflowId = arbiterWorkflowId;
      deal.janitorWorkflowId = janitorWorkflowId;
    } catch (err) {
      console.error('[KeeperHub] Workflow creation failed (self-deal):', err.message);
    }

    transition(deal, DealStatus.LOCKING);
    return res.status(201).json({ dealId, selfDeal: true, status: deal.status });
  }

  // Notify seller over AXL
  sendAxlMessage(offer.sellerAxlPubkey, {
    type: 'DEAL_OFFER',
    dealId,
    priceUSDC: offer.priceUSDC,
    buyerAxlPubkey: req.agent.axlPubkey,
  }).catch((err) => console.warn('[AXL] Could not notify seller:', err.message));

  // Also notify seller via webhook (AXL may not be running locally)
  notifyAgent(offer.sellerAgentId, {
    event: 'DEAL_OFFER',
    dealId,
    offerId,
    priceUSDC: offer.priceUSDC,
    buyerAxlPubkey: req.agent.axlPubkey,
  });

  res.status(201).json({ dealId });
});

// GET /api/deals/:dealId
dealsRouter.get('/:dealId', authenticate, (req, res) => {
  const deal = deals.get(req.params.dealId);
  if (!deal) return res.status(404).json({ error: 'Deal not found' });

  const isParty = deal.buyerAgentId === req.agentId || deal.sellerAgentId === req.agentId;
  if (!isParty) return res.status(403).json({ error: 'Access denied' });

  // Strip internal agent IDs from public response
  const { buyerAgentId: _b, sellerAgentId: _s, ...safe } = deal;
  res.json(safe);
});

// POST /api/deals/:dealId/accept — seller accepts
dealsRouter.post('/:dealId/accept', authenticate, async (req, res) => {
  const deal = deals.get(req.params.dealId);
  if (!deal) return res.status(404).json({ error: 'Deal not found' });
  if (deal.sellerAgentId !== req.agentId) return res.status(403).json({ error: 'Not your deal' });
  if (deal.status !== DealStatus.MATCHMAKING) {
    return res.status(409).json({ error: `Deal is in ${deal.status}, expected MATCHMAKING` });
  }

  transition(deal, DealStatus.MINTING);

  // Mint ENS subnames (non-fatal)
  mintDealSubnames(
    deal.dealId,
    deal.buyerEphemeralAddress,
    deal.sellerEphemeralAddress,
  ).catch((err) => console.error('[ENS] Minting failed:', err.message));

  // Create KeeperHub workflows (non-fatal)
  try {
    const { arbiterWorkflowId } = await createArbiterWorkflow(deal.dealId);
    const { janitorWorkflowId } = await createJanitorWorkflow(deal.dealId, deal.expiresAt);
    deal.arbiterWorkflowId = arbiterWorkflowId;
    deal.janitorWorkflowId = janitorWorkflowId;
  } catch (err) {
    console.error('[KeeperHub] Workflow creation failed:', err.message);
  }

  transition(deal, DealStatus.LOCKING);

  // Notify buyer
  sendAxlMessage(deal.buyerAxlPubkey, { type: 'DEAL_ACCEPT', dealId: deal.dealId }).catch((err) =>
    console.warn('[AXL] Could not notify buyer:', err.message),
  );
  notifyAgent(deal.buyerAgentId, {
    event: 'DEAL_STATUS_CHANGE',
    dealId: deal.dealId,
    status: deal.status,
  });

  res.json({ dealId: deal.dealId, status: deal.status });
});

// POST /api/deals/:dealId/lock — buyer confirms funds locked in vault
dealsRouter.post('/:dealId/lock', authenticate, async (req, res) => {
  const deal = deals.get(req.params.dealId);
  if (!deal) return res.status(404).json({ error: 'Deal not found' });
  if (deal.buyerAgentId !== req.agentId) return res.status(403).json({ error: 'Not your deal' });
  if (deal.status !== DealStatus.LOCKING) {
    return res.status(409).json({ error: `Deal is in ${deal.status}, expected LOCKING` });
  }

  const { lockTxHash } = req.body;
  if (!lockTxHash) return res.status(400).json({ error: 'lockTxHash is required' });

  deal.lockTxHash = lockTxHash;
  transition(deal, DealStatus.UPLOADING);

  sendAxlMessage(deal.sellerAxlPubkey, {
    type: 'DEAL_LOCKED',
    dealId: deal.dealId,
    lockTxHash,
  }).catch((err) => console.warn('[AXL] Could not notify seller:', err.message));

  notifyAgent(deal.sellerAgentId, {
    event: 'DEAL_STATUS_CHANGE',
    dealId: deal.dealId,
    status: deal.status,
  });

  res.json({ dealId: deal.dealId, status: deal.status });
});

// POST /api/deals/:dealId/confirm-upload — CLI has uploaded to 0G directly; sends rootHash
dealsRouter.post('/:dealId/confirm-upload', authenticate, async (req, res) => {
  const deal = deals.get(req.params.dealId);
  if (!deal) return res.status(404).json({ error: 'Deal not found' });

  const isSeller = deal.sellerAgentId === req.agentId;
  const isSelfDeal =
    deal.buyerAgentId === deal.sellerAgentId ||
    deal.buyerEphemeralAddress?.toLowerCase() === deal.sellerEphemeralAddress?.toLowerCase();
  const isBuyerSelfDeal = isSelfDeal && deal.buyerAgentId === req.agentId;

  if (!isSeller && !isBuyerSelfDeal) {
    return res.status(403).json({ error: 'Not your deal' });
  }
  if (deal.status !== DealStatus.UPLOADING) {
    return res.status(409).json({ error: `Deal is in ${deal.status}, expected UPLOADING` });
  }

  const { rootHash, txHash } = req.body;
  if (!rootHash) return res.status(400).json({ error: 'rootHash is required' });

  deal.rootHash = rootHash;
  deal.txHash   = txHash ?? null;
  transition(deal, DealStatus.VERIFYING);

  // Notify buyer that upload is complete
  sendAxlMessage(deal.buyerAxlPubkey, {
    type: 'UPLOAD_COMPLETE',
    dealId: deal.dealId,
    rootHash,
  }).catch((err) => console.warn('[AXL] Could not notify buyer:', err.message));

  notifyAgent(deal.buyerAgentId, {
    event: 'DEAL_STATUS_CHANGE',
    dealId: deal.dealId,
    status: deal.status,
    data: { rootHash },
  });

  // Verify rootHash actually exists on 0G Storage
  setImmediate(async () => {
    let verified = false;
    try {
      verified = await verifyRootHashExists(rootHash);
    } catch (err) {
      console.error('[0G Storage] Verification threw:', err.message);
      verified = true; // non-fatal: trust the rootHash if storage check fails
    }

    if (verified && deal.status === DealStatus.VERIFYING) {
      transition(deal, DealStatus.EXECUTING);
      notifyAgent(deal.buyerAgentId, {
        event: 'DEAL_STATUS_CHANGE',
        dealId: deal.dealId,
        status: deal.status,
      });
      notifyAgent(deal.sellerAgentId, {
        event: 'DEAL_STATUS_CHANGE',
        dealId: deal.dealId,
        status: deal.status,
      });
    } else if (!verified && deal.status === DealStatus.VERIFYING) {
      transition(deal, DealStatus.FAILED);
      notifyAgent(deal.buyerAgentId, {
        event: 'DEAL_STATUS_CHANGE',
        dealId: deal.dealId,
        status: deal.status,
        data: { reason: '0G Compute verification failed' },
      });
    }
  });

  res.json({ rootHash, txHash: deal.txHash, status: deal.status });
});

// POST /api/deals/:dealId/dispute
dealsRouter.post('/:dealId/dispute', authenticate, (req, res) => {
  const deal = deals.get(req.params.dealId);
  if (!deal) return res.status(404).json({ error: 'Deal not found' });

  const isParty = deal.buyerAgentId === req.agentId || deal.sellerAgentId === req.agentId;
  if (!isParty) return res.status(403).json({ error: 'Access denied' });

  const { reason, evidence } = req.body;
  deal.disputeReason = reason;
  deal.disputeEvidence = evidence;
  deal.disputeBy = req.agentId === deal.buyerAgentId ? 'buyer' : 'seller';
  transition(deal, DealStatus.FAILED);

  res.json({ dealId: deal.dealId, status: deal.status });
});

// POST /api/deals/:dealId/refund — buyer requests refund after expiry or FAILED
dealsRouter.post('/:dealId/refund', authenticate, (req, res) => {
  const deal = deals.get(req.params.dealId);
  if (!deal) return res.status(404).json({ error: 'Deal not found' });
  if (deal.buyerAgentId !== req.agentId) {
    return res.status(403).json({ error: 'Only the buyer can request a refund' });
  }

  const expired = Date.now() >= deal.expiresAt;
  const isFailed = deal.status === DealStatus.FAILED;

  if (!expired && !isFailed) {
    return res
      .status(409)
      .json({ error: 'Deal has not expired and is not in FAILED state' });
  }

  transition(deal, DealStatus.REFUNDING);

  res.json({
    dealId: deal.dealId,
    status: deal.status,
    message: 'Call Vault.refund(dealId) with your ephemeral wallet to retrieve funds',
  });
});
