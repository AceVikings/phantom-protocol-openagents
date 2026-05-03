/** HTTP client for the Phantom Protocol backend. */

export async function api(
  method: string,
  path: string,
  body?: unknown,
  apiKey?: string | null,
  baseUrl = 'http://localhost:3001',
): Promise<{ ok: boolean; data: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    return { ok: res.ok, data }
  } catch (err: unknown) {
    return { ok: false, data: { error: (err as Error).message } }
  }
}
