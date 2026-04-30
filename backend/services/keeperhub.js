const KH_BASE = 'https://app.keeperhub.com/api';

function getHeaders() {
  return {
    Authorization: `Bearer ${process.env.KH_API_KEY || ''}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Create the Arbiter workflow for a deal.
 * The Arbiter polls /internal/root-hash-check/:dealId every 30s.
 * When verified === true it posts to /internal/arbiter-fired.
 */
export async function createArbiterWorkflow(dealId) {
  const backendUrl = process.env.BACKEND_URL || 'http://localhost:3001';
  const internalSecret = process.env.INTERNAL_SECRET || '';

  const body = {
    name: `Phantom Arbiter — ${dealId.slice(0, 8)}`,
    description: `Monitor 0G rootHash for deal ${dealId} and trigger payout`,
    nodes: [
      {
        id: 'trigger-1',
        type: 'trigger',
        position: { x: 0, y: 0 },
        data: {
          type: 'trigger',
          label: '',
          description: '',
          config: { triggerType: 'Interval', intervalSeconds: 30 },
          status: 'idle',
        },
      },
      {
        id: 'check-0g-1',
        type: 'action',
        position: { x: 272, y: 0 },
        data: {
          type: 'action',
          label: '',
          description: '',
          config: {
            actionType: 'http/get',
            url: `${backendUrl}/internal/root-hash-check/${dealId}`,
            headers: { 'X-Internal-Secret': internalSecret },
          },
          status: 'idle',
        },
      },
      {
        id: 'payout-1',
        type: 'action',
        position: { x: 544, y: 0 },
        data: {
          type: 'action',
          label: '',
          description: '',
          config: {
            actionType: 'http/post',
            url: `${backendUrl}/internal/arbiter-fired`,
            headers: {
              'X-Internal-Secret': internalSecret,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ dealId }),
            condition: '{{check-0g-1.body.verified}} === true',
          },
          status: 'idle',
        },
      },
    ],
    edges: [
      { id: 'e1', source: 'trigger-1', target: 'check-0g-1' },
      { id: 'e2', source: 'check-0g-1', target: 'payout-1' },
    ],
  };

  const res = await fetch(`${KH_BASE}/workflows/create`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`KeeperHub arbiter creation failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const arbiterWorkflowId = data.data?.id || data.id;
  console.log(`[KeeperHub] Arbiter workflow created: ${arbiterWorkflowId}`);
  return { arbiterWorkflowId };
}

/**
 * Create the Janitor workflow that fires once at expiresAt.
 * It calls /internal/janitor-fired which burns ENS subnames and wipes the deal.
 */
export async function createJanitorWorkflow(dealId, expiresAt) {
  const backendUrl = process.env.BACKEND_URL || 'http://localhost:3001';
  const internalSecret = process.env.INTERNAL_SECRET || '';
  const janitorFireAt = new Date(expiresAt).toISOString();

  const body = {
    name: `Phantom Janitor — ${dealId.slice(0, 8)}`,
    description: `Burn ENS subnames and wipe deal ${dealId} at ${janitorFireAt}`,
    nodes: [
      {
        id: 'trigger-1',
        type: 'trigger',
        position: { x: 0, y: 0 },
        data: {
          type: 'trigger',
          label: '',
          description: '',
          config: { triggerType: 'ScheduledOnce', runAt: janitorFireAt },
          status: 'idle',
        },
      },
      {
        id: 'callback-1',
        type: 'action',
        position: { x: 272, y: 0 },
        data: {
          type: 'action',
          label: '',
          description: '',
          config: {
            actionType: 'http/post',
            url: `${backendUrl}/internal/janitor-fired`,
            headers: {
              'X-Internal-Secret': internalSecret,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ dealId }),
          },
          status: 'idle',
        },
      },
    ],
    edges: [{ id: 'e1', source: 'trigger-1', target: 'callback-1' }],
  };

  const res = await fetch(`${KH_BASE}/workflows/create`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`KeeperHub janitor creation failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const janitorWorkflowId = data.data?.id || data.id;
  console.log(`[KeeperHub] Janitor workflow created: ${janitorWorkflowId}`);
  return { janitorWorkflowId };
}

/**
 * Get the latest execution status for a workflow.
 */
export async function getWorkflowStatus(workflowId) {
  const res = await fetch(`${KH_BASE}/workflows/${workflowId}/executions/latest`, {
    headers: getHeaders(),
  });
  if (!res.ok) throw new Error(`KeeperHub status fetch failed: ${res.status}`);
  return res.json();
}

/**
 * Delete a workflow (cleanup after deal completes).
 */
export async function deleteWorkflow(workflowId) {
  const res = await fetch(`${KH_BASE}/workflows/${workflowId}`, {
    method: 'DELETE',
    headers: getHeaders(),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`KeeperHub workflow delete failed: ${res.status}`);
  }
  return true;
}
