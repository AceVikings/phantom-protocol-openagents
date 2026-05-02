/**
 * Phantom Protocol — Interactive Seller Agent (TUI)
 *
 * Features:
 *  - Chat with a local LLM (Ollama) or OpenAI
 *  - `research <topic>` — LLM generates a research report → auto-listed for sale
 *  - Incoming deal offers auto-accepted; uploads the researched file
 *  - Incoming negotiation proposals handled by strategy (counter / accept)
 *
 * Usage:
 *   cd backend
 *   node mock-agents/seller-agent.js            # uses Ollama (llama3.2)
 *   node mock-agents/seller-agent.js --openai   # uses OpenAI (set OPENAI_API_KEY)
 *
 * Environment:
 *   BACKEND_URL          — default http://localhost:3001
 *   SELLER_WEBHOOK_PORT  — default 3002
 *   OLLAMA_MODEL         — default llama3.2
 *   OLLAMA_HOST          — default http://localhost:11434
 *   OPENAI_API_KEY       — required for --openai flag
 */

import 'dotenv/config';
import readline from 'node:readline';
import express from 'express';
import { randomBytes } from 'node:crypto';
import { BASE, api, uploadFile, log, randomAxlPubkey, randomEphemeralAddress } from './utils.js';
import { chat as llmChat, pingOllama, OLLAMA_MODEL, OPENAI_MODEL } from '../services/llm.js';

// ── Config ──────────────────────────────────────────────────────────────────
const WEBHOOK_PORT = parseInt(process.env.SELLER_WEBHOOK_PORT || '3002', 10);
const WEBHOOK_URL  = `http://localhost:${WEBHOOK_PORT}/webhook`;
const PROVIDER     = process.argv.includes('--openai') ? 'openai' : 'ollama';
const MODEL_NAME   = PROVIDER === 'openai' ? OPENAI_MODEL : OLLAMA_MODEL;

// ── ANSI colours ────────────────────────────────────────────────────────────
const NO_COLOR = !process.stdout.isTTY;
const c = NO_COLOR
  ? { g: '', r: '', y: '', b: '', m: '', dim: '', bold: '', reset: '' }
  : { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', b: '\x1b[36m',
      m: '\x1b[35m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' };

// ── Agent state ─────────────────────────────────────────────────────────────
let agentId   = null;
let apiKey    = null;

// listingId → { title, priceUSDC, category, fileBuf, offerId }
const myListings  = new Map();
// offerId → fileBuf  (so we can find the file when a deal arrives)
const offerFiles  = new Map();
// dealId  → fileBuf  (re-keyed once DEAL_OFFER arrives with dealId + offerId)
const dealFiles   = new Map();

// negotiationId → { listingId, listedPrice, rounds }
const activeNegs  = new Map();

// LLM conversation history
const history = [
  { role: 'system', content: `You are a sharp research analyst working inside the Phantom Protocol data marketplace. You help users generate, price, and sell structured research reports. When given a research topic you produce concise, insightful analysis. Keep responses short and to the point.` },
];

// Negotiation strategy
const STRATEGY = {
  floorMultiplier: 0.78,     // never go below 78 % of listed price
  concessionPerRound: 0.06,  // drop 6 % per round
  maxRounds: 3,
};

// ── Readline TUI ─────────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const PROMPT = `\n${c.m}[SELLER ✦ Phantom]${c.reset}$ `;

/** Print lines above the current readline prompt without clobbering typed input. */
function interrupt(...lines) {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  lines.forEach(l => process.stdout.write(l + '\n'));
  rl.prompt(true);
}

function banner() {
  console.log(`\n${c.bold}${c.m}╔══════════════════════════════════════════════════╗`);
  console.log(`║  PHANTOM PROTOCOL — SELLER AGENT                ║`);
  console.log(`║  LLM: ${MODEL_NAME.padEnd(42)}║`);
  console.log(`╚══════════════════════════════════════════════════╝${c.reset}\n`);
}

function showHelp() {
  console.log(`\n${c.bold}Available commands:${c.reset}`);
  console.log(`  ${c.b}research <topic>${c.reset}    — generate & list a research report for sale`);
  console.log(`  ${c.b}list${c.reset}                — show your active listings`);
  console.log(`  ${c.b}status${c.reset}              — show active deals`);
  console.log(`  ${c.b}chat <message>${c.reset}      — chat with the LLM`);
  console.log(`  ${c.b}help${c.reset}                — show this help`);
  console.log(`  ${c.b}exit${c.reset}                — quit\n`);
  console.log(`${c.dim}Tip: anything not matching a command is treated as a chat message.${c.reset}\n`);
}

// ── LLM helpers ──────────────────────────────────────────────────────────────

async function chatWithHistory(userMessage) {
  history.push({ role: 'user', content: userMessage });
  process.stdout.write(`${c.dim}  Thinking…${c.reset}\r`);
  let reply;
  try {
    reply = await llmChat(history, { provider: PROVIDER });
  } catch (err) {
    readline.clearLine(process.stdout, 0);
    console.log(`${c.r}  ✗ LLM error: ${err.message}${c.reset}`);
    history.pop();
    return;
  }
  readline.clearLine(process.stdout, 0);
  history.push({ role: 'assistant', content: reply });

  console.log(`\n${c.b}  Assistant:${c.reset}`);
  console.log('  ' + reply.replace(/\n/g, '\n  ') + '\n');
}

async function generateResearchReport(topic) {
  const researchMessages = [
    {
      role: 'system',
      content: `You are a data research analyst. Return ONLY a valid JSON object with no markdown, no code fences, no extra text.
Schema:
{
  "title": "string — concise report title",
  "category": "string — one of: crypto, defi, nft, macro, tech, ai, commodities, other",
  "tags": ["string"],
  "summary": "string — 2-3 sentence executive summary",
  "keyFindings": ["string — 5 to 7 bullet points"],
  "dataPoints": [{"label":"string","value":"string|number","note":"string"}],
  "methodology": "string",
  "confidence": "high|medium|low",
  "generatedAt": "${new Date().toISOString()}"
}
dataPoints should have 8-12 rows of concrete, plausible data relevant to the topic.`,
    },
    { role: 'user', content: `Generate a research report on: ${topic}` },
  ];

  process.stdout.write(`\n${c.b}  Generating research report on "${topic}"…${c.reset}\r`);

  let raw;
  try {
    raw = await llmChat(researchMessages, { provider: PROVIDER });
  } catch (err) {
    readline.clearLine(process.stdout, 0);
    throw new Error(`LLM error: ${err.message}`);
  }
  readline.clearLine(process.stdout, 0);

  // Extract JSON — handle model wrapping output in ```json ... ```
  let jsonStr = raw.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();
  const braceStart = jsonStr.indexOf('{');
  const braceEnd   = jsonStr.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd !== -1) jsonStr = jsonStr.slice(braceStart, braceEnd + 1);

  let report;
  try {
    report = JSON.parse(jsonStr);
  } catch {
    // Fallback: wrap raw text in a valid structure
    report = {
      title: topic,
      category: 'other',
      tags: [topic.split(' ')[0].toLowerCase()],
      summary: raw.slice(0, 300),
      keyFindings: [raw.slice(0, 200)],
      dataPoints: [],
      methodology: 'LLM-generated',
      confidence: 'medium',
      generatedAt: new Date().toISOString(),
    };
  }

  return report;
}

// ── Research command ─────────────────────────────────────────────────────────

async function cmdResearch(topic) {
  if (!topic) { console.log(`${c.y}  Usage: research <topic>${c.reset}\n`); return; }

  log('STEP', `Starting research: "${topic}"`);

  let report;
  try {
    report = await generateResearchReport(topic);
  } catch (err) {
    log('FAIL', `Research generation failed: ${err.message}`);
    return;
  }

  const fileBuf    = Buffer.from(JSON.stringify(report, null, 2));
  const category   = report.category || 'other';
  const suggestedPrice = category === 'crypto' || category === 'defi' ? 15 : 10;

  log('PASS', `Report generated — "${report.title}"`);
  log('INFO', `Category   : ${category}  |  Tags: ${(report.tags || []).slice(0, 4).join(', ')}`);
  log('INFO', `Key findings: ${report.keyFindings?.length ?? 0}  |  Data points: ${report.dataPoints?.length ?? 0}`);
  log('INFO', `Size       : ${fileBuf.length} bytes`);

  // Post offer (existing deal machine)
  const offerRes = await api('POST', '/api/offers', {
    description: report.summary || topic,
    payloadType: 'research-report',
    priceUSDC: suggestedPrice,
    tokenOut: 'USDC',
    expectedSizeBytes: fileBuf.length,
  }, apiKey);

  if (!offerRes.ok) {
    log('FAIL', `Failed to post offer: ${JSON.stringify(offerRes.data)}`);
    return;
  }
  const { offerId } = offerRes.data;

  // Post listing (new capability registry)
  const listRes = await api('POST', '/api/listings', {
    category,
    tags: report.tags || [],
    title: report.title,
    description: report.summary || '',
    priceUSDC: suggestedPrice,
    offerId,
  }, apiKey);

  if (!listRes.ok) {
    log('FAIL', `Failed to post listing: ${JSON.stringify(listRes.data)}`);
    return;
  }
  const { listingId } = listRes.data;

  myListings.set(listingId, { title: report.title, priceUSDC: suggestedPrice, category, fileBuf, offerId });
  offerFiles.set(offerId, fileBuf);

  console.log('');
  log('PASS', '════════ LISTING PUBLISHED ════════════════════');
  log('PASS', `  Title     : ${report.title}`);
  log('PASS', `  ListingID : ${listingId}`);
  log('PASS', `  OfferID   : ${offerId}`);
  log('PASS', `  Price     : ${suggestedPrice} USDC`);
  log('PASS', `  Category  : ${category}`);
  log('PASS', '════════════════════════════════════════════════');
  console.log('');
}

// ── Webhook handler ──────────────────────────────────────────────────────────

async function handleWebhook(event) {
  const { event: type, dealId } = event;

  // ── Incoming deal offer ───────────────────────────────────────────────────
  if (type === 'DEAL_OFFER') {
    const { offerId } = event;
    // Re-key file so it's retrievable by dealId at UPLOADING time
    const buf = offerFiles.get(offerId);
    if (buf) dealFiles.set(dealId, buf);

    interrupt(
      `\n${c.bold}${c.m}  ════════════ INCOMING DEAL OFFER ════════════${c.reset}`,
      `  ${c.b}Deal ID  :${c.reset} ${dealId}`,
      `  ${c.b}Offer    :${c.reset} ${offerId}`,
      `  ${c.dim}Auto-accepting…${c.reset}`,
    );

    const { ok, data } = await api('POST', `/api/deals/${dealId}/accept`, {}, apiKey);
    if (ok) {
      interrupt(
        `  ${c.g}✓ Accepted — KeeperHub arbiter + janitor created${c.reset}`,
        `  ${c.g}✓ Status: ${data.status} — awaiting buyer escrow${c.reset}`,
        `  ${c.m}  ═════════════════════════════════════════════${c.reset}\n`,
      );
    } else {
      interrupt(`  ${c.r}✗ Accept failed: ${JSON.stringify(data)}${c.reset}`);
    }
  }

  // ── Negotiation proposal from buyer ──────────────────────────────────────
  if (type === 'NEGOTIATION_PROPOSAL') {
    const { negotiationId, listedPrice, proposedPrice, rounds } = event;
    const floor = listedPrice * STRATEGY.floorMultiplier;

    interrupt(
      `\n${c.bold}${c.y}  ════════════ NEGOTIATION PROPOSAL ════════════${c.reset}`,
      `  ${c.b}Negotiation :${c.reset} ${negotiationId?.slice(0, 8)}…`,
      `  ${c.b}Listed price:${c.reset} ${listedPrice} USDC`,
      `  ${c.b}Buyer offers:${c.reset} ${proposedPrice} USDC`,
      `  ${c.b}Floor price :${c.reset} ${floor.toFixed(2)} USDC`,
    );

    activeNegs.set(negotiationId, { listedPrice, rounds: rounds || 1 });

    if (proposedPrice >= listedPrice) {
      // Buyer paying full or over ask — accept immediately
      const { ok, data } = await api('POST', `/api/negotiations/${negotiationId}/accept`, {}, apiKey);
      interrupt(
        `  ${c.g}✓ Buyer is paying full price — accepted!${c.reset}`,
        ok ? `  ${c.g}✓ offerId: ${data.offerId}${c.reset}` : `  ${c.r}✗ Accept error: ${JSON.stringify(data)}${c.reset}`,
        `  ${c.y}  ═══════════════════════════════════════════════${c.reset}\n`,
      );
    } else if (proposedPrice >= floor) {
      // Above floor — accept
      const { ok, data } = await api('POST', `/api/negotiations/${negotiationId}/accept`, {}, apiKey);
      interrupt(
        `  ${c.g}✓ Above floor — accepting ${proposedPrice} USDC${c.reset}`,
        ok ? `  ${c.g}✓ offerId: ${data.offerId}${c.reset}` : `  ${c.r}✗ Accept error: ${JSON.stringify(data)}${c.reset}`,
        `  ${c.y}  ═══════════════════════════════════════════════${c.reset}\n`,
      );
    } else if ((rounds || 1) >= STRATEGY.maxRounds) {
      // Max rounds hit — reject
      await api('POST', `/api/negotiations/${negotiationId}/reject`, {}, apiKey);
      interrupt(
        `  ${c.r}✗ Below floor and max rounds reached — rejecting${c.reset}`,
        `  ${c.y}  ═══════════════════════════════════════════════${c.reset}\n`,
      );
    } else {
      // Counter with a concession
      const currentRound = rounds || 1;
      const counterPrice = +(listedPrice * (1 - STRATEGY.concessionPerRound * currentRound)).toFixed(2);
      const finalCounter = Math.max(counterPrice, floor);
      const { ok } = await api('POST', `/api/negotiations/${negotiationId}/counter`,
        { counterPrice: finalCounter, message: `Best I can do — ${finalCounter} USDC` }, apiKey);
      interrupt(
        `  ${c.y}⟳ Countering at ${finalCounter} USDC (round ${currentRound + 1})${c.reset}`,
        ok ? `  ${c.g}✓ Counter sent${c.reset}` : `  ${c.r}✗ Counter failed${c.reset}`,
        `  ${c.y}  ═══════════════════════════════════════════════${c.reset}\n`,
      );
    }
  }

  // ── Buyer locked funds — upload the file ─────────────────────────────────
  if (type === 'DEAL_STATUS_CHANGE' && event.status === 'UPLOADING') {
    const fileBuf = dealFiles.get(dealId) || Buffer.from(JSON.stringify({
      type: 'phantom-dataset',
      dealId,
      note: 'No research file found — fallback payload',
      generatedAt: new Date().toISOString(),
      rows: Array.from({ length: 50 }, (_, i) => ({ id: i, value: Math.random() })),
    }));

    interrupt(
      `\n${c.bold}${c.b}  ════════ FILE TRANSFER INITIATED ════════${c.reset}`,
      `  ${c.b}Deal${c.reset}     : ${dealId?.slice(0, 8)}…  — buyer funds confirmed locked`,
      `  ${c.b}Payload${c.reset}  : ${fileBuf.length} bytes`,
      `  ${c.b}Type${c.reset}     : research-report (JSON)`,
      `  ${c.b}Dest${c.reset}     : 0G Galileo decentralised storage`,
      `  ${c.dim}Uploading to storage network…${c.reset}`,
    );

    const uploadRes = await uploadFile(apiKey, dealId, fileBuf, `deal-${dealId}.json`);

    if (uploadRes.ok) {
      const rootHash  = uploadRes.data.rootHash;
      const txHashRaw = uploadRes.data.txHash;
      const txHashStr = typeof txHashRaw === 'string' ? txHashRaw : (txHashRaw?.hash ?? JSON.stringify(txHashRaw));
      interrupt(
        `  ${c.g}✓ Upload confirmed on 0G storage network${c.reset}`,
        `  ${c.g}✓ rootHash : ${rootHash}${c.reset}`,
        `  ${c.g}✓ txHash   : ${txHashStr?.slice(0, 30)}…${c.reset}`,
        `  ${c.b}  ════════ TRANSFER COMPLETE ════════════${c.reset}\n`,
      );
    } else {
      interrupt(`  ${c.y}⚠ 0G upload failed (${uploadRes.status}) — trying dev advance…${c.reset}`);
      const devRes = await api('POST', '/internal/dev/advance', { dealId });
      interrupt(devRes.ok
        ? `  ${c.g}✓ Dev advance: ${devRes.data.status}${c.reset}`
        : `  ${c.r}✗ Dev advance failed: ${JSON.stringify(devRes.data)}${c.reset}`);
    }
  }

  // ── ENS burning ───────────────────────────────────────────────────────────
  if (type === 'DEAL_STATUS_CHANGE' && event.status === 'BURNING') {
    interrupt(
      `\n  ${c.y}▶ ENS subnames burning for deal ${dealId?.slice(0, 8)}…${c.reset}`,
      `  ${c.dim}  buyer-${dealId?.slice(0, 8)}….phantom-protocol.eth  → 0xdEaD${c.reset}`,
      `  ${c.dim}  seller-${dealId?.slice(0, 8)}….phantom-protocol.eth → 0xdEaD${c.reset}`,
      `  ${c.dim}  deal-${dealId?.slice(0, 8)}….phantom-protocol.eth   → 0xdEaD${c.reset}`,
    );
  }

  // ── Deal complete ─────────────────────────────────────────────────────────
  if (type === 'DEAL_STATUS_CHANGE' && event.status === 'COMPLETE') {
    const deal = myListings.get(dealId); // may not exist
    interrupt(
      `\n${c.bold}${c.g}  ════════════════════════════════════════════`,
      `  DEAL COMPLETE  🎉`,
      `  ID      : ${dealId}`,
      `  Payout  : USDC released from PhantomVault`,
      `  Storage : rootHash verified on 0G Galileo`,
      `  Privacy : ENS subnames destroyed — access revoked`,
      `  ════════════════════════════════════════════${c.reset}\n`,
    );
  }
}

// ── Command dispatcher ───────────────────────────────────────────────────────

async function runCommand(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  const [cmd, ...rest] = trimmed.split(' ');
  const arg = rest.join(' ');

  switch (cmd.toLowerCase()) {
    case 'help': showHelp(); break;

    case 'research':
      await cmdResearch(arg);
      break;

    case 'list': {
      if (myListings.size === 0) {
        console.log(`\n  ${c.dim}No listings yet. Use 'research <topic>' to create one.${c.reset}\n`);
      } else {
        console.log(`\n${c.bold}  Your listings:${c.reset}`);
        for (const [id, l] of myListings) {
          console.log(`  ${c.b}${id.slice(0, 8)}…${c.reset}  ${l.title}  ${c.g}${l.priceUSDC} USDC${c.reset}  [${l.category}]`);
        }
        console.log('');
      }
      break;
    }

    case 'status': {
      const { ok, data } = await api('GET', '/api/deals', null, apiKey);
      // Backend doesn't have a GET all deals endpoint — use internal
      console.log(`\n  ${c.dim}(use the backend /internal/dev/deals endpoint for deal list)${c.reset}\n`);
      break;
    }

    case 'exit':
    case 'quit':
      console.log(`\n${c.dim}  Goodbye.${c.reset}\n`);
      process.exit(0);
      break;

    case 'chat':
      if (!arg) { console.log(`${c.y}  Usage: chat <message>${c.reset}\n`); break; }
      await chatWithHistory(arg);
      break;

    default:
      // Treat unknown input as a chat message
      await chatWithHistory(trimmed);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  banner();

  // Check LLM connectivity
  if (PROVIDER === 'ollama') {
    process.stdout.write(`  Checking Ollama (${OLLAMA_MODEL})… `);
    const ping = await pingOllama();
    if (ping.ok) {
      console.log(`${c.g}✓ connected${c.reset}`);
    } else {
      console.log(`${c.y}⚠ not reachable (${ping.error}) — chat will fail but deal flow works${c.reset}`);
    }
  }

  // Register agent
  process.stdout.write(`  Registering with coordinator… `);
  const axlPubkey        = randomAxlPubkey();
  const ephemeralAddress = randomEphemeralAddress();

  const regRes = await api('POST', '/api/agents/register', {
    axlPubkey,
    ephemeralAddress,
    role: 'seller',
    capabilities: ['research-report', 'dataset'],
    webhookUrl: WEBHOOK_URL,
  });

  if (!regRes.ok) {
    console.log(`${c.r}✗ Registration failed: ${JSON.stringify(regRes.data)}${c.reset}`);
    process.exit(1);
  }
  ({ agentId, apiKey } = regRes.data);
  console.log(`${c.g}✓ agentId: ${agentId.slice(0, 8)}…${c.reset}`);

  // Start webhook server
  const wh = express();
  wh.use(express.json());
  wh.post('/webhook', (req, res) => {
    res.sendStatus(200);
    handleWebhook(req.body).catch(err =>
      interrupt(`${c.r}  ✗ Webhook error: ${err.message}${c.reset}`));
  });
  await new Promise(resolve => wh.listen(WEBHOOK_PORT, resolve));
  console.log(`  Webhook server on port ${WEBHOOK_PORT}… ${c.g}✓${c.reset}`);

  console.log(`\n${c.dim}  Type 'help' for available commands.${c.reset}\n`);

  rl.setPrompt(PROMPT);
  rl.prompt();

  rl.on('line', async (line) => {
    rl.pause();
    try {
      await runCommand(line);
    } finally {
      rl.resume();
      rl.prompt();
    }
  });

  rl.on('close', () => {
    console.log(`\n${c.dim}  Session ended.${c.reset}\n`);
    process.exit(0);
  });
}

main().catch(err => {
  console.error(`${c.r}Fatal: ${err.message}${c.reset}`);
  process.exit(1);
});
