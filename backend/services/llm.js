/**
 * LLM abstraction — Ollama (default) or OpenAI fallback.
 *
 * Usage:
 *   import { chat } from '../services/llm.js';
 *   const reply = await chat(messages, { provider: 'ollama' });
 *
 * Environment:
 *   OLLAMA_HOST   — default http://localhost:11434
 *   OLLAMA_MODEL  — default gemma4:latest
 *   OPENAI_API_KEY — required for openai provider
 *   OPENAI_MODEL  — default gpt-4o-mini
 */

import OpenAI from 'openai';

export const OLLAMA_HOST  = process.env.OLLAMA_HOST  || 'http://localhost:11434';
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma4:latest';
export const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

/**
 * Send a messages array to the configured LLM.
 * @param {Array<{role:string,content:string}>} messages
 * @param {object} opts
 * @param {'ollama'|'openai'} opts.provider
 * @param {function(string):void} [opts.onToken]  — streaming token callback
 * @returns {Promise<string>}  full assistant reply
 */
export async function chat(messages, { provider = 'ollama', onToken } = {}) {
  if (provider === 'openai') {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    if (onToken) {
      const stream = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        messages,
        stream: true,
      });
      let full = '';
      for await (const chunk of stream) {
        const token = chunk.choices[0]?.delta?.content ?? '';
        if (token) { onToken(token); full += token; }
      }
      return full;
    }

    const res = await openai.chat.completions.create({ model: OPENAI_MODEL, messages });
    return res.choices[0].message.content;
  }

  // ── Ollama via REST (no npm dep — uses built-in fetch) ───────────────────
  if (onToken) {
    const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, messages, stream: true }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text().then(t => t.slice(0, 200))}`);

    let full = '';
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      for (const line of decoder.decode(chunk).split('\n').filter(Boolean)) {
        try {
          const obj = JSON.parse(line);
          const token = obj.message?.content ?? '';
          if (token) { onToken(token); full += token; }
        } catch { /* ignore partial JSON */ }
      }
    }
    return full;
  }

  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, messages, stream: false }),
  });
  if (!res.ok) {
    throw new Error(`Ollama ${res.status}: ${await res.text().then(t => t.slice(0, 300))}`);
  }
  const data = await res.json();
  return data.message?.content ?? '';
}

/**
 * Convenience: ping Ollama to check if it's reachable.
 * Returns { ok: true, models: [...] } or { ok: false, error: string }
 */
export async function pingOllama() {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, models: (data.models ?? []).map(m => m.name) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
