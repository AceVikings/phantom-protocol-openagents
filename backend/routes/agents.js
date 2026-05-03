import { Router } from 'express';
import { randomBytes, createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { agents, apiKeys } from '../store.js';
import { authenticate } from '../middleware/auth.js';

export const agentsRouter = Router();

// POST /api/agents/register
agentsRouter.post('/register', (req, res) => {
  const { axlPubkey, ephemeralAddress, role, capabilities = [], webhookUrl } = req.body;

  if (!axlPubkey || !ephemeralAddress || !role) {
    return res.status(400).json({ error: 'axlPubkey, ephemeralAddress, and role are required' });
  }

  if (!['buyer', 'seller', 'both'].includes(role)) {
    return res.status(400).json({ error: 'role must be buyer, seller, or both' });
  }

  // Basic format validation
  if (!/^[0-9a-fA-F]{64}$/.test(axlPubkey)) {
    return res.status(400).json({ error: 'axlPubkey must be a 64-char hex Ed25519 public key' });
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(ephemeralAddress)) {
    return res.status(400).json({ error: 'ephemeralAddress must be a valid 0x-prefixed Ethereum address' });
  }

  const agentId = uuidv4();
  const rawApiKey = randomBytes(32).toString('hex');
  const hashedApiKey = createHash('sha256').update(rawApiKey).digest('hex');

  agents.set(agentId, {
    agentId,
    axlPubkey,
    ephemeralAddress: ephemeralAddress.toLowerCase(),
    role,
    capabilities,
    webhookUrl: webhookUrl || null,
    createdAt: Date.now(),
  });

  apiKeys.set(hashedApiKey, agentId);

  return res.status(201).json({ agentId, apiKey: rawApiKey });
});

// GET /api/agents/me
agentsRouter.get('/me', authenticate, (req, res) => {
  res.json(req.agent);
});

// PATCH /api/agents/me — update webhookUrl without changing agentId/apiKey
agentsRouter.patch('/me', authenticate, (req, res) => {
  const { webhookUrl } = req.body;
  if (!webhookUrl || typeof webhookUrl !== 'string') {
    return res.status(400).json({ error: 'webhookUrl is required' });
  }
  const agent = agents.get(req.agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  agent.webhookUrl = webhookUrl;
  return res.json({ ok: true, agentId: req.agentId, webhookUrl });
});
