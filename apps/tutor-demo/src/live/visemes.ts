/**
 * Text-derived mouth shapes. Sarvam returns no phoneme timings, so this is an ESTIMATE: the sounds come from the real
 * spoken text and are spread over the real audio's duration. The player scales mouth opening by the real audio level.
 * Replaceable: any provider with true timings can supply a `VisemeCue[]` directly.
 */
export type Viseme = 'rest' | 'mbp' | 'fv' | 'aa' | 'ee' | 'oo' | 'oh' | 'l' | 'td' | 'kg'
export interface VisemeCue { t: number; v: Viseme }

const LATIN: Record<string, Viseme> = { a: 'aa', e: 'ee', i: 'ee', y: 'ee', o: 'oh', u: 'oo', w: 'oo', m: 'mbp', b: 'mbp', p: 'mbp', f: 'fv', v: 'fv', l: 'l', r: 'l', t: 'td', d: 'td', n: 'td', s: 'td', z: 'td', c: 'kg', k: 'kg', g: 'kg', q: 'kg', j: 'td', x: 'kg', h: 'aa' }
const DEVA_GROUPS: [string, Viseme][] = [
  ['अआाहऑ', 'aa'], ['इईिीएऐेैयऍ', 'ee'], ['उऊुू', 'oo'], ['ओऔोौॉ', 'oh'], ['पबभम', 'mbp'], ['फव', 'fv'], ['लर', 'l'],
  ['तथदधनटठडढणसशषजझचछ', 'td'], ['कखगघङ', 'kg'],
]
const DEVA: Record<string, Viseme> = Object.fromEntries(DEVA_GROUPS.flatMap(([chars, v]) => [...chars].map((c) => [c, v])))
/** relative length of a sound: vowels last longer than stops; punctuation is a pause */
const weight = (v: Viseme) => (v === 'aa' || v === 'ee' || v === 'oo' || v === 'oh' ? 1.5 : v === 'rest' ? 1 : 0.8)
const PAUSE: Record<string, number> = { ',': 2.2, ';': 2.6, ':': 2.6, '.': 4.5, '?': 4.5, '!': 4.5, '।': 4.5, ' ': 0.7 }

export function soundsOf(text: string): { v: Viseme; w: number }[] {
  const out: { v: Viseme; w: number }[] = []
  for (const ch of text.toLowerCase().normalize('NFC')) {
    const pause = PAUSE[ch]
    if (pause !== undefined) { const last = out.at(-1); if (last?.v === 'rest') last.w = Math.max(last.w, pause); else out.push({ v: 'rest', w: pause }); continue }
    const v = LATIN[ch] ?? DEVA[ch] ?? (/\d/.test(ch) ? 'ee' : null)
    if (!v) continue
    const last = out.at(-1)
    if (last?.v === v) last.w += weight(v) * 0.6
    else out.push({ v, w: weight(v) })
  }
  return out
}

export function visemeTrack(text: string, durationSec: number): VisemeCue[] {
  const s = soundsOf(text)
  const total = s.reduce((n, x) => n + x.w, 0)
  if (!total || !(durationSec > 0)) return [{ t: 0, v: 'rest' }]
  let at = 0
  const cues = s.map((x) => { const c: VisemeCue = { t: (at / total) * durationSec, v: x.v }; at += x.w; return c })
  cues.push({ t: durationSec, v: 'rest' })
  return cues
}

export function visemeAt(cues: VisemeCue[], t: number): Viseme {
  let lo = 0, hi = cues.length - 1
  if (!cues.length || t < cues[0]!.t) return 'rest'
  while (lo < hi) { const m = Math.ceil((lo + hi) / 2); if (cues[m]!.t <= t) lo = m; else hi = m - 1 }
  return cues[lo]!.v
}

/** mouth geometry per shape: open (jaw), wide (lip corners), round (lip pucker) */
export const MOUTH: Record<Viseme, { open: number; wide: number; round: number }> = {
  rest: { open: 0, wide: 0, round: 0 }, mbp: { open: 0, wide: -0.05, round: 0 }, fv: { open: 0.12, wide: 0.05, round: 0 },
  aa: { open: 1, wide: 0.15, round: 0 }, ee: { open: 0.35, wide: 0.75, round: 0 }, oo: { open: 0.35, wide: -0.55, round: 1 },
  oh: { open: 0.7, wide: -0.3, round: 0.7 }, l: { open: 0.4, wide: 0.2, round: 0 }, td: { open: 0.22, wide: 0.3, round: 0 }, kg: { open: 0.38, wide: 0.1, round: 0.05 },
}

/** Loudness scaled to this voice (quiet floor to recent peak), 0..1. It measures sound, it does not recognise phonemes. */
export class LevelFollower {
  private peak = 0.09
  private value = 0
  update(level: number, dt: number) {
    this.peak = Math.max(0.05, level > this.peak ? level : this.peak - (this.peak - 0.05) * Math.min(1, dt * 0.4))
    const target = Math.max(0, Math.min(1, (level - 0.018) / (this.peak * 0.82 - 0.018))) ** 0.75
    this.value += (target - this.value) * (1 - Math.exp(-(target > this.value ? 70 : 64) * dt))
    return this.value
  }
}
/** Keeps the text-estimated sounds near the real audio: slows through real pauses, never drifts more than a fraction of a second. */
export class VoicedClock {
  private t = 0
  advance(real: number, voiced: boolean, dt: number) {
    this.t += dt * (voiced ? 1.06 : 0.35)
    this.t = Math.max(real - 0.22, Math.min(real + 0.1, this.t))
    return this.t
  }
}
/** Text gives the likely shape; real loudness decides how open it is; real brightness leans it wider or rounder. */
export function mouthFromAudio(shape: { open: number; wide: number; round: number }, level: number, tilt: number | null) {
  const lean = tilt === null ? 0 : Math.max(-1, Math.min(1, (tilt - 0.32) * 3))
  const closure = shape === MOUTH.mbp ? 0.12 : 1
  return { open: level < 0.08 ? 0 : level * closure * (0.55 + 0.45 * shape.open), wide: shape.wide + lean * 0.22, round: Math.max(0, shape.round * (1 - Math.max(0, lean) * 0.5)) }
}

/** Rough spoken length, used only when no audio exists (captions mode). */
export const estimateSeconds = (text: string) => Math.max(1.6, soundsOf(text).reduce((n, x) => n + x.w, 0) * 0.062)
