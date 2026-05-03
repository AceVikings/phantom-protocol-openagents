/**
 * Negotiations route — blind relay price negotiation.
 *
 * Coordinator routes encrypted proposals between buyer and seller.
 * Neither party learns the other's identity or webhook URL during negotiation.
 * All messages are relayed as-is; coordinator cannot read content.
 *
 * POST /api/negotiations              — buyer opens negotiation on a listing
 * POST /api/negotiations/:id/counter  — seller counters
 * POST /api/negotiations/:id/accept   — buyer or seller accepts current price
 * POST /api/negotiations/:id/reject   — buyer or seller rejects
 * GET  /api/negotiations/:id          — status (parties only)
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { negotiations, listings, offers, agents } from '../store.js';
import { authenticate } from '../middleware/auth.js';
import { notifyAgent } from '../services/notify.js';

export const negotiationsRouter = Router();

// POST /api/negotiations
negotiationsRouter.post('/', authenticate, async (req, res) => {
  if (req.agent.role !== 'buyer' && req.agent.role !== 'both') {
    return res.status(403).json({ error: 'Only buyers can initiate negotiations' });
  }

  const { listingId, proposedPrice, message = '' } = req.body;
  if (!listingId || proposedPrice == null) {
    return res.status(400).json({ error: 'listingId and proposedPrice are required' });
  }

  const listing = listings.get(listingId);
  if (!listing || !listing.active) return res.status(404).json({ error: 'Listing not found' });

  const negotiationId = uuidv4();
  negotiations.set(negotiationId, {
    negotiationId,
    listingId,
    offerId: listing.offerId,        // used when converting to deal
    buyerAgentId: req.agentId,
    sellerAgentId: listing.sellerAgentId,
    listedPrice: listing.priceUSDC,
    currentPrice: Number(proposedPrice),
    rounds: [{ by: 'buyer', price: Number(proposedPrice), message, at: Date.now() }],
    status: 'PENDING',               // PENDING | COUNTERED | ACCEPTED | REJECTED
    dealId: null,
    createdAt: Date.now(),
  });

  // Blind relay to seller — buyer identity NOT included
  notifyAgent(listing.sellerAgentId, {
    event: 'NEGOTIATION_PROPOSAL',
    negotiationId,
    listingId,
    listedPrice: listing.priceUSDC,
    proposedPrice: Number(proposedPrice),
    message,
    rounds: 1,
  });

  return res.status(201).json({ negotiationId, status: 'PENDING' });
});

// POST /api/negotiations/:id/counter — seller counters
negotiationsRouter.post('/:id/counter', authenticate, async (req, res) => {
  const neg = negotiations.get(req.params.id);
  if (!neg) return res.status(404).json({ error: 'Negotiation not found' });
  if (neg.sellerAgentId !== req.agentId) return res.status(403).json({ error: 'Not your negotiation' });
  if (!['PENDING', 'COUNTERED'].includes(neg.status)) {
    return res.status(400).json({ error: `Cannot counter a ${neg.status} negotiation` });
  }

  const { counterPrice, message = '' } = req.body;
  if (counterPrice == null) return res.status(400).json({ error: 'counterPrice is required' });

  neg.currentPrice = Number(counterPrice);
  neg.rounds.push({ by: 'seller', price: Number(counterPrice), message, at: Date.now() });
  neg.status = 'COUNTERED';

  // Blind relay to buyer — seller identity NOT included
  notifyAgent(neg.buyerAgentId, {
    event: 'NEGOTIATION_COUNTER',
    negotiationId: neg.negotiationId,
    counterPrice: Number(counterPrice),
    message,
    rounds: neg.rounds.length,
  });

  return res.json({ ok: true, rounds: neg.rounds.length });
});

// POST /api/negotiations/:id/accept
negotiationsRouter.post('/:id/accept', authenticate, async (req, res) => {
  const neg = negotiations.get(req.params.id);
  if (!neg) return res.status(404).json({ error: 'Negotiation not found' });

  const isBuyer  = neg.buyerAgentId  === req.agentId;
  const isSeller = neg.sellerAgentId === req.agentId;
  if (!isBuyer && !isSeller) return res.status(403).json({ error: 'Not a party to this negotiation' });
  if (!['PENDING', 'COUNTERED'].includes(neg.status)) {
    return res.status(400).json({ error: `Cannot accept a ${neg.status} negotiation` });
  }

  neg.status = 'ACCEPTED';
  neg.rounds.push({ by: isBuyer ? 'buyer' : 'seller', price: neg.currentPrice, message: 'accepted', at: Date.now() });

  // Update the linked offer price to match negotiated price
  const offer = offers.get(neg.offerId);
  if (offer) offer.priceUSDC = String(neg.currentPrice);

  // Notify both parties
  const payload = {
    event: 'NEGOTIATION_ACCEPTED',
    negotiationId: neg.negotiationId,
    offerId: neg.offerId,
    finalPrice: neg.currentPrice,
  };
  notifyAgent(neg.buyerAgentId, payload);
  notifyAgent(neg.sellerAgentId, payload);

  return res.json({ ok: true, offerId: neg.offerId, finalPrice: neg.currentPrice });
});

// POST /api/negotiations/:id/reject
negotiationsRouter.post('/:id/reject', authenticate, async (req, res) => {
  const neg = negotiations.get(req.params.id);
  if (!neg) return res.status(404).json({ error: 'Negotiation not found' });

  const isBuyer  = neg.buyerAgentId  === req.agentId;
  const isSeller = neg.sellerAgentId === req.agentId;
  if (!isBuyer && !isSeller) return res.status(403).json({ error: 'Not a party to this negotiation' });

  neg.status = 'REJECTED';

  const otherAgentId = isBuyer ? neg.sellerAgentId : neg.buyerAgentId;
  notifyAgent(otherAgentId, {
    event: 'NEGOTIATION_REJECTED',
    negotiationId: neg.negotiationId,
  });

  return res.json({ ok: true });
});

// GET /api/negotiations — list my negotiations (buyer sees theirs, seller sees theirs)
negotiationsRouter.get('/', authenticate, (req, res) => {
  const myAddr = req.agent?.ephemeralAddress?.toLowerCase();
  const mine = [...negotiations.values()].filter(n => {
    if (n.buyerAgentId === req.agentId || n.sellerAgentId === req.agentId) return true;
    // Also match by wallet address — handles re-registration and self-deal identity switching
    if (myAddr) {
      const buyerAgent  = agents.get(n.buyerAgentId);
      const sellerAgent = agents.get(n.sellerAgentId);
      if (buyerAgent?.ephemeralAddress  === myAddr) return true;
      if (sellerAgent?.ephemeralAddress === myAddr) return true;
    }
    return false;
  });
  return res.json(mine.map(neg => {
    const myAgentId = neg.buyerAgentId === req.agentId ? req.agentId
      : neg.sellerAgentId === req.agentId ? req.agentId
      : req.agentId;
    const isBuyer = neg.buyerAgentId === req.agentId ||
      agents.get(neg.buyerAgentId)?.ephemeralAddress?.toLowerCase() === myAddr;
    const { buyerAgentId, sellerAgentId, offerId, ...pub } = neg;
    const extra = neg.status === 'ACCEPTED' ? { offerId } : {};
    return { ...pub, ...extra, role: isBuyer ? 'buyer' : 'seller' };
  }));
});

// GET /api/negotiations/:id — parties only
negotiationsRouter.get('/:id', authenticate, (req, res) => {
  const neg = negotiations.get(req.params.id);
  if (!neg) return res.status(404).json({ error: 'Not found' });

  const myAddr = req.agent?.ephemeralAddress?.toLowerCase();
  const buyerAgent  = agents.get(neg.buyerAgentId);
  const sellerAgent = agents.get(neg.sellerAgentId);

  const isBuyer  = neg.buyerAgentId  === req.agentId || buyerAgent?.ephemeralAddress?.toLowerCase()  === myAddr;
  const isSeller = neg.sellerAgentId === req.agentId || sellerAgent?.ephemeralAddress?.toLowerCase() === myAddr;
  if (!isBuyer && !isSeller) return res.status(403).json({ error: 'Not a party' });

  // Strip the counterparty's identity; expose offerId only once accepted
  const { buyerAgentId, sellerAgentId, offerId, ...pub } = neg;
  const extra = neg.status === 'ACCEPTED' ? { offerId } : {};
  return res.json({ ...pub, ...extra, role: isBuyer ? 'buyer' : 'seller' });
});
