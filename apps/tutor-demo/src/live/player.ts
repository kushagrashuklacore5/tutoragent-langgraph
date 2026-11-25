import { pickVoice } from '../../../web/src/lib/voice.ts'
import { featuresFrom, type AudioFeatures } from './lipsync.ts'
import { DemoError, post, S, streamSpeech } from '../lib/client.ts'
import { actionFor, phaseAt, phasesFor, type Action, type Gaze, type Phase } from './choreography.ts'
import { estimateSeconds, visemeTrack, type VisemeCue } from './visemes.ts'

export interface Segment { id: string; blockId: string; pageNo: number; type: string; speech: string; token: string; board?: string }
export type VoiceKind = 'sarvam' | 'device' | 'captions'
export type Status = 'idle' | 'loading' | 'playing' | 'paused' | 'ended'

export interface PlayerEvents {
  segment(seg: Segment, index: number): void
  frame(seg: Segment, fraction: number, phase: Phase): void
  beat(action: Action, gaze: Gaze, count?: number): void
  speech(feed: { cues: VisemeCue[]; clock: () => number; level: () => number | null; tilt?: () => number | null; features?: () => AudioFeatures | null } | null): void
  status(s: Status): void
  voice(v: VoiceKind): void
  finished(): void
}

interface Voiced { duration: number; clock(): number; level(): number | null; tilt?(): number | null; features?(): AudioFeatures | null; pause(): void; resume(): void; stop(): void; done: Promise<void> }

/** the audio's real loudness and brightness, read from the same signal the student hears */
function connectMeter(a: HTMLAudioElement, ctx: AudioContext | null) {
  let analyser: AnalyserNode | null = null
  let source: MediaElementAudioSourceNode | null = null
  // 1024-point FFT (≈21 ms at 48 kHz): fine enough to find the first two formants, short enough to follow speech
  const wave = new Uint8Array(1024), freq = new Uint8Array(512)
  if (ctx) { try { source = ctx.createMediaElementSource(a); analyser = ctx.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0.2; source.connect(analyser); analyser.connect(ctx.destination) } catch { analyser = null } }
  return {
    level: () => { if (!analyser || a.muted) return null; analyser.getByteTimeDomainData(wave); let s = 0; for (const x of wave) { const v = (x - 128) / 128; s += v * v } return Math.sqrt(s / wave.length) },
    tilt: () => {
      if (!analyser || a.muted) return null
      analyser.getByteFrequencyData(freq)
      const hz = ctx!.sampleRate / analyser.fftSize
      const sum = (lo: number, hi: number) => { let n = 0; for (let i = Math.round(lo / hz); i <= Math.min(freq.length - 1, Math.round(hi / hz)); i++) n += freq[i]!; return n }
      const low = sum(200, 1000), high = sum(2000, 6000)
      return low + high ? high / (low + high) : null
    },
    /** acoustic features of the sound being heard right now (for the mouth class), from the same analyser frame */
    features: (): AudioFeatures | null => {
      if (!analyser || a.muted) return null
      analyser.getByteTimeDomainData(wave); let s = 0; for (const x of wave) { const v = (x - 128) / 128; s += v * v }
      analyser.getByteFrequencyData(freq)
      return featuresFrom(freq, ctx!.sampleRate, analyser.fftSize, Math.sqrt(s / wave.length))
    },
    close: () => { try { source?.disconnect(); analyser?.disconnect() } catch { /* already closed */ } },
  }
}

function audioVoice(blob: Blob, ctx: AudioContext | null, muted: () => boolean): Promise<Voiced> {
  const url = URL.createObjectURL(blob)
  const a = new Audio(url)
  a.muted = muted()
  const meter = connectMeter(a, ctx)
  const clean = () => { a.pause(); meter.close(); URL.revokeObjectURL(url) }
  return new Promise((resolve, reject) => {
    a.onerror = () => { clean(); reject(new DemoError('audio_failed', 'The audio could not be played.')) }
    a.onloadedmetadata = () => {
      let finish: () => void = () => undefined
      const done = new Promise<void>((r) => { finish = r })
      a.onended = () => { clean(); finish() }
      a.onerror = () => { clean(); finish() }
      a.play().then(() => resolve({
        duration: Number.isFinite(a.duration) ? a.duration : estimateSeconds(''), clock: () => a.currentTime, level: meter.level, tilt: meter.tilt, features: meter.features,
        pause: () => a.pause(), resume: () => { void a.play() }, stop: () => { clean(); finish() }, done,
      }), (e) => { clean(); reject(e) })
    }
  })
}

const canStream = () => typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mpeg')

/** plays chunks as they arrive; browsers without MP3 MediaSource (and any failure before sound) use the full request */
async function streamedVoice(chunks: AsyncIterable<Uint8Array>, ctx: AudioContext | null, muted: () => boolean, estimate: number, saved: (whole: Blob) => void): Promise<Voiced> {
  const ms = new MediaSource()
  const url = URL.createObjectURL(ms)
  const a = new Audio(url)
  a.muted = muted()
  const meter = connectMeter(a, ctx)
  let finish: () => void = () => undefined
  const done = new Promise<void>((r) => { finish = r })
  let stopped = false
  const clean = () => { if (stopped) return; stopped = true; a.pause(); meter.close(); URL.revokeObjectURL(url); finish() }
  await new Promise<void>((r) => ms.addEventListener('sourceopen', () => r(), { once: true }))
  const sb = ms.addSourceBuffer('audio/mpeg')
  const pending: Uint8Array[] = [], all: Uint8Array[] = []
  let inputDone = false
  const pump = () => {
    if (stopped || sb.updating || ms.readyState !== 'open') return
    const next = pending.shift()
    if (next) { try { sb.appendBuffer(next as BufferSource) } catch { inputDone = true; pending.length = 0; try { ms.endOfStream() } catch { /* already ended */ } } return }
    if (inputDone) { try { ms.endOfStream() } catch { /* already ended */ } }
  }
  sb.addEventListener('updateend', pump)
  const voiced: Voiced = { duration: estimate, clock: () => a.currentTime, level: meter.level, tilt: meter.tilt, features: meter.features, pause: () => a.pause(), resume: () => { void a.play() }, stop: clean, done }
  ms.addEventListener('sourceended', () => { if (Number.isFinite(a.duration) && a.duration > 0) voiced.duration = a.duration })
  a.onended = clean
  a.onerror = clean
  let firstChunk: () => void = () => undefined, firstFail: (e: unknown) => void = () => undefined
  const started = new Promise<void>((ok, no) => { firstChunk = ok; firstFail = no })
  void (async () => {
    try {
      for await (const c of chunks) { if (stopped) return; pending.push(c); all.push(c); pump(); firstChunk() }
      if (all.length) saved(new Blob(all as BlobPart[], { type: 'audio/mpeg' }))
    } catch (e) { if (!all.length) firstFail(e) } // after sound has started she finishes what already arrived
    inputDone = true
    if (!all.length) firstFail(new DemoError('audio_failed', 'No audio arrived.'))
    pump()
  })()
  try {
    await started
    await new Promise<void>((ok, no) => {
      const t = window.setTimeout(() => no(new DemoError('audio_failed', 'The audio could not start.')), 6_000)
      a.addEventListener('canplay', () => { window.clearTimeout(t); ok() }, { once: true })
    })
    await a.play()
  } catch (e) { clean(); throw e }
  return voiced
}

/** browser voice: no access to the audio, so lips follow the estimated track and resync at word boundaries */
function deviceVoice(text: string, language: string, muted: () => boolean): Voiced | null {
  const syn = typeof window !== 'undefined' ? window.speechSynthesis : undefined
  if (!syn || muted()) return null
  const voices = syn.getVoices()
  const v = pickVoice(voices, language === 'en' ? 'en' : 'hi')
  if (!v) return null
  const duration = estimateSeconds(text)
  const u = new SpeechSynthesisUtterance(text)
  u.voice = v; u.lang = v.lang; u.rate = 0.98
  let started = performance.now(), pausedAt = 0, offset = 0
  let finish: () => void = () => undefined
  const done = new Promise<void>((r) => { finish = r })
  u.onend = () => finish(); u.onerror = () => finish()
  u.onstart = () => { started = performance.now() }
  u.onboundary = (e) => { if (e.name === 'word') { offset = (e.charIndex / Math.max(1, text.length)) * duration - (performance.now() - started) / 1000 } }
  syn.cancel(); syn.speak(u)
  return {
    duration, clock: () => (pausedAt ? pausedAt - started : performance.now() - started) / 1000 + offset, level: () => null,
    pause: () => { pausedAt = performance.now(); syn.pause() }, resume: () => { started += performance.now() - pausedAt; pausedAt = 0; syn.resume() },
    stop: () => { u.onend = null; u.onerror = null; syn.cancel(); finish() }, done,
  }
}

/** no audio at all (muted or nothing available): captions and board still run on a truthful estimated clock */
function captionsVoice(text: string): Voiced {
  const duration = estimateSeconds(text)
  let elapsed = 0, last = performance.now(), paused = false, timer = 0
  let finish: () => void = () => undefined
  const done = new Promise<void>((r) => { finish = r })
  const tick = () => { const n = performance.now(); if (!paused) elapsed += (n - last) / 1000; last = n; if (elapsed >= duration) { window.clearInterval(timer); finish() } }
  timer = window.setInterval(tick, 60)
  return { duration, clock: () => elapsed, level: () => null, pause: () => { tick(); paused = true }, resume: () => { last = performance.now(); paused = false }, stop: () => { window.clearInterval(timer); finish() }, done }
}

/**
 * Coordinates audio, visemes, gestures and board for one list of segments. Every run has a generation number:
 * anything that belongs to an older run stops itself, so old audio or board actions can never continue.
 */
export class LivePlayer {
  private gen = 0
  private current: Voiced | null = null
  private ctx: AudioContext | null = null
  private audio = new Map<string, Promise<Blob>>()
  private fetches = new AbortController()
  private raf = 0
  private serverVoiceOff = false
  muted = false
  status: Status = 'idle'

  private bookId: string
  private language: string
  private on: PlayerEvents

  constructor(bookId: string, language: string, on: PlayerEvents) {
    this.bookId = bookId
    this.language = language
    this.on = on
  }

  /** must be called from a user gesture so the browser allows sound */
  unlock() {
    try { this.ctx ??= new AudioContext(); void this.ctx.resume() } catch { this.ctx = null }
  }
  private set(s: Status) { this.status = s; this.on.status(s) }
  private blob(token: string): Promise<Blob> {
    let p = this.audio.get(token)
    if (!p) {
      p = post<{ audio: string; mimeType: string }>(`${S}/books/${this.bookId}/live/speech`, { token }, 45_000, this.fetches.signal).then((r) => {
        const bin = atob(r.audio), bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        return new Blob([bytes], { type: r.mimeType })
      })
      p.catch(() => this.audio.delete(token))
      this.audio.set(token, p)
    }
    return p
  }

  private async voice(seg: Segment, gen: number): Promise<Voiced | null> {
    if (!this.muted && !this.serverVoiceOff) {
      try {
        // not generated yet: stream it, so she starts speaking on the first chunk (the full request stays as the fallback)
        if (canStream() && !this.audio.has(seg.token)) {
          try {
            const v = await streamedVoice(streamSpeech(this.bookId, seg.token, this.fetches.signal), this.ctx, () => this.muted, estimateSeconds(seg.speech), (whole) => this.audio.set(seg.token, Promise.resolve(whole)))
            if (gen !== this.gen) { v.stop(); return null }
            this.on.voice('sarvam')
            return v
          } catch (e) {
            if (gen !== this.gen || (e instanceof DemoError && e.code === 'cancelled')) return null
            if (e instanceof DemoError && e.code === 'session_expired') throw e
          }
        }
        const b = await this.blob(seg.token)
        if (gen !== this.gen) return null
        const v = await audioVoice(b, this.ctx, () => this.muted)
        if (gen !== this.gen) { v.stop(); return null }
        this.on.voice('sarvam')
        return v
      } catch (e) {
        if (gen !== this.gen || (e instanceof DemoError && e.code === 'cancelled')) return null
        if (e instanceof DemoError && e.code === 'session_expired') throw e
        // no server voice configured or a provider failure: stay honest and carry on with the next-best voice
        if (e instanceof DemoError && e.status !== 429) this.serverVoiceOff = true
      }
    }
    const d = deviceVoice(seg.speech, this.language, () => this.muted)
    if (d) { this.on.voice('device'); return d }
    this.on.voice('captions')
    return captionsVoice(seg.speech)
  }

  async play(segments: Segment[], from = 0) {
    this.stop()
    const gen = ++this.gen
    this.fetches = new AbortController()
    this.set('loading')
    for (let i = from; i < segments.length; i++) {
      if (gen !== this.gen) return
      const seg = segments[i]!
      const next = segments[i + 1]
      if (next && !this.muted && !this.serverVoiceOff) void this.blob(next.token).catch(() => undefined) // ready before it is needed
      const input = { type: seg.type, speech: seg.speech, index: i, total: segments.length, board: seg.board }
      const phases = phasesFor(input)
      this.on.segment(seg, i)
      this.on.beat(phases[0]!.action, phases[0]!.gaze, phases[0]!.count)
      const v = await this.voice(seg, gen)
      if (gen !== this.gen) { v?.stop(); return }
      if (!v) return
      this.current = v
      if (this.status === 'loading' || this.status === 'idle') this.set('playing')
      // a stream's length is estimated until its last chunk; the mouth track is rebuilt when the real length is known
      let known = v.duration
      const feed = { cues: visemeTrack(seg.speech, known), clock: v.clock, level: v.level, tilt: v.tilt, features: v.features }
      this.on.speech(feed)
      let shown: Phase | null = null
      const loop = () => {
        if (gen !== this.gen) return
        if (v.duration !== known) { known = v.duration; feed.cues = visemeTrack(seg.speech, known) }
        const f = Math.min(1, v.clock() / Math.max(0.1, v.duration))
        const p = phaseAt(phases, f)
        if (p !== shown) { shown = p; this.on.beat(p.action, p.gaze, p.count) }
        this.on.frame(seg, f, p)
        this.raf = requestAnimationFrame(loop)
      }
      loop()
      await v.done
      cancelAnimationFrame(this.raf)
      if (gen !== this.gen) return
      this.current = null
      this.on.speech(null)
      this.on.frame(seg, 1, phases[phases.length - 1]!)
      if (this.status === 'loading') this.set('playing')
      await new Promise((r) => window.setTimeout(r, actionFor(input) === 'conclude_lesson' ? 120 : 260)) // a teacher's breath between ideas
    }
    if (gen !== this.gen) return
    this.set('ended')
    this.on.finished()
  }

  pause() { if (this.status === 'playing') { this.current?.pause(); this.set('paused') } }
  resume() { if (this.status === 'paused') { this.unlock(); this.current?.resume(); this.set('playing') } }
  /** stops audio and every pending board or gesture action of the current run */
  stop() {
    this.gen++
    this.fetches.abort()
    cancelAnimationFrame(this.raf)
    this.current?.stop()
    this.current = null
    this.on.speech(null)
    if (this.status !== 'idle') this.set('idle')
  }
  setMuted(m: boolean) { this.muted = m }
  dispose() { this.stop(); void this.ctx?.close().catch(() => undefined); this.ctx = null; this.audio.clear() }
}
