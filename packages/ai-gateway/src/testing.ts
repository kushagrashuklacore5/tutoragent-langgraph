import {
  GatewayError, type EmbedRequest, type GenerateRequest, type GenerateResult, type GatewayErrorKind, type ProviderAdapter, type StreamEvent,
} from '@platform/ai-adapter-kit'

/**
 * Deterministic fake adapter for module and gateway tests. Business-logic tests use this, so they
 * are provider-independent by construction (AI_GATEWAY.md § 13.3).
 */
export interface FakeBehaviour {
  /** produce the result for a request; default echoes / returns schema-shaped JSON */
  respond?: (req: GenerateRequest, model: string) => GenerateResult | Promise<GenerateResult>
  /** fail with this error kind (per model id) */
  failModels?: Record<string, GatewayErrorKind>
  embedDimensions?: number
  /** speech-to-text result (default: a fixed transcript naming the byte count) */
  transcribe?: (audio: Buffer, language?: string) => string
  /** custom embedding function (e.g. a hashing embedder for retrieval tests) */
  embed?: (text: string, dims: number) => number[]
}

export function createFakeAdapter(type = 'fake', behaviour: FakeBehaviour = {}): ProviderAdapter & { calls: { model: string; req: GenerateRequest | EmbedRequest }[] } {
  const calls: { model: string; req: GenerateRequest | EmbedRequest }[] = []
  const respond = async (req: GenerateRequest, model: string): Promise<GenerateResult> => {
    const fail = behaviour.failModels?.[model]
    if (fail) throw new GatewayError(fail, `fake ${fail}`)
    if (behaviour.respond) return behaviour.respond(req, model)
    if (req.responseFormat?.type === 'json') return { text: JSON.stringify({ answer: 'ok', n: 1 }), toolCalls: [], finish: 'stop', usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: null, reasoningTokens: null } }
    const last = [...req.messages].reverse().find((m) => m.role === 'user')
    const text = `fake(${model}): ${typeof last?.content === 'string' ? last.content : ''}`
    return { text, toolCalls: [], finish: 'stop', usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: null, reasoningTokens: null } }
  }
  return {
    calls,
    descriptor: { type, version: '0.0.0', displayName: `Fake (${type})`, operations: ['generate', 'stream', 'embed', 'transcribe'], requiresApiKey: false, supportsDiscovery: true, supportsPrivateNetwork: true },
    async testConnection() {
      return { ok: true, latencyMs: 0, modelCount: 2 }
    },
    async listModels() {
      return [{ id: 'fake-chat', operationsHint: ['generate', 'stream'] }, { id: 'fake-embed', operationsHint: ['embed'] }]
    },
    async generate(_c, model, req) {
      calls.push({ model, req })
      return respond(req, model)
    },
    async *stream(_c, model, req): AsyncIterable<StreamEvent> {
      calls.push({ model, req })
      const r = await respond(req, model)
      yield { t: 'start' }
      for (const piece of r.text.match(/.{1,5}/gsu) ?? []) yield { t: 'text', delta: piece }
      for (const c of r.toolCalls) yield { t: 'tool_call', call: c }
      yield { t: 'usage', usage: r.usage }
      yield { t: 'finish', finish: r.finish }
    },
    async transcribe(_c, model, req) {
      calls.push({ model, req: { inputs: [`audio:${req.audio.length}`], purpose: 'document' } })
      const fail = behaviour.failModels?.[model]
      if (fail) throw new GatewayError(fail, `fake ${fail}`)
      return { text: behaviour.transcribe ? behaviour.transcribe(req.audio, req.language) : `fake transcript (${req.audio.length} bytes)`, language: req.language ?? 'en', durationSec: 1, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: null, reasoningTokens: null } }
    },
    async embed(_c, model, req) {
      calls.push({ model, req })
      const fail = behaviour.failModels?.[model]
      if (fail) throw new GatewayError(fail, `fake ${fail}`)
      const d = req.dimensions ?? behaviour.embedDimensions ?? 4
      const fn = behaviour.embed ?? ((t: string, n: number) => Array.from({ length: n }, (_, i) => ((t.length + i) % 7) / 7))
      return { vectors: req.inputs.map((t) => fn(t, d)), dimensions: d, usage: { inputTokens: req.inputs.length, outputTokens: null, cachedInputTokens: null, reasoningTokens: null } }
    },
  }
}
