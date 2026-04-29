import { createHash } from 'crypto';
import { apiKeys, agents } from '../store.js';

export function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const rawKey = authHeader.slice(7);
  if (!rawKey || rawKey.length < 32) {
    return res.status(401).json({ error: 'Invalid API key format' });
  }

  const hashed = createHash('sha256').update(rawKey).digest('hex');
  const agentId = apiKeys.get(hashed);

  if (!agentId) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  req.agentId = agentId;
  req.agent = agents.get(agentId);
  next();
}
