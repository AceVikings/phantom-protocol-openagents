/** LLM abstraction — Ollama (gemma4:latest default) or OpenAI. */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ChatOptions {
  provider?: 'ollama' | 'openai'
  ollamaHost?: string
  ollamaModel?: string
  openaiKey?: string
  openaiModel?: string
  onToken?: (token: string) => void
}

export async function chat(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  const {
    provider    = 'ollama',
    ollamaHost  = process.env.OLLAMA_HOST  ?? 'http://localhost:11434',
    ollamaModel = process.env.OLLAMA_MODEL ?? 'gemma4:latest',
    openaiKey   = process.env.OPENAI_API_KEY ?? '',
    openaiModel = process.env.OPENAI_MODEL  ?? 'gpt-4o-mini',
    onToken,
  } = opts

  if (provider === 'openai') {
    if (!openaiKey) throw new Error('OPENAI_API_KEY is not set')
    const { default: OpenAI } = await import('openai')
    const client = new OpenAI({ apiKey: openaiKey })

    if (onToken) {
      const stream = await client.chat.completions.create({
        model: openaiModel, messages, stream: true,
      })
      let full = ''
      for await (const chunk of stream) {
        const tok = chunk.choices[0]?.delta?.content ?? ''
        if (tok) { onToken(tok); full += tok }
      }
      return full
    }

    const res = await client.chat.completions.create({ model: openaiModel, messages })
    return res.choices[0]!.message.content ?? ''
  }

  // ── Ollama (streaming) ──────────────────────────────────────────────────
  const res = await fetch(`${ollamaHost}/api/chat`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model: ollamaModel, messages, stream: true }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Ollama ${res.status}: ${text.slice(0, 200)}`)
  }
  if (!res.body) throw new Error('Ollama returned empty body')

  const reader  = res.body.getReader()
  const decoder = new TextDecoder()
  let full = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value, { stream: true })
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue
      try {
        const obj = JSON.parse(line)
        const tok = obj?.message?.content ?? ''
        if (tok) { if (onToken) onToken(tok); full += tok }
      } catch { /* partial line */ }
    }
  }
  return full
}

export async function pingOllama(
  host = process.env.OLLAMA_HOST ?? 'http://localhost:11434',
  model = process.env.OLLAMA_MODEL ?? 'gemma4:latest',
): Promise<{ ok: boolean; models: string[]; error?: string }> {
  try {
    const res = await fetch(`${host}/api/tags`)
    if (!res.ok) return { ok: false, models: [], error: `HTTP ${res.status}` }
    const json = (await res.json()) as { models?: Array<{ name: string }> }
    const models = (json.models ?? []).map((m) => m.name)
    const hasModel = models.some((m) => m.startsWith(model.split(':')[0]!))
    if (!hasModel) {
      return { ok: false, models, error: `model '${model}' not found — run: ollama pull ${model}` }
    }
    return { ok: true, models }
  } catch (err: unknown) {
    return { ok: false, models: [], error: (err as Error).message }
  }
}
