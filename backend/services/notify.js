import { agents } from '../store.js';

/**
 * Push a deal event to an agent's registered webhookUrl (fire-and-forget).
 * Agents that didn't register a webhookUrl must poll GET /api/deals/:id.
 */
export async function notifyAgent(agentId, payload) {
  const agent = agents.get(agentId);
  if (!agent?.webhookUrl) return;

  try {
    await fetch(agent.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, timestamp: Date.now() }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.warn(`[NOTIFY] Webhook delivery failed for agent ${agentId}:`, err.message);
  }
}
