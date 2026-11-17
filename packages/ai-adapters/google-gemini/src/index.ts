import {
  GatewayError, classifyHttpError, joinUrl, sseData, timed,
  type DiscoveredModel, type EmbedRequest, type EmbedResult, type FinishReason, type GenerateRequest, type GenerateResult,
  type HttpResponse, type Message, type Operation, type ProviderAdapter, type ResolvedConnection, type StreamEvent, type ToolCall, type Usage,
} from '@platform/ai-adapter-kit'
import { redactString } from '@platform/observability'

/** Google Gemini API adapter (generateContent, streamGenerateContent, batchEmbedContents, models). */

type Part = { text?: string; thought?: boolean; inlineData?: { mimeType: string; data: string }; functionCall?: { name: string; args?: Record<string, unknown>; id?: string }; functionResponse?: { name: string; response: Record<string, unknown> } }

function headers(conn: ResolvedConnection): Record<string, string> {
  if (!conn.apiKey) throw new GatewayError('auth', 'Gemini: no API key configured')
  return { 'x-goog-api-key': conn.apiKey }
}
const modelPath = (m: string) => (m.startsWith('models/') ? m : `models/${m}`)

async function ensureOk(res: HttpResponse): Promise<void> {
  if (res.status >= 200 && res.status < 300) return
  const text = await res.text().catch(() => '')
  // an invalid key is reported as HTTP 400 INVALID_ARGUMENT with reason API_KEY_INVALID
  const kind = /API_KEY_INVALID|API key not valid/i.test(text) ? 'auth' : /RESOURCE_EXHAUSTED/.test(text) && res.status === 429 ? classifyHttpError(429, text) : classifyHttpError(res.status, text)
  throw new GatewayError(kind, `Gemini HTTP ${res.status}: ${redactString(text).slice(0, 300)}`, { status: res.status })
}

/** Gemini function declarations accept an OpenAPI-style subset; drop keywords it rejects. */
export function sanitizeSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(sanitizeSchema)
  if (s && typeof s === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(s)) {
      if (k === '$schema' || k === 'additionalProperties' || k === '$id') continue
      out[k] = sanitizeSchema(v)
    }
    return out
  }
  return s
}

export function toContents(messages: Message[]): { system?: string; contents: { role: 'user' | 'model'; parts: Part[] }[] } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content as string).join('\n\n')
  const out: { role: 'user' | 'model'; parts: Part[] }[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    let role: 'user' | 'model'
    let parts: Part[]
    if (m.role === 'user') {
      role = 'user'
      parts = typeof m.content === 'string' ? [{ text: m.content }] : m.content.map((p) => (p.type === 'text' ? { text: p.text } : { inlineData: { mimeType: p.mediaType, data: p.dataBase64 } }))
    } else if (m.role === 'assistant') {
      role = 'model'
      parts = [...(m.content ? [{ text: m.content }] : []), ...(m.toolCalls ?? []).map((c) => ({ functionCall: { name: c.name, args: c.arguments } }))]
    } else {
      role = 'user'
      parts = [{ functionResponse: { name: m.name, response: { content: m.content } } }]
    }
    const last = out[out.length - 1]
    if (last && last.role === role) last.parts.push(...parts)
    else out.push({ role, parts })
  }
  return { system: system || undefined, contents: out }
}

export function buildBody(req: GenerateRequest): Record<string, unknown> {
  const { system, contents } = toContents(req.messages)
  const gc: Record<string, unknown> = { maxOutputTokens: req.maxOutputTokens }
  if (req.temperature !== undefined) gc.temperature = req.temperature
  if (req.stop?.length) gc.stopSequences = req.stop
  if (req.seed !== undefined) gc.seed = req.seed
  if (req.responseFormat?.type === 'json') {
    gc.responseMimeType = 'application/json'
    if (req.responseFormat.mode === 'json_schema') gc.responseJsonSchema = req.responseFormat.schema
  }
  if (req.reasoning) gc.thinkingConfig = { thinkingBudget: { off: 0, low: 1024, medium: 4096, high: 16384 }[req.reasoning] }
  const body: Record<string, unknown> = { contents, generationConfig: gc }
  if (system) body.systemInstruction = { parts: [{ text: system }] }
  if (req.tools?.length) {
    body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: sanitizeSchema(t.parameters) })) }]
    const tc = req.toolChoice
    if (tc) {
      body.toolConfig = {
        functionCallingConfig: tc === 'auto' ? { mode: 'AUTO' } : tc === 'none' ? { mode: 'NONE' } : tc === 'required' ? { mode: 'ANY' } : { mode: 'ANY', allowedFunctionNames: [tc.tool] },
      }
    }
  }
  return body
}

function mapFinish(f: string | undefined, blocked: boolean): FinishReason {
  if (blocked) return 'content_filter'
  switch (f) {
    case 'STOP': return 'stop'
    case 'MAX_TOKENS': return 'length'
    case 'SAFETY': case 'RECITATION': case 'PROHIBITED_CONTENT': case 'BLOCKLIST': case 'SPII': return 'content_filter'
    case 'MALFORMED_FUNCTION_CALL': return 'error'
    case undefined: return 'stop'
    default: return 'stop'
  }
}
interface GUsage { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number; thoughtsTokenCount?: number }
const mapUsage = (u: GUsage | undefined): Usage => ({ inputTokens: u?.promptTokenCount ?? null, outputTokens: u?.candidatesTokenCount ?? null, cachedInputTokens: u?.cachedContentTokenCount ?? null, reasoningTokens: u?.thoughtsTokenCount ?? null })

interface GResponse { candidates?: { content?: { parts?: Part[] }; finishReason?: string }[]; promptFeedback?: { blockReason?: string }; usageMetadata?: GUsage }

let callSeq = 0
function partsToOutput(parts: Part[]): { text: string; calls: ToolCall[] } {
  let text = ''
  const calls: ToolCall[] = []
  for (const p of parts) {
    if (p.thought) continue
    if (p.text) text += p.text
    if (p.functionCall) calls.push({ id: p.functionCall.id ?? `call_${++callSeq}`, name: p.functionCall.name, arguments: p.functionCall.args ?? {} })
  }
  return { text, calls }
}

async function generate(conn: ResolvedConnection, model: string, req: GenerateRequest, signal?: AbortSignal): Promise<GenerateResult> {
  const res = await conn.http.request({ method: 'POST', url: joinUrl(conn.baseUrl, `${modelPath(model)}:generateContent`), headers: headers(conn), body: buildBody(req), signal, timeoutMs: conn.timeoutMs })
  await ensureOk(res)
  const j = await res.json<GResponse>()
  const c = j.candidates?.[0]
  const blocked = !!j.promptFeedback?.blockReason
  const { text, calls } = partsToOutput(c?.content?.parts ?? [])
  const finish = calls.length ? 'tool_calls' : mapFinish(c?.finishReason, blocked)
  return { text, toolCalls: calls, finish, usage: mapUsage(j.usageMetadata) }
}

async function* stream(conn: ResolvedConnection, model: string, req: GenerateRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
  const res = await conn.http.request({ method: 'POST', url: joinUrl(conn.baseUrl, `${modelPath(model)}:streamGenerateContent?alt=sse`), headers: { ...headers(conn), accept: 'text/event-stream' }, body: buildBody(req), signal, timeoutMs: conn.timeoutMs })
  await ensureOk(res)
  yield { t: 'start' }
  let usage: Usage | undefined
  let finishRaw: string | undefined
  let blocked = false
  const calls: ToolCall[] = []
  for await (const ev of sseData(res.lines())) {
    let j: GResponse & { error?: { message?: string } }
    try {
      j = JSON.parse(ev.data)
    } catch {
      continue
    }
    if (j.error) throw new GatewayError('provider_error', `Gemini stream error: ${j.error.message ?? 'unknown'}`)
    if (j.promptFeedback?.blockReason) blocked = true
    const c = j.candidates?.[0]
    const out = partsToOutput(c?.content?.parts ?? [])
    if (out.text) yield { t: 'text', delta: out.text }
    calls.push(...out.calls)
    if (c?.finishReason) finishRaw = c.finishReason
    if (j.usageMetadata) usage = mapUsage(j.usageMetadata)
  }
  for (const call of calls) yield { t: 'tool_call', call }
  if (usage) yield { t: 'usage', usage }
  yield { t: 'finish', finish: calls.length ? 'tool_calls' : mapFinish(finishRaw, blocked) }
}

async function embed(conn: ResolvedConnection, model: string, req: EmbedRequest, signal?: AbortSignal): Promise<EmbedResult> {
  const requests = req.inputs.map((text) => ({
    model: modelPath(model),
    content: { parts: [{ text }] },
    taskType: req.purpose === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
    ...(req.dimensions ? { outputDimensionality: req.dimensions } : {}),
  }))
  const res = await conn.http.request({ method: 'POST', url: joinUrl(conn.baseUrl, `${modelPath(model)}:batchEmbedContents`), headers: headers(conn), body: { requests }, signal, timeoutMs: conn.timeoutMs })
  await ensureOk(res)
  const j = await res.json<{ embeddings?: { values: number[] }[] }>()
  const vectors = (j.embeddings ?? []).map((e) => e.values)
  if (vectors.length !== req.inputs.length) throw new GatewayError('provider_error', `Gemini: expected ${req.inputs.length} embeddings, got ${vectors.length}`)
  return { vectors, dimensions: vectors[0]?.length ?? 0, usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null } }
}

async function listModels(conn: ResolvedConnection): Promise<DiscoveredModel[]> {
  const out: DiscoveredModel[] = []
  let token: string | undefined
  for (let page = 0; page < 20; page++) {
    const res = await conn.http.request({ method: 'GET', url: joinUrl(conn.baseUrl, `models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`), headers: headers(conn), timeoutMs: conn.timeoutMs })
    await ensureOk(res)
    const j = await res.json<{ models?: { name: string; displayName?: string; inputTokenLimit?: number; outputTokenLimit?: number; supportedGenerationMethods?: string[] }[]; nextPageToken?: string }>()
    for (const m of j.models ?? []) {
      const methods = m.supportedGenerationMethods ?? []
      const ops: Operation[] = []
      if (methods.includes('generateContent')) ops.push('generate', 'stream')
      if (methods.includes('embedContent') || methods.includes('batchEmbedContents')) ops.push('embed')
      out.push({ id: m.name.replace(/^models\//, ''), displayName: m.displayName, contextWindow: m.inputTokenLimit, maxOutputTokens: m.outputTokenLimit, operationsHint: ops })
    }
    if (!j.nextPageToken) break
    token = j.nextPageToken
  }
  return out
}

export const adapter: ProviderAdapter = {
  descriptor: {
    type: 'google-gemini',
    version: '1.0.0',
    displayName: 'Google Gemini',
    operations: ['generate', 'stream', 'embed'],
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
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
  embed,
}
export default adapter
