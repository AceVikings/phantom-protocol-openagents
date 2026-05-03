/**
 * AXL identity management — Ed25519 keypairs stored in ~/.phantom/agents/.
 *
 * Each agent gets a unique Ed25519 identity used for anonymity-layer routing.
 * Node.js 20+ built-in crypto is used — no extra dependencies.
 */
import { generateKeyPairSync }                                from 'node:crypto'
import { existsSync, mkdirSync, readdirSync,
         readFileSync, unlinkSync, writeFileSync }            from 'node:fs'
import { join }                                               from 'node:path'
import { PHANTOM_DIR }                                        from './config.js'

export const AGENTS_DIR = join(PHANTOM_DIR, 'agents')

export interface AxlIdentity {
  pubkey:  string  // 64-char hex (32 bytes raw Ed25519 public key)
  privkey: string  // 64-char hex (32 bytes raw Ed25519 private key seed)
}

export interface AgentRecord {
  agentId:     string
  apiKey:      string
  role:        'buyer' | 'seller'
  axlPubkey:   string
  axlPrivkey:  string
  wallet: {
    address:    string
    privateKey: string
  }
  backendUrl:  string
  webhookPort: number
  createdAt:   string
}

// ── Keypair generation ────────────────────────────────────────────────────────

/**
 * Generate a fresh Ed25519 keypair.
 * Returns raw 32-byte key material as hex strings.
 */
export function generateAxlKeypair(): AxlIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')

  // DER-encoded SPKI: last 32 bytes = raw public key
  const pubDer = publicKey.export({ format: 'der', type: 'spki' })
  const pubHex = Buffer.from(pubDer).subarray(-32).toString('hex')

  // DER-encoded PKCS#8: last 32 bytes = raw seed
  const privDer = privateKey.export({ format: 'der', type: 'pkcs8' })
  const privHex = Buffer.from(privDer).subarray(-32).toString('hex')

  return { pubkey: pubHex, privkey: privHex }
}

// ── Agent registry CRUD ───────────────────────────────────────────────────────

function agentPath(agentId: string): string {
  return join(AGENTS_DIR, `${agentId}.json`)
}

export function saveAgent(rec: AgentRecord): void {
  mkdirSync(AGENTS_DIR, { recursive: true })
  writeFileSync(agentPath(rec.agentId), JSON.stringify(rec, null, 2), { mode: 0o600 })
}

export function loadAgent(agentId: string): AgentRecord | null {
  const p = agentPath(agentId)
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8')) as AgentRecord }
  catch { return null }
}

export function listAgents(): AgentRecord[] {
  if (!existsSync(AGENTS_DIR)) return []
  return readdirSync(AGENTS_DIR)
    .filter(f => f.endsWith('.json'))
    .flatMap(f => {
      try { return [JSON.parse(readFileSync(join(AGENTS_DIR, f), 'utf8')) as AgentRecord] }
      catch { return [] }
    })
}

export function removeAgent(agentId: string): boolean {
  const p = agentPath(agentId)
  if (!existsSync(p)) return false
  unlinkSync(p)
  return true
}

// ── Default agent ─────────────────────────────────────────────────────────────

const DEFAULT_AGENT_FILE = join(PHANTOM_DIR, 'default-agent')

export function setDefaultAgent(agentId: string): void {
  mkdirSync(PHANTOM_DIR, { recursive: true })
  writeFileSync(DEFAULT_AGENT_FILE, agentId, { mode: 0o600 })
}

export function getDefaultAgent(): string | null {
  if (!existsSync(DEFAULT_AGENT_FILE)) return null
  try { return readFileSync(DEFAULT_AGENT_FILE, 'utf8').trim() }
  catch { return null }
}

export function resolveAgent(agentId?: string): AgentRecord | null {
  const id = agentId ?? getDefaultAgent()
  if (!id) return null
  return loadAgent(id)
}
