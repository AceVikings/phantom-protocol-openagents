#!/usr/bin/env node
/**
 * phantom-axl — CLI for managing a Gensyn AXL node and integrating with the
 * Phantom Protocol backend.
 *
 * Usage:
 *   node axl-cli/index.js <command> [options]
 *
 * Commands:
 *   setup               Clone and build the AXL binary from source
 *   keygen [name]       Generate a fresh Ed25519 keypair
 *   init   [name]       Create a node-config.json for the named key
 *   start  [name]       Start the AXL node (background process)
 *   stop   [name]       Stop the running AXL node
 *   status              Show topology: pubkey, IPv6, peers
 *   register <role>     Register this node's pubkey with the Phantom backend
 *   send <pubkey> <msg> Send a raw message to a peer via AXL
 *   recv [--follow]     Poll AXL inbox (--follow = continuous)
 *   deal <dealId>       Fetch deal status from the Phantom backend
 *
 * All state is stored in ~/.phantom-axl/:
 *   keys/               Ed25519 PEM pairs
 *   configs/            node-config.json files
 *   pids/               PID files for running nodes
 *   agents.json         Saved API keys from `register`
 */

import { execSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────
const ROOT      = join(homedir(), '.phantom-axl');
const KEYS_DIR  = join(ROOT, 'keys');
const CONF_DIR  = join(ROOT, 'configs');
const PIDS_DIR  = join(ROOT, 'pids');
const LOGS_DIR  = join(ROOT, 'logs');
const BIN_DIR   = join(ROOT, 'bin');
const REPO_DIR  = join(ROOT, 'axl-repo');
const AGENTS_FILE = join(ROOT, 'agents.json');

const AXL_BIN   = join(BIN_DIR, 'axl-node');

// Gensyn bootstrap peers (from official node-config.json)
const BOOTSTRAP_PEERS = [
  'tls://34.46.48.224:9001',
  'tls://136.111.135.206:9001',
];

// Default AXL node API URL (can be overridden by AXL_API env var)
const AXL_API   = process.env.AXL_API   || 'http://127.0.0.1:9002';
const BACKEND   = process.env.BACKEND_URL || 'http://localhost:3001';

// ─────────────────────────────────────────────────────────────────────────────
// Terminal colours
// ─────────────────────────────────────────────────────────────────────────────
const isTTY = process.stdout.isTTY && !process.env.NO_COLOR;
const c = isTTY
  ? { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', b: '\x1b[36m', d: '\x1b[2m', bold: '\x1b[1m', x: '\x1b[0m' }
  : { g: '', r: '', y: '', b: '', d: '', bold: '', x: '' };

const ok   = (s) => console.log(`${c.g}✓${c.x} ${s}`);
const err  = (s) => console.error(`${c.r}✗${c.x} ${s}`);
const info = (s) => console.log(`${c.b}·${c.x} ${s}`);
const warn = (s) => console.log(`${c.y}⚠${c.x} ${s}`);
const head = (s) => console.log(`\n${c.bold}${s}${c.x}`);

function die(msg) {
  err(msg);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function ensureDirs() {
  for (const d of [ROOT, KEYS_DIR, CONF_DIR, PIDS_DIR, LOGS_DIR, BIN_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

function ask(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${c.b}?${c.x} ${prompt} `, (ans) => { rl.close(); resolve(ans.trim()); });
  });
}

function readJSON(path, fallback = {}) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function writeJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

async function axlFetch(method, path, body = null) {
  const opts = { method, headers: {} };
  if (body !== null && typeof body === 'string') {
    opts.body = body;
  } else if (body !== null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${AXL_API}${path}`, opts);
  return res;
}

async function backendFetch(method, path, body = null, apiKey = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { _raw: text }; }
  return { status: res.status, ok: res.ok, data };
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

/**
 * setup — clone gensyn-ai/axl and build the binary.
 * Requires Go 1.23–1.25 (Go 1.26+ breaks gVisor dependency).
 */
async function cmdSetup() {
  head('AXL Setup — clone + build gensyn-ai/axl');
  ensureDirs();

  // Check Go
  let goVersion;
  try {
    goVersion = execSync('go version', { encoding: 'utf8' }).trim();
    ok(`Go found: ${goVersion}`);
  } catch {
    die('Go is not installed. Install Go 1.23–1.25 from https://go.dev/dl/\n  (Go 1.26+ breaks the gVisor dependency)');
  }

  // Warn about toolchain version
  const vMatch = goVersion.match(/go(\d+)\.(\d+)/);
  if (vMatch) {
    const major = parseInt(vMatch[1]);
    const minor = parseInt(vMatch[2]);
    if (major === 1 && minor >= 26) {
      warn(`Go ${major}.${minor} detected — gVisor may fail. Recommended: Go 1.23.x`);
      warn('Set GOTOOLCHAIN=go1.25.5 to force an older toolchain.');
    }
  }

  // Clone or update
  if (existsSync(REPO_DIR)) {
    info(`Repo already at ${REPO_DIR} — pulling latest…`);
    try {
      execSync('git pull', { cwd: REPO_DIR, stdio: 'inherit' });
    } catch {
      warn('git pull failed — continuing with existing source');
    }
  } else {
    info('Cloning https://github.com/gensyn-ai/axl …');
    execSync(`git clone https://github.com/gensyn-ai/axl "${REPO_DIR}"`, { stdio: 'inherit' });
  }

  // Build
  info('Building axl-node binary…');
  try {
    execSync(`go build -o "${AXL_BIN}" ./cmd/node`, {
      cwd: REPO_DIR,
      stdio: 'inherit',
      env: { ...process.env, GOTOOLCHAIN: 'go1.25.5' },
    });
  } catch {
    // Retry without toolchain pin
    warn('Build failed with GOTOOLCHAIN pin — retrying without…');
    execSync(`go build -o "${AXL_BIN}" ./cmd/node`, { cwd: REPO_DIR, stdio: 'inherit' });
  }

  ok(`Binary built: ${AXL_BIN}`);
  info(`Next: node axl-cli/index.js keygen mynode`);
}

/**
 * keygen [name=default] — generate Ed25519 keypair using Node.js crypto.
 * Saves private.pem + public.pem to ~/.phantom-axl/keys/<name>/
 */
async function cmdKeygen(args) {
  const name = args[0] || 'default';
  ensureDirs();

  const keyDir = join(KEYS_DIR, name);
  if (!existsSync(keyDir)) mkdirSync(keyDir, { recursive: true });

  const privPath = join(keyDir, 'private.pem');
  const pubPath  = join(keyDir, 'public.pem');

  if (existsSync(privPath)) {
    const overwrite = await ask(`Key "${name}" already exists. Overwrite? [y/N]`);
    if (!overwrite.toLowerCase().startsWith('y')) {
      info('Aborted.'); return;
    }
  }

  // Use Node.js built-in crypto (no need for Homebrew OpenSSL)
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  });

  writeFileSync(privPath, privateKey, { mode: 0o600 });
  writeFileSync(pubPath,  publicKey);

  // Derive hex pubkey (what AXL uses as peer ID)
  const { createPublicKey } = await import('node:crypto');
  const pub = createPublicKey(publicKey);
  const raw = pub.export({ type: 'spki', format: 'der' });
  // Last 32 bytes of SPKI DER for Ed25519 are the raw public key
  const hexPubkey = raw.slice(-32).toString('hex');

  ok(`Keypair "${name}" generated`);
  info(`Private key : ${privPath}`);
  info(`Public key  : ${pubPath}`);
  info(`AXL peer ID : ${hexPubkey}`);
  info(`\nNext: node axl-cli/index.js init ${name}`);
}

/**
 * init [name=default] — create node-config.json for a named keypair.
 * Prompts for API port and whether to use Gensyn bootstrap peers.
 */
async function cmdInit(args) {
  const name = args[0] || 'default';
  ensureDirs();

  const keyDir  = join(KEYS_DIR, name);
  const privPath = join(keyDir, 'private.pem');
  if (!existsSync(privPath)) {
    die(`No keypair named "${name}" found. Run: node axl-cli/index.js keygen ${name}`);
  }

  const confPath = join(CONF_DIR, `${name}.json`);
  if (existsSync(confPath)) {
    const overwrite = await ask(`Config "${name}" already exists. Overwrite? [y/N]`);
    if (!overwrite.toLowerCase().startsWith('y')) { info('Aborted.'); return; }
  }

  const apiPortRaw = await ask('API port [9002]:');
  const tcpPortRaw = await ask('TCP port [7000]:');
  const usePeers   = await ask('Connect to Gensyn bootstrap peers? [Y/n]:');
  const listenRaw  = await ask('Listen for incoming connections? [Y/n]:');

  const apiPort  = parseInt(apiPortRaw)  || 9002;
  const tcpPort  = parseInt(tcpPortRaw)  || 7000;
  const peers    = usePeers.toLowerCase() === 'n' ? [] : BOOTSTRAP_PEERS;
  const listen   = listenRaw.toLowerCase() === 'n' ? [] : [`tls://0.0.0.0:${tcpPort}`];

  const config = {
    PrivateKeyPath: privPath,
    Peers: peers,
    Listen: listen,
    api_port: apiPort,
    tcp_port: tcpPort,
  };

  writeJSON(confPath, config);
  ok(`Config written: ${confPath}`);
  info(`Next: node axl-cli/index.js start ${name}`);
}

/**
 * start [name=default] — spawn axl-node in the background.
 */
async function cmdStart(args) {
  const name = args[0] || 'default';
  ensureDirs();

  if (!existsSync(AXL_BIN)) {
    die(`AXL binary not found at ${AXL_BIN}. Run: node axl-cli/index.js setup`);
  }

  const confPath = join(CONF_DIR, `${name}.json`);
  if (!existsSync(confPath)) {
    die(`No config for "${name}". Run: node axl-cli/index.js init ${name}`);
  }

  const pidPath = join(PIDS_DIR, `${name}.pid`);
  if (existsSync(pidPath)) {
    const pid = readFileSync(pidPath, 'utf8').trim();
    try {
      process.kill(parseInt(pid), 0);
      die(`AXL node "${name}" is already running (PID ${pid}). Use: node axl-cli/index.js stop ${name}`);
    } catch {
      // PID file stale — clean up
      unlinkSync(pidPath);
    }
  }

  const logPath = join(LOGS_DIR, `${name}.log`);
  const { openSync } = await import('node:fs');
  const out = openSync(logPath, 'a');
  const child = spawn(AXL_BIN, ['-config', confPath], {
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();

  writeFileSync(pidPath, String(child.pid));

  ok(`AXL node "${name}" started (PID ${child.pid})`);
  info(`Logs : ${logPath}`);
  info(`API  : ${AXL_API}`);
  info(`\nWaiting for node to initialise…`);

  // Poll /topology for up to 10 seconds
  let pubkey = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await axlFetch('GET', '/topology');
      if (res.ok) {
        const topo = await res.json();
        pubkey = topo.our_public_key;
        break;
      }
    } catch { /* still starting */ }
  }

  if (pubkey) {
    ok(`Node online — pubkey: ${pubkey}`);
    info(`Next: node axl-cli/index.js register seller   # or buyer`);
  } else {
    warn(`Node started but /topology not responding yet. Check logs: ${logPath}`);
  }
}

/**
 * stop [name=default] — kill the running AXL node.
 */
async function cmdStop(args) {
  const name = args[0] || 'default';
  const pidPath = join(PIDS_DIR, `${name}.pid`);

  if (!existsSync(pidPath)) {
    die(`No PID file for "${name}". Is the node running?`);
  }

  const pid = parseInt(readFileSync(pidPath, 'utf8').trim());
  try {
    process.kill(pid, 'SIGTERM');
    unlinkSync(pidPath);
    ok(`AXL node "${name}" stopped (PID ${pid})`);
  } catch (e) {
    unlinkSync(pidPath);
    warn(`PID ${pid} not found — cleaned up stale PID file.`);
  }
}

/**
 * status — GET /topology and display node info.
 */
async function cmdStatus() {
  let res;
  try {
    res = await axlFetch('GET', '/topology');
  } catch (e) {
    die(`Cannot reach AXL node at ${AXL_API}: ${e.message}\nIs the node running? node axl-cli/index.js start`);
  }

  if (!res.ok) {
    die(`/topology returned HTTP ${res.status}`);
  }

  const topo = await res.json();
  head('AXL Node Status');
  ok(`Peer ID (pubkey): ${topo.our_public_key}`);
  info(`IPv6 address    : ${topo.our_ipv6 || 'n/a'}`);
  info(`API endpoint    : ${AXL_API}`);

  const peers = topo.peers || [];
  if (peers.length === 0) {
    warn(`Peers: none connected yet`);
  } else {
    info(`Peers (${peers.length}):`);
    for (const p of peers) {
      const status = p.up ? `${c.g}UP${c.x}` : `${c.r}DOWN${c.x}`;
      console.log(`  ${status}  ${p.public_key}`);
    }
  }
}

/**
 * register <role> — register this AXL node's pubkey with the Phantom backend.
 * Saves the returned API key to ~/.phantom-axl/agents.json
 */
async function cmdRegister(args) {
  const role = args[0];
  if (!role || !['seller', 'buyer', 'both'].includes(role)) {
    die(`Usage: node axl-cli/index.js register <seller|buyer|both>`);
  }

  // Get our pubkey from the running node
  let topology;
  try {
    const res = await axlFetch('GET', '/topology');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    topology = await res.json();
  } catch (e) {
    die(`Cannot reach AXL node at ${AXL_API}: ${e.message}\nStart the node first: node axl-cli/index.js start`);
  }

  const axlPubkey = topology.our_public_key;
  if (!axlPubkey || axlPubkey.length !== 64) {
    die(`Unexpected pubkey format from topology: ${axlPubkey}`);
  }

  // Generate a fresh ephemeral Ethereum address for this agent
  const { randomBytes } = await import('node:crypto');
  const ephemeralAddress = '0x' + randomBytes(20).toString('hex');

  const webhookUrlRaw = await ask(`Webhook URL for deal notifications (leave blank to skip):`);
  const webhookUrl = webhookUrlRaw || undefined;

  info(`Registering with Phantom backend at ${BACKEND}…`);
  const { status, ok: resOk, data } = await backendFetch('POST', '/api/agents/register', {
    axlPubkey,
    ephemeralAddress,
    role,
    webhookUrl,
    capabilities: [],
  });

  if (!resOk) {
    die(`Registration failed (HTTP ${status}): ${JSON.stringify(data)}`);
  }

  // Persist agent credentials
  const agents = readJSON(AGENTS_FILE);
  agents[axlPubkey] = {
    agentId: data.agentId,
    apiKey: data.apiKey,
    role,
    ephemeralAddress,
    registeredAt: new Date().toISOString(),
  };
  writeJSON(AGENTS_FILE, agents);

  ok(`Registered as ${role}`);
  info(`Agent ID : ${data.agentId}`);
  info(`API Key  : ${data.apiKey}`);
  info(`Pubkey   : ${axlPubkey}`);
  warn(`API key saved to ${AGENTS_FILE} — keep this file private`);
}

/**
 * send <pubkey> <message> — send a raw AXL message to a peer.
 */
async function cmdSend(args) {
  const [pubkey, ...msgParts] = args;
  if (!pubkey || msgParts.length === 0) {
    die(`Usage: node axl-cli/index.js send <64-hex-pubkey> <message>`);
  }
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
    die(`Invalid pubkey — must be 64 hex characters`);
  }

  const message = msgParts.join(' ');
  let res;
  try {
    res = await fetch(`${AXL_API}/send`, {
      method: 'POST',
      headers: { 'X-Destination-Peer-Id': pubkey },
      body: message,
    });
  } catch (e) {
    die(`Cannot reach AXL node: ${e.message}`);
  }

  if (res.ok) {
    const sent = res.headers.get('X-Sent-Bytes') || message.length;
    ok(`Message delivered (${sent} bytes)`);
  } else if (res.status === 502) {
    die(`Peer unreachable (502) — is the peer node running and connected?`);
  } else {
    die(`Send failed (HTTP ${res.status})`);
  }
}

/**
 * recv [--follow] — poll /recv once, or continuously with --follow.
 */
async function cmdRecv(args) {
  const follow = args.includes('--follow');

  async function pollOnce() {
    let res;
    try {
      res = await axlFetch('GET', '/recv');
    } catch (e) {
      die(`Cannot reach AXL node: ${e.message}`);
    }

    if (res.status === 204) {
      if (!follow) info('Inbox empty');
      return false;
    }

    if (res.ok) {
      const body = await res.text();
      const from = (res.headers.get('X-From-Peer-Id') || '').slice(0, 64);
      console.log(`\n${c.bold}From:${c.x} ${from}`);
      console.log(`${c.bold}Message:${c.x}`);
      console.log(body);
      return true;
    }

    err(`/recv returned HTTP ${res.status}`);
    return false;
  }

  if (!follow) {
    await pollOnce();
    return;
  }

  info(`Polling inbox at ${AXL_API}/recv  (Ctrl+C to stop)…\n`);
  while (true) {
    await pollOnce();
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * deal <dealId> — fetch deal status from the Phantom backend.
 */
async function cmdDeal(args) {
  const dealId = args[0];
  if (!dealId) die(`Usage: node axl-cli/index.js deal <dealId>`);

  // Try to find a saved API key
  const agents = readJSON(AGENTS_FILE);
  const saved = Object.values(agents)[0];
  if (!saved) {
    die(`No registered agents found. Run: node axl-cli/index.js register <role>`);
  }

  const { status, ok: resOk, data } = await backendFetch(
    'GET', `/api/deals/${dealId}`, null, saved.apiKey,
  );

  if (status === 404) die(`Deal not found: ${dealId}`);
  if (status === 403) die(`Access denied — you are not a party to this deal`);
  if (!resOk) die(`Backend error (HTTP ${status}): ${JSON.stringify(data)}`);

  head(`Deal ${dealId}`);
  ok(`Status      : ${data.status}`);
  info(`Offer       : ${data.offerId}`);
  info(`Price USDC  : ${data.priceUSDC}`);
  info(`Lock tx     : ${data.lockTxHash || 'not yet'}`);
  info(`Root hash   : ${data.rootHash   || 'not yet'}`);
  info(`Created     : ${new Date(data.createdAt).toLocaleString()}`);
  info(`Expires     : ${new Date(data.expiresAt).toLocaleString()}`);
}

/**
 * help — print usage summary.
 */
function cmdHelp() {
  console.log(`
${c.bold}phantom-axl${c.x} — Gensyn AXL node manager + Phantom Protocol CLI

${c.bold}Node lifecycle:${c.x}
  setup               Clone & build the AXL binary from source
  keygen [name]       Generate Ed25519 keypair (saved to ~/.phantom-axl/keys/)
  init   [name]       Create node-config.json for a named keypair
  start  [name]       Start the AXL node in the background
  stop   [name]       Stop the running AXL node
  status              Show pubkey, IPv6, and connected peers

${c.bold}Phantom Protocol:${c.x}
  register <role>     Register this node with the backend (seller | buyer | both)
  deal <dealId>       Show live deal status

${c.bold}Messaging:${c.x}
  send <pubkey> <msg> Send a raw message to a peer
  recv [--follow]     Poll inbox once, or continuously

${c.bold}Environment:${c.x}
  AXL_API             AXL node HTTP API URL   (default: http://127.0.0.1:9002)
  BACKEND_URL         Phantom backend URL     (default: http://localhost:3001)
  NO_COLOR            Set to disable colours
`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────
const [, , cmd, ...rest] = process.argv;

switch (cmd) {
  case 'setup':    await cmdSetup();         break;
  case 'keygen':   await cmdKeygen(rest);    break;
  case 'init':     await cmdInit(rest);      break;
  case 'start':    await cmdStart(rest);     break;
  case 'stop':     await cmdStop(rest);      break;
  case 'status':   await cmdStatus();        break;
  case 'register': await cmdRegister(rest);  break;
  case 'send':     await cmdSend(rest);      break;
  case 'recv':     await cmdRecv(rest);      break;
  case 'deal':     await cmdDeal(rest);      break;
  case 'help':
  case '--help':
  case '-h':       cmdHelp();                break;
  default:
    if (cmd) err(`Unknown command: ${cmd}\n`);
    cmdHelp();
    if (cmd) process.exit(1);
}
