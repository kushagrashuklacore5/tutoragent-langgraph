import {
  ensureOk, GatewayError, joinUrl, timed, type ProviderAdapter, type ResolvedConnection, type SynthesizeRequest,
} from '@platform/ai-adapter-kit'

/** Sarvam adapter: text-to-speech only (Bulbul). The API returns base64 audio and documents no word or phoneme timings. */
const MAX_CHARS = 2500
/** a conversational Hindi-English persona; the "teacher" style is the only one the platform asks for */
const TEACHER_VOICE = 'simran_enhi_companion'

const unsupported = (): never => { throw new GatewayError('unsupported_capability', 'Sarvam connections provide speech synthesis only') }
const auth = (c: ResolvedConnection) => ({ 'api-subscription-key': c.apiKey ?? '' })

export function speechBody(model: string, r: SynthesizeRequest) {
  return {
    text: r.text, language_code: r.language, model, speaker: TEACHER_VOICE, pace: Math.min(2, Math.max(0.5, r.pace ?? 1)),
    speech_sample_rate: 24000, output_audio_codec: 'mp3', enable_preprocessing: true,
  }
}

export const adapter: ProviderAdapter = {
  descriptor: {
    type: 'sarvam', version: '1.0.0', displayName: 'Sarvam', operations: ['synthesize'],
    defaultBaseUrl: 'https://api.sarvam.ai', requiresApiKey: true, supportsDiscovery: false, supportsPrivateNetwork: false,
  },
  // an empty text is rejected before synthesis (400) when the key is valid, so testing a connection spends no credits
  async testConnection(c) {
    const r = await timed(async () => {
      const res = await c.http.request({ method: 'POST', url: joinUrl(c.baseUrl, 'text-to-speech'), headers: auth(c), body: { text: '', language_code: 'en-IN', model: 'bulbul:v4-flash' }, timeoutMs: c.timeoutMs })
      if (res.status !== 400) await ensureOk(res, 'Sarvam')
    })
    if (r.error) { const e = r.error as GatewayError; return { ok: false, latencyMs: r.ms, error: { kind: e.kind ?? 'network', message: e.message } } }
    return { ok: true, latencyMs: r.ms }
  },
  generate: async () => unsupported(),
  // eslint-disable-next-line require-yield
  stream: async function* () { unsupported() },
  async synthesize(c, model, r, signal) {
    if (!r.text.trim() || r.text.length > MAX_CHARS) throw new GatewayError('invalid_request', `Speech text must be 1 to ${MAX_CHARS} characters`)
    const res = await c.http.request({ method: 'POST', url: joinUrl(c.baseUrl, 'text-to-speech'), headers: auth(c), body: speechBody(model, r), signal, timeoutMs: c.timeoutMs })
    await ensureOk(res, 'Sarvam')
    const j = await res.json<{ audios?: string[] }>()
    if (!j.audios?.length) throw new GatewayError('provider_error', 'Sarvam: the reply had no audio')
    const audio = Buffer.from(j.audios.join(''), 'base64')
    if (!audio.length) throw new GatewayError('provider_error', 'Sarvam: the reply had empty audio')
    return { audio, mimeType: 'audio/mpeg', usage: { inputTokens: r.text.length, outputTokens: 0, cachedInputTokens: null, reasoningTokens: null } }
  },
  /** Sarvam's documented WebSocket: config, text, flush, then audio messages and a final event. The key never leaves the server. */
  async *synthesizeStream(c, model, r, signal) {
    if (!r.text.trim() || r.text.length > MAX_CHARS) throw new GatewayError('invalid_request', `Speech text must be 1 to ${MAX_CHARS} characters`)
    const url = `${joinUrl(c.baseUrl, 'text-to-speech/ws').replace(/^http/, 'ws')}?model=${encodeURIComponent(model)}&send_completion_event=true`
    const ws = new WebSocket(url, [`api-subscription-key.${c.apiKey ?? ''}`])
    const queue: Buffer[] = []
    let finished = false, failure: GatewayError | null = null, got = false, wake = () => {}
    const end = (e?: GatewayError) => { if (e && !failure) failure = e; finished = true; const w = wake; wake = () => {}; w() }
    const timer = setTimeout(() => end(new GatewayError('timeout', 'Sarvam: the speech stream timed out')), c.timeoutMs)
    const onAbort = () => end(new GatewayError('cancelled', 'Sarvam: speech cancelled'))
    signal?.addEventListener('abort', onAbort, { once: true })
    const { text: _text, model: _model, ...config } = speechBody(model, r)
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'config', data: { ...config, speech_sample_rate: String(config.speech_sample_rate) } }))
      ws.send(JSON.stringify({ type: 'text', data: { text: r.text } }))
      ws.send(JSON.stringify({ type: 'flush' }))
    }
    ws.onmessage = (e) => {
      let m: { type?: string; data?: { audio?: string; event_type?: string } }
      try { m = JSON.parse(String(e.data)) } catch { return }
      if (m.type === 'audio' && m.data?.audio) { got = true; queue.push(Buffer.from(m.data.audio, 'base64')); const w = wake; wake = () => {}; w() }
      else if (m.type === 'event' && m.data?.event_type === 'final') end()
      else if (m.type === 'error') end(new GatewayError('provider_error', 'Sarvam: the speech stream reported an error'))
    }
    ws.onerror = () => end(new GatewayError('network', 'Sarvam: the speech stream could not connect'))
    ws.onclose = () => end(got ? undefined : new GatewayError('provider_error', 'Sarvam: the stream closed without audio'))
    try {
      for (;;) {
        while (queue.length) yield queue.shift()!
        if (failure) throw failure
        if (finished) return
        await new Promise<void>((res) => { wake = res })
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      try { ws.close() } catch { /* already closed */ }
    }
  },
}
export default adapter
