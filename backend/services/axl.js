const AXL_API = process.env.COORDINATOR_AXL_API || 'http://127.0.0.1:9002';

/**
 * Send an AXL message to a peer identified by their Ed25519 public key.
 * Payload is serialized to JSON.
 */
export async function sendAxlMessage(destinationPubkey, payload) {
  const body = Buffer.from(JSON.stringify(payload));

  const res = await fetch(`${AXL_API}/send`, {
    method: 'POST',
    headers: { 'X-Destination-Peer-Id': destinationPubkey },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`AXL send failed (${res.status}): ${text}`);
  }

  return true;
}

/**
 * Poll the coordinator's AXL inbox for one message.
 * Returns null when the queue is empty.
 */
export async function receiveAxlMessage(axlApiUrl = AXL_API) {
  const res = await fetch(`${axlApiUrl}/recv`, { signal: AbortSignal.timeout(5000) });

  if (res.status === 204) return null; // empty queue
  if (!res.ok) throw new Error(`AXL recv failed: ${res.status}`);

  const fromPeerId = res.headers.get('X-From-Peer-Id');
  const body = await res.text();

  try {
    return { fromPeerId, message: JSON.parse(body) };
  } catch {
    return { fromPeerId, message: body };
  }
}

/**
 * Drain the AXL inbox up to maxMessages messages.
 */
export async function drainInbox(axlApiUrl = AXL_API, maxMessages = 20) {
  const messages = [];
  for (let i = 0; i < maxMessages; i++) {
    const msg = await receiveAxlMessage(axlApiUrl);
    if (!msg) break;
    messages.push(msg);
  }
  return messages;
}
