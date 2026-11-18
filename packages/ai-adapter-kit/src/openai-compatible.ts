import { randomBytes } from 'node:crypto'
import { GatewayError } from './errors.ts'
import { ensureOk, joinUrl, sseData } from './http.ts'
import { timed, type ConnectionTestResult, type ResolvedConnection } from './adapter.ts'
import type { DiscoveredModel, EmbedRequest, EmbedResult, FinishReason, GenerateRequest, GenerateResult, Message, StreamEvent, ToolCall, TranscribeRequest, TranscribeResult, Usage } from './types.ts'

/**
 * Shared implementation of the OpenAI-style chat-completions protocol. Used *inside* the `openai`,
 * `groq` and `openai-compatible` adapters, each of which stays an independent package with its own
 * defaults and quirks (options below).
 */
export interface OpenAiStyleOptions {
  provider: string
  /** body field for the output-token limit */
  maxTokensField: 'max_tokens' | 'max_completion_tokens'
  /** send stream_options.include_usage */
  streamUsage: boolean
  /** send `reasoning_effort` when the request asks for a reasoning level */
  reasoningEffort: boolean
  /** whether an API key is required (local servers may not need one) */
  requiresKey: boolean
  /**
   * send json_schema with strict:true (default). Strict mode on some providers (e.g. Groq) requires
   * every object to be closed and every property required, which task schemas with optional fields
   * are not; best-effort mode is used there and the gateway still validates every reply against the schema.
   */
  strictSchema?: boolean
}

function headers(conn: ResolvedConnection, o: OpenAiStyleOptions): Record<string, string> {
  if (!conn.apiKey) {
    if (o.requiresKey) throw new GatewayError('auth', `${o.provider}: no API key configured`)
    return {}
  }
  return { authorization: `Bearer ${conn.apiKey}` }
}

export function toOpenAiMessages(messages: Message[]): unknown[] {
  return messages.map((m) => {
    switch (m.role) {
      case 'system':
        return { role: 'system', content: m.content }
      case 'user':
        return {
          role: 'user',
          content: typeof m.content === 'string'
            ? m.content
            : m.content.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.dataBase64}` } })),
        }
      case 'assistant':
        return {
          role: 'assistant',
          content: m.content || null,
          ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}),
        }
      case 'tool':
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
    }
  })
}

export function buildChatBody(model: string, req: GenerateRequest, o: OpenAiStyleOptions, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = { model, messages: toOpenAiMessages(req.messages), [o.maxTokensField]: req.maxOutputTokens }
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.stop?.length) body.stop = req.stop
  if (req.seed !== undefined) body.seed = req.seed
  if (o.reasoningEffort && req.reasoning && req.reasoning !== 'off') body.reasoning_effort = req.reasoning
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
    const tc = req.toolChoice
    if (tc) body.tool_choice = typeof tc === 'string' ? tc : { type: 'function', function: { name: tc.tool } }
  }
  if (req.responseFormat?.type === 'json') {
    body.response_format = req.responseFormat.mode === 'json_schema'
      ? { type: 'json_schema', json_schema: { name: req.responseFormat.name, schema: req.responseFormat.schema, strict: o.strictSchema !== false } }
      : { type: 'json_object' }
  }
  if (stream) {
    body.stream = true
    if (o.streamUsage) body.stream_options = { include_usage: true }
  }
  return body
}

interface OaUsage { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } }
export function mapOpenAiUsage(u: OaUsage | undefined): Usage {
  return {
    inputTokens: u?.prompt_tokens ?? null,
    outputTokens: u?.completion_tokens ?? null,
    cachedInputTokens: u?.prompt_tokens_details?.cached_tokens ?? null,
    reasoningTokens: u?.completion_tokens_details?.reasoning_tokens ?? null,
  }
}

export function mapOpenAiFinish(f: string | null | undefined): FinishReason {
  switch (f) {
    case 'stop': return 'stop'
    case 'length': return 'length'
    case 'tool_calls':
    case 'function_call': return 'tool_calls'
    case 'content_filter': return 'content_filter'
    default: return f ? 'stop' : 'error'
  }
}

function parseArgs(s: string | undefined, provider: string): Record<string, unknown> {
  if (!s) return {}
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { value: v }
  } catch {
    throw new GatewayError('invalid_output', `${provider}: tool call arguments were not valid JSON`)
  }
}

export async function openAiGenerate(conn: ResolvedConnection, model: string, req: GenerateRequest, o: OpenAiStyleOptions, signal?: AbortSignal): Promise<GenerateResult> {
  const res = await conn.http.request({ method: 'POST', url: joinUrl(conn.baseUrl, 'chat/completions'), headers: headers(conn, o), body: buildChatBody(model, req, o, false), signal, timeoutMs: conn.timeoutMs })
  await ensureOk(res, o.provider)
  const j = await res.json<{ choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason?: string }[]; usage?: OaUsage }>()
  const c = j.choices?.[0]
  if (!c) throw new GatewayError('provider_error', `${o.provider}: response had no choices`)
  const toolCalls: ToolCall[] = (c.message?.tool_calls ?? []).map((t) => ({ id: t.id, name: t.function.name, arguments: parseArgs(t.function.arguments, o.provider) }))
  return { text: c.message?.content ?? '', toolCalls, finish: toolCalls.length && c.finish_reason !== 'length' ? 'tool_calls' : mapOpenAiFinish(c.finish_reason), usage: mapOpenAiUsage(j.usage) }
}

export async function* openAiStream(conn: ResolvedConnection, model: string, req: GenerateRequest, o: OpenAiStyleOptions, signal?: AbortSignal): AsyncIterable<StreamEvent> {
  const res = await conn.http.request({ method: 'POST', url: joinUrl(conn.baseUrl, 'chat/completions'), headers: { ...headers(conn, o), accept: 'text/event-stream' }, body: buildChatBody(model, req, o, true), signal, timeoutMs: conn.timeoutMs })
  await ensureOk(res, o.provider)
  yield { t: 'start' }
  const pending = new Map<number, { id: string; name: string; args: string }>()
  let finish: FinishReason | undefined
  let usage: Usage | undefined
  for await (const ev of sseData(res.lines())) {
    if (ev.data === '[DONE]') break
    let chunk: { choices?: { delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[]; usage?: OaUsage; x_groq?: { usage?: OaUsage }; error?: { message?: string } }
    try {
      chunk = JSON.parse(ev.data)
    } catch {
      continue
    }
    if (chunk.error) throw new GatewayError('provider_error', `${o.provider}: ${chunk.error.message ?? 'stream error'}`)
    if (chunk.usage) usage = mapOpenAiUsage(chunk.usage)
    else if (chunk.x_groq?.usage) usage = mapOpenAiUsage(chunk.x_groq.usage)
    for (const ch of chunk.choices ?? []) {
      const d = ch.delta
      if (d?.content) yield { t: 'text', delta: d.content }
      for (const tc of d?.tool_calls ?? []) {
        const p = pending.get(tc.index) ?? { id: '', name: '', args: '' }
        if (tc.id) p.id = tc.id
        if (tc.function?.name) p.name += tc.function.name
        if (tc.function?.arguments) p.args += tc.function.arguments
        pending.set(tc.index, p)
      }
      if (ch.finish_reason) finish = mapOpenAiFinish(ch.finish_reason)
    }
  }
  for (const [i, p] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
    yield { t: 'tool_call', call: { id: p.id || `call_${i}`, name: p.name, arguments: parseArgs(p.args, o.provider) } }
  }
  if (usage) yield { t: 'usage', usage }
  yield { t: 'finish', finish: pending.size && finish !== 'length' ? 'tool_calls' : (finish ?? 'stop') }
}

export async function openAiEmbed(conn: ResolvedConnection, model: string, req: EmbedRequest, o: OpenAiStyleOptions, signal?: AbortSignal): Promise<EmbedResult> {
  const body: Record<string, unknown> = { model, input: req.inputs, encoding_format: 'float' }
  if (req.dimensions) body.dimensions = req.dimensions
  const res = await conn.http.request({ method: 'POST', url: joinUrl(conn.baseUrl, 'embeddings'), headers: headers(conn, o), body, signal, timeoutMs: conn.timeoutMs })
  await ensureOk(res, o.provider)
  const j = await res.json<{ data?: { embedding: number[]; index: number }[]; usage?: { prompt_tokens?: number } }>()
  const vectors = (j.data ?? []).sort((a, b) => a.index - b.index).map((d) => d.embedding)
  if (vectors.length !== req.inputs.length) throw new GatewayError('provider_error', `${o.provider}: expected ${req.inputs.length} embeddings, got ${vectors.length}`)
  return { vectors, dimensions: vectors[0]?.length ?? 0, usage: { inputTokens: j.usage?.prompt_tokens ?? null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null } }
}

export async function openAiListModels(conn: ResolvedConnection, o: OpenAiStyleOptions): Promise<DiscoveredModel[]> {
  const res = await conn.http.request({ method: 'GET', url: joinUrl(conn.baseUrl, 'models'), headers: headers(conn, o), timeoutMs: conn.timeoutMs })
  await ensureOk(res, o.provider)
  const j = await res.json<{ data?: { id: string; context_window?: number; max_completion_tokens?: number }[] }>()
  return (j.data ?? []).map((m) => ({ id: m.id, contextWindow: m.context_window, maxOutputTokens: m.max_completion_tokens }))
}

export async function openAiTest(conn: ResolvedConnection, o: OpenAiStyleOptions): Promise<ConnectionTestResult> {
  const r = await timed(() => openAiListModels(conn, o))
  if (r.error) {
    const e = r.error as GatewayError
    return { ok: false, latencyMs: r.ms, error: { kind: e.kind ?? 'network', message: e.message } }
  }
  return { ok: true, latencyMs: r.ms, modelCount: r.value?.length }
}

/** Encode a multipart/form-data body (fields + one file) without dependencies. */
export function multipart(fields: Record<string, string | undefined>, file: { name: string; filename: string; mimeType: string; data: Buffer }): { body: Buffer; contentType: string } {
  const boundary = `----ebform${randomBytes(12).toString('hex')}`
  const CRLF = '\r\n'
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue
    parts.push(Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="${k}"${CRLF}${CRLF}${v}${CRLF}`))
  }
  const safeName = file.filename.replace(/["\r\n]/g, '_')
  parts.push(Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="${file.name}"; filename="${safeName}"${CRLF}Content-Type: ${file.mimeType}${CRLF}${CRLF}`), file.data, Buffer.from(`${CRLF}--${boundary}--${CRLF}`))
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

/** OpenAI-style `/audio/transcriptions` (OpenAI, Groq Whisper, compatible servers). */
export async function openAiTranscribe(conn: ResolvedConnection, model: string, req: TranscribeRequest, o: OpenAiStyleOptions, signal?: AbortSignal): Promise<TranscribeResult> {
  const ext = /webm/.test(req.mimeType) ? 'webm' : /ogg/.test(req.mimeType) ? 'ogg' : /wav/.test(req.mimeType) ? 'wav' : /mp4|m4a|aac/.test(req.mimeType) ? 'm4a' : /mpeg|mp3/.test(req.mimeType) ? 'mp3' : 'webm'
  const form = multipart({ model, language: req.language, prompt: req.prompt?.slice(0, 800), response_format: 'verbose_json', temperature: '0' },
    { name: 'file', filename: req.filename ?? `audio.${ext}`, mimeType: req.mimeType, data: req.audio })
  const h = headers(conn, o)
  const res = await conn.http.request({ method: 'POST', url: joinUrl(conn.baseUrl, 'audio/transcriptions'), headers: { ...h, 'content-type': form.contentType }, body: form.body, signal, timeoutMs: conn.timeoutMs })
  await ensureOk(res, o.provider)
  const j = await res.json<{ text?: string; language?: string; duration?: number }>()
  if (typeof j.text !== 'string') throw new GatewayError('provider_error', `${o.provider}: transcription had no text`)
  return { text: j.text.trim(), language: j.language ?? null, durationSec: typeof j.duration === 'number' ? j.duration : null, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: null, reasoningTokens: null } }
}
