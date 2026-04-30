import { randomBytes } from 'node:crypto';

export const BASE = process.env.BACKEND_URL || 'http://localhost:3001';

// ---------------------------------------------------------------------------
// ANSI terminal colors
// ---------------------------------------------------------------------------
const NO_COLOR = process.env.NO_COLOR || !process.stdout.isTTY;
const c = NO_COLOR
  ? { green: '', red: '', yellow: '', cyan: '', dim: '', bold: '', reset: '' }
  : {
      green: '\x1b[32m',
      red: '\x1b[31m',
      yellow: '\x1b[33m',
      cyan: '\x1b[36m',
      dim: '\x1b[2m',
      bold: '\x1b[1m',
      reset: '\x1b[0m',
    };

const ICONS = { PASS: '✓', FAIL: '✗', WARN: '⚠', INFO: '·', STEP: '▶' };
const COLORS = {
  PASS: c.green,
  FAIL: c.red,
  WARN: c.yellow,
  INFO: c.cyan,
  STEP: c.bold,
};

export function log(level, ...args) {
  const ts = new Date().toISOString().slice(11, 23);
  const color = COLORS[level] || c.reset;
  const icon = ICONS[level] || ' ';
  console.log(`${c.dim}[${ts}]${c.reset} ${color}${icon}${c.reset} ${args.join(' ')}`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/** Generic JSON API call. */
export async function api(method, path, body = null, apiKey = null, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const opts = { method, headers };

  if (body instanceof FormData) {
    opts.body = body;
    // Do NOT set Content-Type — fetch adds it automatically with multipart boundary
  } else if (body !== null) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(`${BASE}${path}`, opts);
  } catch (err) {
    throw new Error(`Network error calling ${method} ${path}: ${err.message}`);
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { _raw: text };
  }

  return { status: res.status, ok: res.ok, data };
}

/** Internal-only API call — adds X-Internal-Secret header. */
export function internalApi(method, path, body = null) {
  const secret = process.env.INTERNAL_SECRET || '';
  return api(method, path, body, null, { 'X-Internal-Secret': secret });
}

/** Multipart file upload. */
export async function uploadFile(apiKey, dealId, buffer, filename = 'payload.enc') {
  const form = new FormData();
  form.append(
    'file',
    new Blob([buffer], { type: 'application/octet-stream' }),
    filename,
  );
  return api('POST', `/api/deals/${dealId}/upload`, form, apiKey);
}

// ---------------------------------------------------------------------------
// Random key generators
// ---------------------------------------------------------------------------

/** 64-char hex Ed25519 public key (mock). */
export function randomAxlPubkey() {
  return randomBytes(32).toString('hex');
}

/** 0x-prefixed Ethereum address (mock). */
export function randomEphemeralAddress() {
  return '0x' + randomBytes(20).toString('hex');
}

/** 0x-prefixed 32-byte tx hash (mock). */
export function randomTxHash() {
  return '0x' + randomBytes(32).toString('hex');
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll GET /api/deals/:dealId until status reaches one of `expected` states.
 * Throws on FAILED, REFUNDING (unless those are expected), or timeout.
 */
export async function pollDealStatus(dealId, apiKey, expected, timeoutMs = 8000) {
  const expectedSet = new Set(Array.isArray(expected) ? expected : [expected]);
  const terminalStates = new Set(['FAILED', 'REFUNDING']);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { ok, data } = await api('GET', `/api/deals/${dealId}`, null, apiKey);
    if (!ok) throw new Error(`GET /api/deals/${dealId} failed: ${JSON.stringify(data)}`);
    if (expectedSet.has(data.status)) return data;
    if (terminalStates.has(data.status) && !expectedSet.has(data.status)) {
      throw new Error(`Deal entered terminal state: ${data.status}`);
    }
    await sleep(250);
  }
  throw new Error(`Timeout waiting for deal status: ${[...expectedSet].join(' | ')}`);
}
