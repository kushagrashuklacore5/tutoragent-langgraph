import {
  GatewayError, ensureOk, joinUrl, sseData, timed,
  type ContentPart, type DiscoveredModel, type FinishReason, type GenerateRequest, type GenerateResult,
  type Message, type ProviderAdapter, type ResolvedConnection, type StreamEvent, type ToolCall, type Usage,
} from '@platform/ai-adapter-kit'

/**
 * Anthropic Messages API adapter.
 * Structured output is implemented with a forced tool whose input schema is the requested schema;
 * the gateway still validates the JSON (declared as `json_mode` until verified otherwise).
 */
const VERSION_HEADER = '2023-06-01'
const FORMAT_TOOL_PREFIX = 'emit_'

type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }

function headers(conn: ResolvedConnection): Record<string, string> {
  if (!conn.apiKey) throw new GatewayError('auth', 'Anthropic: no API key configured')
  return { 'x-api-key': conn.apiKey, 'anthropic-version': VERSION_HEADER }
}

const userBlocks = (c: string | ContentPart[]): Block[] =>
  typeof c === 'string'
    ? [{ type: 'text', text: c }]
    : c.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.dataBase64 } }))

/** Convert neutral messages; merges consecutive same-role turns (the API requires alternation). */
export function toAnthropic(messages: Message[]): { system?: string; messages: { role: 'user' | 'assistant'; content: Block[] }[] } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content as string).join('\n\n')
  const out: { role: 'user' | 'assistant'; content: Block[] }[] = []
  for (const m of messages) {
    let role: 'user' | 'assistant'
    let blocks: Block[]
    if (m.role === 'system') continue
    if (m.role === 'user') {
      role = 'user'
      blocks = userBlocks(m.content)
    } else if (m.role === 'assistant') {
      role = 'assistant'
      blocks = [...(m.content ? [{ type: 'text' as const, text: m.content }] : []), ...(m.toolCalls ?? []).map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: c.arguments }))]
    } else {
      role = 'user'
      blocks = [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }]
    }
    const last = out[out.length - 1]
    if (last && last.role === role) last.content.push(...blocks)
    else out.push({ role, content: blocks })
  }
  return { system: system || undefined, messages: out }
}

const formatToolName = (name: string) => FORMAT_TOOL_PREFIX + name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 58)

export function buildBody(model: string, req: GenerateRequest, stream: boolean): Record<string, unknown> {
  const { system, messages } = toAnthropic(req.messages)
  const body: Record<string, unknown> = { model, max_tokens: req.maxOutputTokens, messages }
  if (system) body.system = system
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.stop?.length) body.stop_sequences = req.stop
  if (req.responseFormat?.type === 'json') {
    if (req.tools?.length) throw new GatewayError('unsupported_capability', 'Anthropic adapter: structured output cannot be combined with tools in one request')
    const name = formatToolName(req.responseFormat.name)
    body.tools = [{ name, description: 'Return the final result in this exact structure.', input_schema: req.responseFormat.schema }]
    body.tool_choice = { type: 'tool', name }
  } else if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
    const tc = req.toolChoice
    if (tc) body.tool_choice = tc === 'auto' ? { type: 'auto' } : tc === 'none' ? { type: 'none' } : tc === 'required' ? { type: 'any' } : { type: 'tool', name: tc.tool }
  }
  if (req.reasoning && req.reasoning !== 'off' && !body.tool_choice) {
    const budget = Math.min({ low: 1024, medium: 4096, high: 16000 }[req.reasoning], req.maxOutputTokens - 1)
    if (budget >= 1024) {
      body.thinking = { type: 'enabled', budget_tokens: budget }
      delete body.temperature // not compatible with extended thinking
    }
  }
  if (stream) body.stream = true
  return body
}

interface AUsage { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number }
const mapUsage = (u: AUsage | undefined): Usage => ({ inputTokens: u?.input_tokens ?? null, outputTokens: u?.output_tokens ?? null, cachedInputTokens: u?.cache_read_input_tokens ?? null, reasoningTokens: null })

function mapStop(s: string | null | undefined): FinishReason {
  switch (s) {
    case 'end_turn': case 'stop_sequence': case 'pause_turn': return 'stop'
    case 'max_tokens': return 'length'
    case 'tool_use': return 'tool_calls'
    case 'refusal': return 'content_filter'
    default: return s ? 'stop' : 'error'
  }
}

async function generate(conn: ResolvedConnection, model: string, req: GenerateRequest, signal?: AbortSignal): Promise<GenerateResult> {
  const res = await conn.http.request({ method: 'POST', url: joinUrl(conn.baseUrl, 'v1/messages'), headers: headers(conn), body: buildBody(model, req, false), signal, timeoutMs: conn.timeoutMs })
  await ensureOk(res, 'Anthropic')
  const j = await res.json<{ content?: Block[]; stop_reason?: string; usage?: AUsage }>()
  const blocks = j.content ?? []
  const structured = req.responseFormat?.type === 'json'
  let text = blocks.filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('')
  let toolCalls: ToolCall[] = blocks.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, arguments: b.input ?? {} }))
  let finish = mapStop(j.stop_reason)
  if (structured) {
    const fmt = toolCalls.find((c) => c.name.startsWith(FORMAT_TOOL_PREFIX))
    if (fmt) {
      text = JSON.stringify(fmt.arguments)
      toolCalls = []
      if (finish === 'tool_calls') finish = 'stop'
    }
  }
  return { text, toolCalls, finish, usage: mapUsage(j.usage) }
}

async function* stream(conn: ResolvedConnection, model: string, req: GenerateRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
  const res = await conn.http.request({ method: 'POST', url: joinUrl(conn.baseUrl, 'v1/messages'), headers: { ...headers(conn), accept: 'text/event-stream' }, body: buildBody(model, req, true), signal, timeoutMs: conn.timeoutMs })
  await ensureOk(res, 'Anthropic')
  yield { t: 'start' }
  const structured = req.responseFormat?.type === 'json'
  const tools = new Map<number, { id: string; name: string; json: string }>()
  let usage: Usage = { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null }
  let finish: FinishReason = 'stop'
  for await (const ev of sseData(res.lines())) {
    let d: Record<string, any>
    try {
      d = JSON.parse(ev.data)
    } catch {
      continue
    }
    switch (d.type) {
      case 'message_start':
        usage = { ...usage, ...mapUsage(d.message?.usage), outputTokens: null }
        break
      case 'content_block_start':
        if (d.content_block?.type === 'tool_use') tools.set(d.index, { id: d.content_block.id, name: d.content_block.name, json: '' })
        break
      case 'content_block_delta':
        if (d.delta?.type === 'text_delta' && d.delta.text) yield { t: 'text', delta: d.delta.text }
        else if (d.delta?.type === 'input_json_delta') {
          const tb = tools.get(d.index)
          if (tb) {
            tb.json += d.delta.partial_json ?? ''
            if (structured && tb.name.startsWith(FORMAT_TOOL_PREFIX) && d.delta.partial_json) yield { t: 'text', delta: d.delta.partial_json }
          }
        }
        break
      case 'message_delta':
        if (d.delta?.stop_reason) finish = mapStop(d.delta.stop_reason)
        if (d.usage?.output_tokens !== undefined) usage = { ...usage, outputTokens: d.usage.output_tokens }
        break
      case 'error':
        throw new GatewayError(d.error?.type === 'overloaded_error' ? 'overloaded' : 'provider_error', `Anthropic stream error: ${d.error?.message ?? 'unknown'}`)
    }
  }
  for (const [, tb] of [...tools.entries()].sort((a, b) => a[0] - b[0])) {
    if (structured && tb.name.startsWith(FORMAT_TOOL_PREFIX)) continue
    let args: Record<string, unknown> = {}
    try {
      args = tb.json ? JSON.parse(tb.json) : {}
    } catch {
      throw new GatewayError('invalid_output', 'Anthropic: tool input was not valid JSON')
    }
    yield { t: 'tool_call', call: { id: tb.id, name: tb.name, arguments: args } }
  }
  if (structured && finish === 'tool_calls') finish = 'stop'
  yield { t: 'usage', usage }
  yield { t: 'finish', finish }
}

async function listModels(conn: ResolvedConnection): Promise<DiscoveredModel[]> {
  const out: DiscoveredModel[] = []
  let after: string | undefined
  for (let page = 0; page < 20; page++) {
    const url = joinUrl(conn.baseUrl, `v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`)
    const res = await conn.http.request({ method: 'GET', url, headers: headers(conn), timeoutMs: conn.timeoutMs })
    await ensureOk(res, 'Anthropic')
    const j = await res.json<{ data?: { id: string; display_name?: string }[]; has_more?: boolean; last_id?: string }>()
    for (const m of j.data ?? []) out.push({ id: m.id, displayName: m.display_name, operationsHint: ['generate', 'stream'] })
    if (!j.has_more || !j.last_id) break
    after = j.last_id
  }
  return out
}

export const adapter: ProviderAdapter = {
  descriptor: {
    type: 'anthropic',
    version: '1.0.0',
    displayName: 'Anthropic',
    operations: ['generate', 'stream'],
    defaultBaseUrl: 'https://api.anthropic.com',
    requiresApiKey: true,
    supportsDiscovery: true,
    supportsPrivateNetwork: false,
  },
  async testConnection(conn) {
    const r = await timed(() => listModels(conn))
    if (r.error) return { ok: false, latencyMs: r.ms, error: { kind: (r.error as GatewayError).kind ?? 'network', message: (r.error as Error).message } }
    return { ok: true, latencyMs: r.ms, modelCount: r.value?.length }
  },
  listModels,
  generate,
  stream,
}
export default adapter
