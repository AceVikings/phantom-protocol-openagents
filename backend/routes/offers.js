import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { offers } from '../store.js';
import { authenticate } from '../middleware/auth.js';

export const offersRouter = Router();

// GET /api/offers — public, no auth required
offersRouter.get('/', (req, res) => {
  const { payloadType, maxPriceUSDC } = req.query;

  let result = Array.from(offers.values()).filter((o) => o.active);

  if (payloadType) {
    result = result.filter((o) => o.payloadType === payloadType);
  }

  if (maxPriceUSDC) {
    const max = parseFloat(maxPriceUSDC);
    if (!isNaN(max)) {
      result = result.filter((o) => parseFloat(o.priceUSDC) <= max);
    }
  }

  // Strip internal sellerAgentId — expose only the AXL pubkey
  const safe = result.map(({ sellerAgentId: _id, ...rest }) => rest);
  res.json(safe);
});

// POST /api/offers — seller creates a listing
offersRouter.post('/', authenticate, (req, res) => {
  const { role } = req.agent;
  if (role !== 'seller' && role !== 'both') {
    return res.status(403).json({ error: 'Only sellers can create offers' });
  }

  const { description, payloadType, priceUSDC, tokenOut, expectedSizeBytes, expectedSha256 } =
    req.body;

  if (!description || !payloadType || !priceUSDC || !tokenOut) {
    return res
      .status(400)
      .json({ error: 'description, payloadType, priceUSDC, and tokenOut are required' });
  }

  const offerId = uuidv4();

  offers.set(offerId, {
    offerId,
    sellerAgentId: req.agentId,
    sellerAxlPubkey: req.agent.axlPubkey,
    sellerEphemeralAddress: req.agent.ephemeralAddress,
    description,
    payloadType,
    priceUSDC: String(priceUSDC),
    tokenOut,
    expectedSizeBytes: expectedSizeBytes || null,
    expectedSha256: expectedSha256 || null,
    active: true,
    createdAt: Date.now(),
  });

  res.status(201).json({ offerId });
});

// DELETE /api/offers/:offerId — seller deactivates listing
offersRouter.delete('/:offerId', authenticate, (req, res) => {
  const offer = offers.get(req.params.offerId);
  if (!offer) return res.status(404).json({ error: 'Offer not found' });
  if (offer.sellerAgentId !== req.agentId) return res.status(403).json({ error: 'Not your offer' });

  offer.active = false;
  res.json({ success: true });
});
