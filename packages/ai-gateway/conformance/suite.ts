/**
 * The ONE adapter contract suite (AI_GATEWAY.md § 13.1). Every adapter runs exactly these checks;
 * expectations scale with what the adapter/model declares, and undeclared capabilities must be
 * refused cleanly rather than produce garbage.
 */
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  GatewayError, createHttpClient,
  type Capabilities, type GenerateRequest, type ProviderAdapter, type ResolvedConnection, type StreamEvent, type ToolDefinition,
} from '@platform/ai-adapter-kit'
import { configureLogging } from '@platform/observability'

export interface ConformanceTarget {
  name: string
  adapter: ProviderAdapter
  mode: 'recorded' | 'local' | 'live'
  baseUrl: string
  apiKey?: string
  chatModel: string
  embedModel?: string
  /** what this model is declared to support (what the registry would claim) */
  declared: Capabilities
  /** recorded mode only: models that make the mock return specific errors */
  errorModels?: boolean
  /** extra request fields for slow/thinking local models */
  baseRequest?: Partial<GenerateRequest>
  timeoutMs?: number
}

export const WEATHER_TOOL: ToolDefinition = {
  name: 'get_weather',
  description: 'Get the current weather for a city',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
}
export const ANSWER_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' }, n: { type: 'integer' } },
  required: ['answer', 'n'],
  additionalProperties: false,
}

export function connectionFor(t: ConformanceTarget, overrides: Partial<ResolvedConnection> = {}): ResolvedConnection {
  return {
    id: `conformance-${t.name}`,
    baseUrl: t.baseUrl,
    apiKey: t.apiKey,
    http: createHttpClient({ requireHttps: false, allowPrivateNetwork: true }),
    timeoutMs: t.timeoutMs ?? 30_000,
    ...overrides,
  }
}

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

export function defineConformanceSuite(t: ConformanceTarget): void {
  // connection is built lazily: targets may learn their base URL in a before() hook
  const conn = () => connectionFor(t)
  const live = t.mode !== 'recorded'
  const req = (r: Partial<GenerateRequest>): GenerateRequest => ({ maxOutputTokens: 200, temperature: 0, messages: [], ...t.baseRequest, ...r })
  const name = (s: string) => `[${t.name}/${t.mode}] ${s}`
  const ops = t.adapter.descriptor.operations
  const opts = { timeout: (t.timeoutMs ?? 30_000) * 2 }

  // capture every log line so we can prove no secret leaks
  const logs: string[] = []
  configureLogging({ sink: (l) => logs.push(l), level: 'debug' })

  test(name('descriptor is well-formed and methods match declared operations'), () => {
    const d = t.adapter.descriptor
    assert.match(d.type, /^[a-z][a-z0-9-]*$/)
    assert.ok(d.version && d.displayName)
    assert.equal(typeof t.adapter.generate, 'function')
    assert.equal(typeof t.adapter.stream, 'function')
    assert.equal(!!t.adapter.embed, ops.includes('embed'), 'embed() present iff "embed" is a declared operation')
    assert.equal(!!t.adapter.listModels, d.supportsDiscovery)
  })

  test(name('generate: basic text, finish, usage shape'), opts, async () => {
    const r = await t.adapter.generate(conn(), t.chatModel, req({ messages: [{ role: 'user', content: 'Say hello in one short sentence.' }] }))
    assert.ok(r.text.trim().length > 0)
    assert.ok(['stop', 'length'].includes(r.finish))
    for (const k of ['inputTokens', 'outputTokens'] as const) assert.ok(r.usage[k] === null || (Number.isInteger(r.usage[k]) && r.usage[k]! >= 0))
    assert.deepEqual(r.toolCalls, [])
  })

  test(name('generate: system prompt is honoured'), opts, async () => {
    const r = await t.adapter.generate(conn(), t.chatModel, req({ messages: [{ role: 'system', content: 'Reply with exactly the word PONG and nothing else.' }, { role: 'user', content: 'ping' }] }))
    assert.match(r.text, /PONG/i)
  })

  test(name('generate: output limit -> finish "length"'), opts, async () => {
    const r = await t.adapter.generate(conn(), t.chatModel, req({ maxOutputTokens: 5, messages: [{ role: 'user', content: 'Write a long, detailed essay about the history of mathematics in India.' }] }))
    assert.equal(r.finish, 'length')
  })

  test(name('generate: Devanagari round-trip'), opts, async () => {
    const r = await t.adapter.generate(conn(), t.chatModel, req({ messages: [{ role: 'user', content: 'Repeat exactly this word: नमस्ते' }] }))
    assert.ok(r.text.includes('नमस्ते'), `got: ${r.text.slice(0, 80)}`)
  })

  test(name('stream: event order, text, finish, optional usage'), opts, async () => {
    const ev = await collect(t.adapter.stream(conn(), t.chatModel, req({ messages: [{ role: 'user', content: 'Say hello in one short sentence.' }] })))
    assert.equal(ev[0]?.t, 'start')
    assert.equal(ev.at(-1)?.t, 'finish')
    assert.equal(ev.filter((e) => e.t === 'finish').length, 1)
    const text = ev.filter((e) => e.t === 'text').map((e) => (e as { delta: string }).delta).join('')
    assert.ok(text.trim().length > 0)
    const u = ev.find((e) => e.t === 'usage')
    if (u && u.t === 'usage') assert.ok(u.usage.outputTokens === null || u.usage.outputTokens >= 0)
  })

  test(name('cancellation: aborted signal rejects with "cancelled"'), opts, async () => {
    const ac = new AbortController()
    ac.abort()
    await assert.rejects(t.adapter.generate(conn(), t.chatModel, req({ messages: [{ role: 'user', content: 'hi' }] }), ac.signal), (e: GatewayError) => e.kind === 'cancelled')
  })

  if (t.declared.structuredOutput !== 'none') {
    test(name(`structured output (${t.declared.structuredOutput}) yields valid JSON`), opts, async () => {
      const r = await t.adapter.generate(conn(), t.chatModel, req({
        messages: [{ role: 'system', content: 'Return JSON with "answer" set to "ok" and "n" set to 1.' }, { role: 'user', content: 'Give the result.' }],
        responseFormat: { type: 'json', mode: t.declared.structuredOutput as 'json_mode' | 'json_schema', schema: ANSWER_SCHEMA, name: 'answer' },
      }))
      const j = JSON.parse(r.text)
      assert.equal(typeof j.answer, 'string')
      assert.equal(typeof j.n, 'number')
    })
  }

  if (t.declared.tools !== 'none') {
    test(name('tools: model calls the tool, then continues with the tool result'), opts, async () => {
      const first = await t.adapter.generate(conn(), t.chatModel, req({
        messages: [{ role: 'system', content: 'Use the get_weather tool to answer weather questions.' }, { role: 'user', content: 'What is the weather in Pune? Please call tool get_weather.' }],
        tools: [WEATHER_TOOL],
        toolChoice: t.declared.forcedToolChoice ? 'required' : 'auto',
      }))
      assert.equal(first.finish, 'tool_calls')
      const call = first.toolCalls[0]
      assert.ok(call, 'a tool call was returned')
      assert.equal(call.name, 'get_weather')
      assert.equal(typeof call.arguments, 'object')
      const second = await t.adapter.generate(conn(), t.chatModel, req({
        messages: [
          { role: 'user', content: 'What is the weather in Pune? Please call tool get_weather.' },
          { role: 'assistant', content: first.text, toolCalls: first.toolCalls },
          { role: 'tool', toolCallId: call.id, name: 'get_weather', content: 'Sunny, 31°C' },
        ],
        tools: [WEATHER_TOOL],
      }))
      assert.ok(second.text.trim().length > 0)
    })

    test(name('tools: streamed tool call is assembled'), opts, async () => {
      const ev = await collect(t.adapter.stream(conn(), t.chatModel, req({
        messages: [{ role: 'user', content: 'What is the weather in Pune? Please call tool get_weather.' }],
        tools: [WEATHER_TOOL],
        toolChoice: t.declared.forcedToolChoice ? 'required' : 'auto',
      })))
      const calls = ev.filter((e) => e.t === 'tool_call')
      assert.ok(calls.length >= 1)
      assert.equal(ev.at(-1)?.t === 'finish' && ev.at(-1), ev.at(-1))
    })
  }

  if (ops.includes('embed') && t.embedModel) {
    test(name('embeddings: one vector per input, consistent dimensions'), opts, async () => {
      const r = await t.adapter.embed!(conn(), t.embedModel!, { inputs: ['alpha', 'beta gamma'], purpose: 'document' })
      assert.equal(r.vectors.length, 2)
      assert.ok(r.dimensions > 0)
      assert.ok(r.vectors.every((v) => v.length === r.dimensions))
      if (t.declared.embeddingDimensions.length) assert.ok(t.declared.embeddingDimensions.includes(r.dimensions))
    })
  }

  if (t.adapter.listModels) {
    test(name('discovery: listModels returns model ids'), opts, async () => {
      const m = await t.adapter.listModels!(conn())
      assert.ok(Array.isArray(m) && m.length > 0)
      assert.ok(m.every((x) => typeof x.id === 'string' && x.id.length > 0))
    })
    test(name('connection test reports ok'), opts, async () => {
      const r = await t.adapter.testConnection(conn())
      assert.equal(r.ok, true, JSON.stringify(r.error))
    })
  }

  if (t.errorModels) {
    const expectKind = async (model: string, kinds: string[], c = conn()) => {
      const err = await t.adapter.generate(c, model, req({ messages: [{ role: 'user', content: 'hi' }] })).then(() => null, (e: unknown) => e)
      assert.ok(err instanceof GatewayError, `expected GatewayError, got ${String(err)}`)
      assert.ok(kinds.includes(err.kind), `${model}: expected ${kinds.join('|')}, got ${err.kind}`)
      return err
    }
    test(name('errors: rate limit, provider error, overload, context length, missing model'), async () => {
      assert.equal((await expectKind('err-429', ['rate_limited'])).fallbackEligible, true)
      await expectKind('err-500', ['provider_error'])
      await expectKind('err-503', ['overloaded'])
      assert.equal((await expectKind('err-ctx', ['context_length_exceeded'])).fallbackEligible, false)
      await expectKind('missing-model', ['model_not_found', 'invalid_request'])
    })
    if (t.adapter.descriptor.requiresApiKey) {
      test(name('errors: bad key -> auth, and the key never appears in errors or logs'), async () => {
        const bad = connectionFor(t, { apiKey: 'bad-key-WRONGKEY-abcdefghijklmnop' })
        const e = await expectKind(t.chatModel, ['auth'], bad)
        assert.ok(!e.message.includes('WRONGKEY'))
        assert.ok(!e.message.includes(t.apiKey ?? '§'))
        assert.ok(!logs.some((l) => l.includes(t.apiKey ?? '§') || l.includes('WRONGKEY')))
      })
    }
  }

  test(name('security: adapter refuses private destinations unless the policy allows them'), async (tc: TestContext) => {
    if (live && !t.baseUrl.includes('127.0.0.1') && !t.baseUrl.includes('localhost')) return tc.skip('hosted endpoint')
    const guarded = connectionFor(t, { http: createHttpClient({ requireHttps: false, allowPrivateNetwork: false }) })
    await assert.rejects(t.adapter.generate(guarded, t.chatModel, req({ messages: [{ role: 'user', content: 'hi' }] })), (e: GatewayError) => e.kind === 'blocked_destination')
  })
}
