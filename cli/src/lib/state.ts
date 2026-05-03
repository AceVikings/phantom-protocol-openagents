/**
 * In-memory event queue + persistent session for the MCP mode.
 * Session (agentId, apiKey, role) persists to a file so MCP server survives restarts.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { join }    from 'node:path'
import { PHANTOM_DIR } from './config.js'

const SESSION_FILE = join(PHANTOM_DIR, 'session.json')

export interface Session {
  agentId:      string
  apiKey:       string
  role:         'buyer' | 'seller'
  webhookPort:  number
  backendUrl:   string
  displayName?: string
}

let _session: Session | null = null
let _currentIdentity = 'default'

export function getCurrentIdentity(): string {
  return _currentIdentity
}

export function setCurrentIdentity(id: string): void {
  if (id !== _currentIdentity) {
    _session = null           // force reload from identity-specific file
    _currentIdentity = id
  }
}

function sessionFile(): string {
  return _currentIdentity === 'default'
    ? SESSION_FILE
    : join(PHANTOM_DIR, `${_currentIdentity}-session.json`)
}

export function loadSession(): Session | null {
  if (_session) return _session
  const file = sessionFile()
  if (!existsSync(file)) return null
  try {
    _session = JSON.parse(readFileSync(file, 'utf8')) as Session
    return _session
  } catch { return null }
}

export function saveSession(s: Session): void {
  mkdirSync(PHANTOM_DIR, { recursive: true })
  writeFileSync(sessionFile(), JSON.stringify(s, null, 2), { mode: 0o600 })
  _session = s
}

export function clearSession(): void {
  _session = null
  try { if (existsSync(sessionFile())) unlinkSync(sessionFile()) } catch { /* ok */ }
}

export function getSession(): Session | null {
  return _session ?? loadSession()
}

// ── Payload buffers (in-memory + disk-persisted under ~/.phantom/payloads/) ───

const PAYLOADS_DIR = join(PHANTOM_DIR, 'payloads')

function payloadPath(id: string): string {
  return join(PAYLOADS_DIR, `${id}.bin`)
}

function writeToDisk(id: string, buf: Buffer): void {
  mkdirSync(PAYLOADS_DIR, { recursive: true })
  writeFileSync(payloadPath(id), buf, { mode: 0o600 })
}

function readFromDisk(id: string): Buffer | undefined {
  const p = payloadPath(id)
  if (!existsSync(p)) return undefined
  try { return readFileSync(p) } catch { return undefined }
}

function deleteFromDisk(id: string): void {
  try { if (existsSync(payloadPath(id))) unlinkSync(payloadPath(id)) } catch { /* ok */ }
}

const _offerPayloads = new Map<string, Buffer>()
const _dealPayloads  = new Map<string, Buffer>()

export function storeOfferPayload(offerId: string, buf: Buffer): void {
  _offerPayloads.set(offerId, buf)
  writeToDisk(offerId, buf)
}

export function getOfferPayload(offerId: string): Buffer | undefined {
  return _offerPayloads.get(offerId) ?? readFromDisk(offerId)
}

export function mapOfferPayloadToDeal(offerId: string, dealId: string): boolean {
  const buf = _offerPayloads.get(offerId) ?? readFromDisk(offerId)
  if (!buf) return false
  _dealPayloads.set(dealId, buf)
  writeToDisk(dealId, buf)
  return true
}

export function getDealPayload(dealId: string): Buffer | undefined {
  return _dealPayloads.get(dealId) ?? readFromDisk(dealId)
}

export function deleteDealPayload(dealId: string): void {
  _dealPayloads.delete(dealId)
  deleteFromDisk(dealId)
}

// ── Notification queue ────────────────────────────────────────────────────────

interface QueuedNotification {
  ts:    number
  event: Record<string, unknown>
}

const _queue: QueuedNotification[] = []

export function queueNotification(event: Record<string, unknown>): void {
  _queue.push({ ts: Date.now(), event })
}

export function drainNotifications(): QueuedNotification[] {
  return _queue.splice(0)
}
