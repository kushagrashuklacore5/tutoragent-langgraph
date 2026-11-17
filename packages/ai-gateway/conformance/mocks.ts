/**
 * Deterministic mock servers for the four provider protocols used by the adapters
 * (OpenAI-style, Anthropic Messages, Gemini, Ollama). They power the "recorded" conformance mode:
 * fast, offline and identical on every run. Behaviour is driven by the request:
 *  - API key must equal MOCK_KEY (else 401)
 *  - model `err-429` | `err-500` | `err-503` | `err-ctx` | `missing-model` trigger errors
 *  - system prompt containing "PONG" -> reply "PONG"
 *  - JSON response format -> {"answer":"ok","n":1}
 *  - tools + forced/required choice, or user text containing "call tool" -> tool call get_weather({city:"Pune"})
 *  - last message is a tool result -> "Tool said: <content>"
 *  - otherwise echo: "echo: <last user text>"; output limited by the token limit (1 token ~ 1 word)
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export const MOCK_KEY = 'mock-key-0123456789abcdef'
export type Protocol = 'openai' | 'anthropic' | 'gemini' | 'ollama'

interface Plan {
  text: string
  toolCall?: { name: string; args: Record<string, unknown> }
  finish: 'stop' | 'length' | 'tool'
  inTokens: number
  outTokens: number
}

function plan(o: { system: string; lastUser: string; lastIsTool: boolean; toolResult: string; json: boolean; tools: boolean; forced: boolean; maxTokens: number }): Plan {
  const inTokens = (o.system + ' ' + o.lastUser).split(/\s+/).filter(Boolean).length + 3
  if (o.tools && !o.lastIsTool && (o.forced || /call tool/i.test(o.lastUser))) {
    return { text: '', toolCall: { name: 'get_weather', args: { city: 'Pune' } }, finish: 'tool', inTokens, outTokens: 7 }
  }
  let text = o.lastIsTool ? `Tool said: ${o.toolResult}` : o.json ? '{"answer":"ok","n":1}' : /PONG/.test(o.system) ? 'PONG' : `echo: ${o.lastUser}`
  const words = text.split(' ')
  let finish: Plan['finish'] = 'stop'
  if (!o.json && words.length > o.maxTokens) {
    text = words.slice(0, o.maxTokens).join(' ')
    finish = 'length'
  }
  return { text, finish, inTokens, outTokens: Math.min(words.length, o.maxTokens) }
}

function vec(text: string, dims: number): number[] {
  const v: number[] = []
  let h = 2166136261
  for (let i = 0; i < dims; i++) {
    for (const ch of text + i) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
    v.push(((h >>> 0) % 2000) / 1000 - 1)
  }
  return v
}

const chunks = (s: string) => s.match(/.{1,4}/gsu) ?? []

type Body = Record<string, any>
type Res = http.ServerResponse

function send(res: Res, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
function sse(res: Res, events: { event?: string; data: unknown }[], done = false) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const e of events) res.write(`${e.event ? `event: ${e.event}\n` : ''}data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`)
  if (done) res.write('data: [DONE]\n\n')
  res.end()
}

function errorFor(model: string, proto: Protocol): { status: number; body: unknown } | null {
  const err = (status: number, message: string, type = 'error') =>
    proto === 'anthropic' ? { status, body: { type: 'error', error: { type, message } } }
    : proto === 'gemini' ? { status, body: { error: { code: status, message, status: type } } }
    : proto === 'ollama' ? { status, body: { error: message } }
    : { status, body: { error: { message, type, code: type } } }
  switch (model) {
    case 'err-429': return err(429, 'Rate limit reached, please slow down', 'rate_limit_error')
    case 'err-500': return err(500, 'internal server error', 'api_error')
    case 'err-503': return err(proto === 'anthropic' ? 529 : 503, 'Overloaded', 'overloaded_error')
    case 'err-ctx': return err(400, proto === 'anthropic' ? 'prompt is too long: 300000 tokens > 200000 maximum' : "This model's maximum context length is 8192 tokens", 'invalid_request_error')
    case 'missing-model': return err(404, `The model 'missing-model' does not exist`, 'not_found_error')
    default: return null
  }
}

const textOf = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: any) => p.text ?? (typeof p.content === 'string' ? p.content : '')).join('') : ''

// ── protocol handlers ──────────────────────────────────────────────

function openai(req: http.IncomingMessage, path: string, b: Body, res: Res) {
  if (req.headers.authorization !== `Bearer ${MOCK_KEY}`) return send(res, 401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } })
  if (req.method === 'GET' && path.endsWith('/models')) return send(res, 200, { object: 'list', data: [{ id: 'mock-chat', object: 'model', context_window: 8192 }, { id: 'mock-embed', object: 'model' }] })
  const e = errorFor(b.model, 'openai')
  if (e) return send(res, e.status, e.body)
  if (path.endsWith('/embeddings')) {
    const dims = b.dimensions ?? 8
    return send(res, 200, { data: (b.input as string[]).map((t, index) => ({ embedding: vec(t, dims), index })), usage: { prompt_tokens: 4 } })
  }
  const msgs = b.messages as Body[]
  const last = msgs[msgs.length - 1]!
  const p = plan({
    system: msgs.filter((m) => m.role === 'system').map((m) => m.content).join(' '),
    lastUser: textOf([...msgs].reverse().find((m) => m.role === 'user')?.content),
    lastIsTool: last.role === 'tool', toolResult: last.content,
    json: !!b.response_format, tools: !!b.tools, forced: b.tool_choice === 'required' || typeof b.tool_choice === 'object',
    maxTokens: b.max_completion_tokens ?? b.max_tokens ?? 1000,
  })
  const finish = p.finish === 'tool' ? 'tool_calls' : p.finish
  const usage = { prompt_tokens: p.inTokens, completion_tokens: p.outTokens }
  const tc = p.toolCall ? [{ id: 'call_1', type: 'function', function: { name: p.toolCall.name, arguments: JSON.stringify(p.toolCall.args) } }] : undefined
  if (!b.stream) return send(res, 200, { choices: [{ index: 0, message: { role: 'assistant', content: p.toolCall ? null : p.text, ...(tc ? { tool_calls: tc } : {}) }, finish_reason: finish }], usage })
  const events: { data: unknown }[] = []
  for (const c of chunks(p.text)) events.push({ data: { choices: [{ index: 0, delta: { content: c } }] } })
  if (tc) {
    const args = tc[0]!.function.arguments
    events.push({ data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: args.slice(0, 5) } }] } }] } })
    events.push({ data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }] } }] } })
  }
  events.push({ data: { choices: [{ index: 0, delta: {}, finish_reason: finish }] } })
  if (b.stream_options?.include_usage) events.push({ data: { choices: [], usage } })
  else events.push({ data: { choices: [], x_groq: { usage } } })
  return sse(res, events, true)
}

function anthropic(req: http.IncomingMessage, path: string, b: Body, res: Res) {
  if (req.headers['x-api-key'] !== MOCK_KEY) return send(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })
  if (req.headers['anthropic-version'] !== '2023-06-01') return send(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'missing anthropic-version' } })
  if (req.method === 'GET' && path.startsWith('/v1/models')) return send(res, 200, { data: [{ id: 'mock-chat', display_name: 'Mock Chat', type: 'model' }], has_more: false, last_id: 'mock-chat' })
  const e = errorFor(b.model, 'anthropic')
  if (e) return send(res, e.status, e.body)
  const msgs = b.messages as Body[]
  const last = msgs[msgs.length - 1]!
  const lastBlocks = Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content }]
  const toolRes = lastBlocks.find((x: Body) => x.type === 'tool_result')
  const formatTool = b.tool_choice?.type === 'tool' && String(b.tool_choice.name).startsWith('emit_')
  const p = plan({
    system: b.system ?? '', lastUser: textOf(lastBlocks.filter((x: Body) => x.type === 'text')),
    lastIsTool: !!toolRes, toolResult: toolRes?.content ?? '', json: false, tools: !!b.tools && !formatTool,
    forced: b.tool_choice?.type === 'any' || b.tool_choice?.type === 'tool', maxTokens: b.max_tokens,
  })
  const usage = { input_tokens: p.inTokens, output_tokens: p.outTokens }
  let content: Body[]
  let stop: string
  if (formatTool) {
    content = [{ type: 'tool_use', id: 'toolu_fmt', name: b.tool_choice.name, input: { answer: 'ok', n: 1 } }]
    stop = 'tool_use'
  } else if (p.toolCall) {
    content = [{ type: 'tool_use', id: 'toolu_1', name: p.toolCall.name, input: p.toolCall.args }]
    stop = 'tool_use'
  } else {
    content = [{ type: 'text', text: p.text }]
    stop = p.finish === 'length' ? 'max_tokens' : 'end_turn'
  }
  if (!b.stream) return send(res, 200, { id: 'msg_1', type: 'message', role: 'assistant', content, stop_reason: stop, usage })
  const ev: { event: string; data: unknown }[] = [{ event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: p.inTokens, output_tokens: 1 } } } }]
  content.forEach((blk, index) => {
    if (blk.type === 'text') {
      ev.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } })
      for (const c of chunks(blk.text)) ev.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: c } } })
    } else {
      ev.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'tool_use', id: blk.id, name: blk.name, input: {} } } })
      const js = JSON.stringify(blk.input)
      ev.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: js.slice(0, 4) } } })
      ev.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: js.slice(4) } } })
    }
    ev.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } })
  })
  ev.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: p.outTokens } } })
  ev.push({ event: 'message_stop', data: { type: 'message_stop' } })
  return sse(res, ev)
}

function gemini(req: http.IncomingMessage, path: string, b: Body, res: Res) {
  if (req.headers['x-goog-api-key'] !== MOCK_KEY) return send(res, 400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } })
  if (req.method === 'GET' && path.startsWith('/v1beta/models')) {
    return send(res, 200, { models: [
      { name: 'models/mock-chat', displayName: 'Mock', inputTokenLimit: 8192, outputTokenLimit: 1024, supportedGenerationMethods: ['generateContent', 'countTokens'] },
      { name: 'models/mock-embed', supportedGenerationMethods: ['embedContent'] },
    ] })
  }
  const m = /models\/([^:]+):(\w+)/.exec(path)
  const model = m?.[1] ?? ''
  const op = m?.[2] ?? ''
  const e = errorFor(model, 'gemini')
  if (e) return send(res, e.status, e.body)
  if (op === 'batchEmbedContents') {
    return send(res, 200, { embeddings: (b.requests as Body[]).map((r) => ({ values: vec(r.content.parts[0].text, r.outputDimensionality ?? 8) })) })
  }
  const contents = b.contents as Body[]
  const last = contents[contents.length - 1]!
  const fr = (last.parts as Body[]).find((p) => p.functionResponse)
  const fcc = b.toolConfig?.functionCallingConfig
  const p = plan({
    system: b.systemInstruction?.parts?.map((x: Body) => x.text).join(' ') ?? '',
    lastUser: (last.parts as Body[]).map((x) => x.text ?? '').join(''),
    lastIsTool: !!fr, toolResult: fr?.functionResponse?.response?.content ?? '',
    json: b.generationConfig?.responseMimeType === 'application/json', tools: !!b.tools, forced: fcc?.mode === 'ANY',
    maxTokens: b.generationConfig?.maxOutputTokens ?? 1000,
  })
  const parts = p.toolCall ? [{ functionCall: { name: p.toolCall.name, args: p.toolCall.args } }] : [{ text: p.text }]
  const finishReason = p.finish === 'length' ? 'MAX_TOKENS' : 'STOP'
  const usageMetadata = { promptTokenCount: p.inTokens, candidatesTokenCount: p.outTokens, totalTokenCount: p.inTokens + p.outTokens }
  if (op === 'generateContent') return send(res, 200, { candidates: [{ content: { role: 'model', parts }, finishReason }], usageMetadata })
  const ev: { data: unknown }[] = []
  if (p.toolCall) ev.push({ data: { candidates: [{ content: { role: 'model', parts } }] } })
  else for (const c of chunks(p.text)) ev.push({ data: { candidates: [{ content: { role: 'model', parts: [{ text: c }] } }] } })
  ev.push({ data: { candidates: [{ content: { role: 'model', parts: [] }, finishReason }], usageMetadata } })
  return sse(res, ev)
}

function ollama(req: http.IncomingMessage, path: string, b: Body, res: Res) {
  if (req.method === 'GET' && path === '/api/tags') {
    return send(res, 200, { models: [
      { name: 'mock-chat', details: { context_length: 8192 }, capabilities: ['completion', 'tools'] },
      { name: 'mock-embed', details: {}, capabilities: ['embedding'] },
    ] })
  }
  const e = errorFor(b.model, 'ollama')
  if (e) return send(res, e.status, e.body)
  if (path === '/api/embed') return send(res, 200, { embeddings: (b.input as string[]).map((t) => vec(t, b.dimensions ?? 8)), prompt_eval_count: 4 })
  const msgs = b.messages as Body[]
  const last = msgs[msgs.length - 1]!
  const p = plan({
    system: msgs.filter((x) => x.role === 'system').map((x) => x.content).join(' '),
    lastUser: [...msgs].reverse().find((x) => x.role === 'user')?.content ?? '',
    lastIsTool: last.role === 'tool', toolResult: last.content, json: !!b.format, tools: !!b.tools, forced: false,
    maxTokens: b.options?.num_predict ?? 1000,
  })
  const done = { done: true, done_reason: p.finish === 'length' ? 'length' : 'stop', prompt_eval_count: p.inTokens, eval_count: p.outTokens }
  const tool_calls = p.toolCall ? [{ function: { name: p.toolCall.name, arguments: p.toolCall.args } }] : undefined
  if (!b.stream) return send(res, 200, { model: b.model, message: { role: 'assistant', content: p.toolCall ? '' : p.text, ...(tool_calls ? { tool_calls } : {}) }, ...done })
  res.writeHead(200, { 'content-type': 'application/x-ndjson' })
  if (tool_calls) res.write(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls }, done: false }) + '\n')
  else for (const c of chunks(p.text)) res.write(JSON.stringify({ message: { role: 'assistant', content: c }, done: false }) + '\n')
  res.write(JSON.stringify({ message: { role: 'assistant', content: '' }, ...done }) + '\n')
  res.end()
}

const HANDLERS = { openai, anthropic, gemini, ollama }
const PREFIX: Record<Protocol, string> = { openai: '/v1', anthropic: '', gemini: '/v1beta', ollama: '' }

/** Start a mock provider on 127.0.0.1. `requests` records method/path/body/headers for assertions. */
export async function startMock(protocol: Protocol): Promise<{ baseUrl: string; close(): Promise<void>; requests: { path: string; body: Body; headers: http.IncomingHttpHeaders }[] }> {
  const requests: { path: string; body: Body; headers: http.IncomingHttpHeaders }[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0]!
      let body: Body = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        return send(res, 400, { error: 'bad json' })
      }
      requests.push({ path, body, headers: req.headers })
      try {
        HANDLERS[protocol](req, path, body, res)
      } catch (e) {
        send(res, 500, { error: String(e) })
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}${PREFIX[protocol]}`,
    requests,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()) }),
  }
}
