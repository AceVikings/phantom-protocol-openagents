import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { sendAxlMessage, drainInbox } from '../services/axl.js';

export const messagesRouter = Router();

/**
 * POST /api/messages/send
 * Relay an AXL message to another agent via the coordinator's AXL node.
 * Body: { destinationAxlPubkey: string, payload: object }
 */
messagesRouter.post('/send', authenticate, async (req, res) => {
  const { destinationAxlPubkey, payload } = req.body;

  if (!destinationAxlPubkey || !payload) {
    return res.status(400).json({ error: 'destinationAxlPubkey and payload are required' });
  }

  if (!/^[0-9a-fA-F]{64}$/.test(destinationAxlPubkey)) {
    return res.status(400).json({ error: 'destinationAxlPubkey must be a 64-char hex Ed25519 public key' });
  }

  try {
    await sendAxlMessage(destinationAxlPubkey, { ...payload, fromAgentId: req.agent.agentId });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(502).json({ error: `AXL relay failed: ${e.message}` });
  }
});

/**
 * GET /api/messages/inbox
 * Drain up to 20 messages from the coordinator AXL inbox for the requesting agent.
 */
messagesRouter.get('/inbox', authenticate, async (_req, res) => {
  try {
    const messages = await drainInbox();
    return res.json(messages);
  } catch (e) {
    return res.status(502).json({ error: `AXL inbox read failed: ${e.message}` });
  }
});
