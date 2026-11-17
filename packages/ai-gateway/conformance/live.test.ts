/**
 * Live and local modes.
 *  - local: Ollama on OLLAMA_HOST (default http://127.0.0.1:11434) with OLLAMA_CHAT_MODEL / OLLAMA_EMBED_MODEL.
 *    Skipped when the server or models are not available.
 *  - live: hosted providers, only when their keys and model ids are supplied via env
 *    (e.g. CONFORMANCE_OPENAI_KEY + CONFORMANCE_OPENAI_MODEL). Spend is limited by small prompts.
 * Model ids are never hard-coded here: they come from the environment (verified ids only).
 */
import { describe } from 'node:test'
import { NO_CAPABILITIES } from '@platform/ai-adapter-kit'
import { ADAPTERS } from '../src/adapters.generated.ts'
import { defineConformanceSuite } from './suite.ts'

const host = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'
const chat = process.env.OLLAMA_CHAT_MODEL ?? 'qwen3:1.7b'
const embed = process.env.OLLAMA_EMBED_MODEL ?? 'qwen3-embedding:0.6b'

async function ollamaHas(models: string[]): Promise<boolean> {
  try {
    const r = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(2000) })
    const j = (await r.json()) as { models?: { name: string }[] }
    const names = new Set((j.models ?? []).map((m) => m.name))
    return models.every((m) => names.has(m))
  } catch {
    return false
  }
}

const ollamaReady = await ollamaHas([chat, embed])
describe('conformance: ollama/local', { skip: !ollamaReady && `Ollama with ${chat} and ${embed} not available at ${host}` }, () => {
  defineConformanceSuite({
    name: 'ollama',
    adapter: ADAPTERS.ollama!,
    mode: 'local',
    baseUrl: host,
    chatModel: chat,
    embedModel: embed,
    declared: { ...NO_CAPABILITIES, operations: ['generate', 'stream', 'embed'], structuredOutput: 'json_schema', tools: 'single', forcedToolChoice: false },
    baseRequest: { reasoning: 'off' },
    timeoutMs: 120_000,
  })
})

const HOSTED = [
  { type: 'openai', env: 'OPENAI' },
  { type: 'anthropic', env: 'ANTHROPIC' },
  { type: 'google-gemini', env: 'GEMINI' },
  { type: 'groq', env: 'GROQ' },
  { type: 'openai-compatible', env: 'OPENAI_COMPATIBLE' },
] as const

for (const h of HOSTED) {
  const key = process.env[`CONFORMANCE_${h.env}_KEY`]
  const model = process.env[`CONFORMANCE_${h.env}_MODEL`]
  const base = process.env[`CONFORMANCE_${h.env}_BASE_URL`] ?? ADAPTERS[h.type]!.descriptor.defaultBaseUrl
  describe(`conformance: ${h.type}/live`, { skip: !(model && base && (key || h.type === 'openai-compatible')) && `set CONFORMANCE_${h.env}_KEY and CONFORMANCE_${h.env}_MODEL to run` }, () => {
    defineConformanceSuite({
      name: h.type,
      adapter: ADAPTERS[h.type]!,
      mode: 'live',
      baseUrl: base!,
      apiKey: key,
      chatModel: model!,
      embedModel: process.env[`CONFORMANCE_${h.env}_EMBED_MODEL`],
      declared: { ...NO_CAPABILITIES, operations: ADAPTERS[h.type]!.descriptor.operations, structuredOutput: (process.env[`CONFORMANCE_${h.env}_STRUCTURED`] as 'json_mode') ?? 'json_mode', tools: 'single', forcedToolChoice: true },
      timeoutMs: 60_000,
    })
  })
}
