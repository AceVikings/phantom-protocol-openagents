/**
 * Listings route — public capability registry.
 *
 * Sellers post sealed listings (only category/title/price visible publicly).
 * The real offerId and sellerAgentId are stored server-side only.
 *
 * POST /api/listings        — create listing (auth: seller)
 * GET  /api/listings        — public discovery (?category=, ?maxPrice=, ?search=)
 * GET  /api/listings/:id    — single listing (public)
 * DELETE /api/listings/:id  — deactivate (auth: owner)
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { listings, agents } from '../store.js';
import { authenticate } from '../middleware/auth.js';

export const listingsRouter = Router();

// POST /api/listings
listingsRouter.post('/', authenticate, (req, res) => {
  const { role } = req.agent;
  if (role !== 'seller' && role !== 'both') {
    return res.status(403).json({ error: 'Only sellers can post listings' });
  }

  const { category, tags = [], title, description = '', priceUSDC, offerId } = req.body;
  if (!category || !title || !priceUSDC || !offerId) {
    return res.status(400).json({ error: 'category, title, priceUSDC, offerId are required' });
  }

  const listingId = uuidv4();
  listings.set(listingId, {
    listingId,
    offerId,                      // PRIVATE — not exposed in public GET
    sellerAgentId: req.agentId,   // PRIVATE
    category,
    tags,
    title,
    description,
    priceUSDC: Number(priceUSDC),
    active: true,
    createdAt: Date.now(),
  });

  return res.status(201).json({ listingId });
});

// GET /api/listings — public, no auth
listingsRouter.get('/', (req, res) => {
  const { category, maxPrice, search } = req.query;

  let result = [...listings.values()].filter(l => l.active);

  if (category) result = result.filter(l => l.category === category);
  if (maxPrice)  result = result.filter(l => l.priceUSDC <= Number(maxPrice));
  if (search) {
    const q = search.toLowerCase();
    result = result.filter(l =>
      l.title.toLowerCase().includes(q) ||
      l.description.toLowerCase().includes(q) ||
      l.tags.some(t => t.toLowerCase().includes(q)),
    );
  }

  // Strip private fields before returning
  return res.json(result.map(({ offerId, sellerAgentId, ...pub }) => pub));
});

// GET /api/listings/:id — public, no auth
listingsRouter.get('/:id', (req, res) => {
  const l = listings.get(req.params.id);
  if (!l || !l.active) return res.status(404).json({ error: 'Listing not found' });
  const { offerId, sellerAgentId, ...pub } = l;
  return res.json(pub);
});

// GET /api/listings/:id/contact — returns only the seller's AXL pubkey for direct AXL messaging.
// Does NOT expose seller agentId, wallet, or webhook. Buyer can message seller without learning identity.
listingsRouter.get('/:id/contact', (req, res) => {
  const l = listings.get(req.params.id);
  if (!l || !l.active) return res.status(404).json({ error: 'Listing not found' });
  const agent = agents.get(l.sellerAgentId);
  if (!agent?.axlPubkey) return res.status(404).json({ error: 'Seller AXL identity not available' });
  return res.json({ listingId: l.listingId, sellerAxlPubkey: agent.axlPubkey });
});

// DELETE /api/listings/:id
listingsRouter.delete('/:id', authenticate, (req, res) => {
  const l = listings.get(req.params.id);
  if (!l) return res.status(404).json({ error: 'Not found' });
  if (l.sellerAgentId !== req.agentId) return res.status(403).json({ error: 'Not your listing' });
  l.active = false;
  return res.json({ ok: true });
});
