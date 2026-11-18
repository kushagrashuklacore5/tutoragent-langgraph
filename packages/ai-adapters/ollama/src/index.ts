import {
  GatewayError, ensureOk, joinUrl, timed,
  type Capabilities, type DiscoveredModel, type EmbedRequest, type EmbedResult, type FinishReason, type GenerateRequest,
  type GenerateResult, type Message, type Operation, type ProviderAdapter, type ResolvedConnection, type StreamEvent, type ToolCall, type Usage,
} from '@platform/ai-adapter-kit'

/**
 * Ollama native API adapter (local or self-hosted). Host URL is configurable per connection;
 * models are discovered from the server. The adapter never pulls models (that is an ops action).
 */

const authHeaders = (conn: ResolvedConnection): Record<string, string> => (conn.apiKey ? { authorization: `Bearer ${conn.apiKey}` } : {})

export function toOllamaMessages(messages: Message[]): unknown[] {
  return messages.map((m) => {
    switch (m.role) {
      case 'system':
        return { role: 'system', content: m.content }
      case 'user':
        if (typeof m.content === 'string') return { role: 'user', content: m.content }
        return {
          role: 'user',
          content: m.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n'),
          images: m.content.filter((p) => p.type === 'image').map((p) => (p as { dataBase64: string }).dataBase64),
        }
      case 'assistant':
        return { role: 'assistant', content: m.content, ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })) } : {}) }
      case 'tool':
        return { role: 'tool', content: m.content, tool_name: m.name }
    }
  })
}

export function buildBody(model: string, req: GenerateRequest, stream: boolean): Record<string, unknown> {
  const options: Record<string, unknown> = { num_predict: req.maxOutputTokens }
  if (req.temperature !== undefined) options.temperature = req.temperature
  if (req.stop?.length) options.stop = req.stop
  if (req.seed !== undefined) options.seed = req.seed
  const body: Record<string, unknown> = { model, messages: toOllamaMessages(req.messages), stream, options }
  if (req.responseFormat?.type === 'json') body.format = req.responseFormat.mode === 'json_schema' ? req.responseFormat.schema : 'json'
  if (req.tools?.length) {
    if (req.toolChoice && typeof req.toolChoice !== 'string') throw new GatewayError('unsupported_capability', 'Ollama: forcing a specific tool is not supported')
    if (req.toolChoice === 'required') throw new GatewayError('unsupported_capability', 'Ollama: required tool choice is not supported')
    if (req.toolChoice !== 'none') body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
  }
  if (req.reasoning) body.think = thinkValue(model, req.reasoning)
  return body
}

/**
 * Ollama's `think` takes graded levels ("low" | "medium" | "high") only for gpt-oss models; every other
 * thinking model (qwen3, deepseek-r1, …) takes a boolean and treats any string as "think". Sending "low"
 * to qwen3 made it reason at length and exhaust the output budget before the answer (truncated JSON).
 * For boolean models: off/low → no thinking, medium/high → thinking.
 */
export function thinkValue(model: string, reasoning: 'off' | 'low' | 'medium' | 'high'): boolean | string {
  if (reasoning === 'off') return false
  if (/^gpt-oss(:|$)/i.test(model)) return reasoning
  return reasoning !== 'low'
}

/** Some thinking models inline their reasoning in <think> tags; never surface it as answer text. */
const stripThink = (s: string) => s.replace(/<think>[\s\S]*?<\/think>\s*/g, '')

const mapFinish = (r: string | undefined, hasTools: boolean): FinishReason => (hasTools ? 'tool_calls' : r === 'length' ? 'length' : 'stop')
const usageOf = (j: { prompt_eval_count?: number; eval_count?: number }): Usage => ({ inputTokens: j.prompt_eval_count ?? null, outputTokens: j.eval_count ?? null, cachedInputTokens: null, reasoningTokens: null })

let seq = 0
type OMsg = { content?: string; thinking?: string; tool_calls?: { function: { name: string; arguments: Record<string, unknown> | string } }[] }
function calls(m: OMsg | undefined): ToolCall[] {
  return (m?.tool_calls ?? []).map((c) => {
    let args = c.function.arguments
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args) as Record<string, unknown>
      } catch {
        throw new GatewayError('invalid_output', 'Ollama: tool arguments were not valid JSON')
      }
    }
    return { id: `call_${++seq}`, name: c.function.name, arguments: args as Record<string, unknown> }
  })
}

async function generate(conn: ResolvedConnection, model: string, req: GenerateRequest, signal?: AbortSignal): Promise<GenerateResult> {
  const res = await conn.http.request({ method: 'POST', url: joinUrl(conn.baseUrl, 'api/chat'), headers: authHeaders(conn), body: buildBody(model, req, false), signal, timeoutMs: conn.timeoutMs })
  await ensureOk(res, 'Ollama')
  const j = await res.json<{ message?: OMsg; done_reason?: string; prompt_eval_count?: number; eval_count?: number; error?: string }>()
  if (j.error) throw new GatewayError('provider_error', `Ollama: ${j.error}`)
  const toolCalls = calls(j.message)
  return { text: stripThink(j.message?.content ?? ''), toolCalls, finish: mapFinish(j.done_reason, toolCalls.length > 0), usage: usageOf(j) }
}

async function* stream(conn: ResolvedConnection, model: string, req: GenerateRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
  const res = await conn.http.request({ method: 'POST', url: joinUrl(conn.baseUrl, 'api/chat'), headers: authHeaders(conn), body: buildBody(model, req, true), signal, timeoutMs: conn.timeoutMs })
  await ensureOk(res, 'Ollama')
  yield { t: 'start' }
  const toolCalls: ToolCall[] = []
  let inThink = false
  let finish: FinishReason = 'stop'
  for await (const line of res.lines()) {
    if (!line.trim()) continue
    let j: { message?: OMsg; done?: boolean; done_reason?: string; prompt_eval_count?: number; eval_count?: number; error?: string }
    try {
      j = JSON.parse(line)
    } catch {
      continue
    }
    if (j.error) throw new GatewayError('provider_error', `Ollama: ${j.error}`)
    let piece = j.message?.content ?? ''
    // drop inline <think> sections that may span chunks
    if (piece.includes('<think>')) inThink = true
    if (inThink) {
      if (piece.includes('</think>')) {
        piece = piece.slice(piece.indexOf('</think>') + 8).replace(/^\s+/, '')
        inThink = false
      } else piece = ''
    }
    if (piece) yield { t: 'text', delta: piece }
    toolCalls.push(...calls(j.message))
    if (j.done) {
      finish = mapFinish(j.done_reason, toolCalls.length > 0)
      for (const c of toolCalls) yield { t: 'tool_call', call: c }
      yield { t: 'usage', usage: usageOf(j) }
    }
  }
  yield { t: 'finish', finish }
}

export const EMBED_CONTEXT = 2048

async function embed(conn: ResolvedConnection, model: string, req: EmbedRequest, signal?: AbortSignal): Promise<EmbedResult> {
  // Bounded context for embeddings: chunks are short (≤ ~700 tokens), and without num_ctx Ollama loads the model with
  // its full default window, which needs a large buffer (live: 470 MB allocation failures on an 8 GB machine).
  const body: Record<string, unknown> = { model, input: req.inputs, truncate: true, options: { num_ctx: EMBED_CONTEXT } }
  if (req.dimensions) body.dimensions = req.dimensions
  const res = await conn.http.request({ method: 'POST', url: joinUrl(conn.baseUrl, 'api/embed'), headers: authHeaders(conn), body, signal, timeoutMs: conn.timeoutMs })
  await ensureOk(res, 'Ollama')
  const j = await res.json<{ embeddings?: number[][]; prompt_eval_count?: number }>()
  const vectors = j.embeddings ?? []
  if (vectors.length !== req.inputs.length) throw new GatewayError('provider_error', `Ollama: expected ${req.inputs.length} embeddings, got ${vectors.length}`)
  return { vectors, dimensions: vectors[0]?.length ?? 0, usage: { inputTokens: j.prompt_eval_count ?? null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null } }
}

async function listModels(conn: ResolvedConnection): Promise<DiscoveredModel[]> {
  const res = await conn.http.request({ method: 'GET', url: joinUrl(conn.baseUrl, 'api/tags'), headers: authHeaders(conn), timeoutMs: conn.timeoutMs })
  await ensureOk(res, 'Ollama')
  const j = await res.json<{ models?: { name: string; details?: { context_length?: number; family?: string }; capabilities?: string[] }[] }>()
  return (j.models ?? []).map((m) => {
    const caps = m.capabilities ?? []
    const ops: Operation[] = []
    if (caps.includes('completion')) ops.push('generate', 'stream')
    if (caps.includes('embedding')) ops.push('embed')
    const hint: Partial<Capabilities> = {
      tools: caps.includes('tools') ? 'single' : 'none',
      reasoningControl: caps.includes('thinking'),
      vision: caps.includes('vision'),
      contextWindow: m.details?.context_length ?? null,
    }
    return { id: m.name, displayName: m.name, contextWindow: m.details?.context_length, operationsHint: ops, capabilitiesHint: hint }
  })
}

export const adapter: ProviderAdapter = {
  descriptor: {
    type: 'ollama',
    version: '1.0.0',
    displayName: 'Ollama',
    operations: ['generate', 'stream', 'embed'],
    defaultBaseUrl: 'http://127.0.0.1:11434',
    requiresApiKey: false,
    supportsDiscovery: true,
    supportsPrivateNetwork: true,
  },
  async testConnection(conn) {
    const r = await timed(() => listModels(conn))
    if (r.error) return { ok: false, latencyMs: r.ms, error: { kind: (r.error as GatewayError).kind ?? 'network', message: (r.error as Error).message } }
    return { ok: true, latencyMs: r.ms, modelCount: r.value?.length }
  },
  listModels,
  generate,
  stream,
  embed,
}
export default adapter
