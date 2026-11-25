import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GatewayError, type HttpRequest, type ResolvedConnection } from '@platform/ai-adapter-kit'
import { adapter, speechBody } from '../src/index.ts'

const reply = (status: number, body: unknown) => ({ status, headers: {}, text: async () => JSON.stringify(body), json: async <T,>() => body as T, lines: async function* () { /* unused */ } })
const conn = (status: number, body: unknown, seen: HttpRequest[] = []): ResolvedConnection => ({
  id: 'c', baseUrl: 'https://api.sarvam.test', apiKey: 'test-key', timeoutMs: 1000,
  http: { request: async (r) => { seen.push(r); return reply(status, body) } },
})
const req = { text: 'अब देखिए, chlorophyll light को absorb करता है।', language: 'hi-IN' as const, style: 'teacher' as const }

test('sends the documented request and decodes base64 audio', async () => {
  const seen: HttpRequest[] = []
  const r = await adapter.synthesize!(conn(200, { request_id: 'x', audios: [Buffer.from('mp3-bytes').toString('base64')] }, seen), 'bulbul:v4-flash', req)
  assert.equal(r.audio.toString(), 'mp3-bytes')
  assert.equal(r.mimeType, 'audio/mpeg')
  assert.equal(r.usage.inputTokens, req.text.length, 'characters are metered')
  assert.equal(seen[0]!.url, 'https://api.sarvam.test/text-to-speech')
  assert.equal(seen[0]!.headers!['api-subscription-key'], 'test-key')
  const b = seen[0]!.body as ReturnType<typeof speechBody>
  assert.deepEqual([b.model, b.language_code, b.output_audio_codec, b.enable_preprocessing], ['bulbul:v4-flash', 'hi-IN', 'mp3', true])
  assert.equal(speechBody('m', { ...req, pace: 9 }).pace, 2, 'pace is clamped to the documented range')
})

test('refuses bad input before spending credits, and reports provider failures', async () => {
  const seen: HttpRequest[] = []
  await assert.rejects(adapter.synthesize!(conn(200, {}, seen), 'm', { ...req, text: 'x'.repeat(2501) }), GatewayError)
  await assert.rejects(adapter.synthesize!(conn(200, {}, seen), 'm', { ...req, text: '  ' }), GatewayError)
  assert.equal(seen.length, 0)
  await assert.rejects(adapter.synthesize!(conn(200, { audios: [] }), 'm', req), /no audio/)
  await assert.rejects(adapter.synthesize!(conn(429, { error: { message: 'rate limit reached' } }), 'm', req), (e: GatewayError) => e.kind === 'rate_limited')
  await assert.rejects(adapter.synthesize!(conn(403, { error: { message: 'bad key' } }), 'm', req), (e: GatewayError) => e.kind === 'permission')
})

test('connection test is free: a valid key gets a 400 for empty text, a bad key fails', async () => {
  assert.equal((await adapter.testConnection(conn(400, { error: { message: 'text required' } }))).ok, true)
  assert.equal((await adapter.testConnection(conn(403, { error: { message: 'invalid key' } }))).ok, false)
})

test('streaming sends config, text and flush in order, yields audio chunks, and reports failures', async () => {
  const sent: { type: string }[] = []
  const script: unknown[][] = [
    [{ type: 'audio', data: { audio: Buffer.from('one').toString('base64') } }, { type: 'audio', data: { audio: Buffer.from('two').toString('base64') } }, { type: 'event', data: { event_type: 'final' } }],
    [{ type: 'error', data: { message: 'bad' } }],
  ]
  class FakeSocket {
    onopen?: () => void; onmessage?: (e: { data: string }) => void; onerror?: () => void; onclose?: () => void
    constructor(url: string, _protocols: string[]) {
      assert.match(url, /^wss:.*text-to-speech\/ws\?model=/); assert.ok(!url.includes('test-key'), 'the key is never in the URL')
      queueMicrotask(() => { this.onopen?.(); for (const m of script.shift()!) this.onmessage?.({ data: JSON.stringify(m) }) })
    }
    send(x: string) { sent.push(JSON.parse(x)) }
    close() {}
  }
  const real = globalThis.WebSocket
  globalThis.WebSocket = FakeSocket as never
  try {
    const c = { ...conn(200, {}), baseUrl: 'https://api.sarvam.test' }
    const got: string[] = []
    for await (const b of adapter.synthesizeStream!(c, 'bulbul:v4-flash', req)) got.push(b.toString())
    assert.deepEqual(got, ['one', 'two'])
    assert.deepEqual(sent.map((x) => x.type), ['config', 'text', 'flush'])
    await assert.rejects((async () => { for await (const _ of adapter.synthesizeStream!(c, 'm', req)) { /* none */ } })(), GatewayError)
  } finally { globalThis.WebSocket = real }
})
