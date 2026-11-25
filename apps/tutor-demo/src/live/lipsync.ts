/**
 * Audio-driven lip-sync for streamed Sarvam speech (pure; unit-tested).
 *
 * Every animation frame reads the spectrum of the SAME audio the student hears (Web Audio analyser on the player) and
 * classifies the sound into a mouth class from its acoustics, not from loudness alone:
 *   silence    → mouth at rest (hard gate: never moves in a pause, closes the frame speech stops)
 *   closed     → M/B/P: voiced murmur with almost no energy above ~1 kHz (lips shut)
 *   fricative  → F/V (low-mid hiss) or S/T/D/SH (high hiss): energy dominated by noise above 3–4 kHz
 *   vowel      → A / E-I / O / U from the first two formants (F1 = how open, F2 = front vs back)
 * The spoken TEXT (any of English, Hindi or Hinglish) supplies the likely sound at that moment; the audio decides the
 * class and corrects the vowel when it is clear. Language-independent acoustics, so Hindi and English work the same.
 * No model, no server, no GPU: one 1024-point FFT per frame, already computed by the browser.
 */
import type { Viseme } from './visemes.ts'

export interface AudioFeatures { rms: number; low: number; f1: number; f2: number; fricLow: number; fricHigh: number; total: number; f1Hz: number; f2Hz: number }
export type SoundClass = 'silence' | 'closed' | 'fricative' | 'vowel'

/** band energies and formant estimates from one analyser frame (byte dB spectrum, 0..255) */
export function featuresFrom(freq: ArrayLike<number>, sampleRate: number, fftSize: number, rms: number): AudioFeatures {
  const hz = sampleRate / fftSize
  const lin = (i: number) => { const v = freq[i] ?? 0; return v <= 0 ? 0 : 10 ** ((v / 255) * 4 - 4) } // byte dB → linear power (approx.)
  const band = (lo: number, hi: number) => { let s = 0; for (let i = Math.max(1, Math.round(lo / hz)); i <= Math.min(freq.length - 1, Math.round(hi / hz)); i++) s += lin(i); return s }
  const peak = (lo: number, hi: number) => {
    let best = lo, val = -1
    for (let i = Math.max(1, Math.round(lo / hz)); i <= Math.min(freq.length - 1, Math.round(hi / hz)); i++) { const v = lin(i - 1) + 2 * lin(i) + lin(i + 1); if (v > val) { val = v; best = i * hz } }
    return best
  }
  const low = band(80, 350), f1 = band(350, 1000), f2 = band(1000, 2800), fricLow = band(2800, 4500), fricHigh = band(4500, 8000)
  return { rms, low, f1, f2, fricLow, fricHigh, total: low + f1 + f2 + fricLow + fricHigh, f1Hz: peak(250, 1000), f2Hz: peak(800, 2800) }
}

/** speech floor of this voice (adapts), so a quiet recording is not read as silence */
export class SilenceGate {
  private floor = 0.012
  private peak = 0.08
  /** true while the frame is speech; opens fast and closes within one frame of real silence */
  update(rms: number, dt: number): boolean {
    this.peak = Math.max(0.03, rms > this.peak ? rms : this.peak - (this.peak - 0.03) * Math.min(1, dt * 0.3))
    if (rms < this.floor * 1.6) this.floor += (rms - this.floor) * Math.min(1, dt * 2)
    return rms > Math.max(0.012, this.floor * 2.2, this.peak * 0.12)
  }
}

export function classify(f: AudioFeatures, speaking: boolean): SoundClass {
  if (!speaking || f.total <= 0) return 'silence'
  const fric = (f.fricLow + f.fricHigh) / f.total
  const above = (f.f1 + f.f2) / f.total
  // hiss dominates and the low (voicing) band is weak → a fricative or sibilant
  if (fric > 0.42 && f.low / f.total < 0.35) return 'fricative'
  // voiced but nearly nothing above the murmur band → lips closed (m, b, p hold, the nasal "n" of Hindi "hain")
  if (f.low / f.total > 0.62 && above < 0.25) return 'closed'
  return 'vowel'
}
/** the vowel the formants point to, or null when they are not clear enough to overrule the text */
export function vowelFrom(f: AudioFeatures): Viseme | null {
  const open = f.f1Hz, front = f.f2Hz
  if (f.f1 + f.f2 < f.total * 0.35) return null
  if (open >= 650) return 'aa' // a / aa / आ: jaw open
  if (open <= 450 && front >= 1800) return 'ee' // i / e / ई / ए: spread
  if (open <= 450 && front <= 1100) return 'oo' // u / ऊ: rounded, closed
  if (front <= 1300) return 'oh' // o / ओ: rounded, half open
  return null
}

const VOWELS = new Set<Viseme>(['aa', 'ee', 'oo', 'oh'])
/**
 * One frame's mouth shape: the audio's class always wins (silence and closure are never overruled by text);
 * inside a vowel or fricative the text's sound is kept when it agrees, the formants correct it when they are clear.
 */
export function fuse(text: Viseme, cls: SoundClass, f: AudioFeatures | null): Viseme {
  if (cls === 'silence') return 'rest'
  if (cls === 'closed') return 'mbp'
  if (cls === 'fricative') return text === 'fv' ? 'fv' : f && f.fricLow > f.fricHigh * 1.3 ? 'fv' : 'td'
  const heard = f ? vowelFrom(f) : null
  if (VOWELS.has(text)) return heard ?? text
  // consonant in the text but a clear vowel in the audio: the audio is right (the estimate is a little early or late)
  if (heard) return heard
  return text === 'rest' || text === 'mbp' ? 'aa' : text
}

/** Delay between the audio and the mouth, measured on the live signal (speech onsets and offsets). */
export class LipLatency {
  private speaking = false
  private open = false
  private onsetAt = 0
  private offsetAt = 0
  readonly onsets: number[] = []
  readonly offsets: number[] = []
  /** `speech` = the audio frame is speech; `mouthOpen` = the drawn mouth is visibly open */
  frame(now: number, speech: boolean, mouthOpen: boolean) {
    if (speech && !this.speaking) this.onsetAt = now
    if (!speech && this.speaking) this.offsetAt = now
    if (mouthOpen && !this.open && speech) this.onsets.push(now - this.onsetAt)
    if (!mouthOpen && this.open && !speech) this.offsets.push(now - this.offsetAt)
    this.speaking = speech
    this.open = mouthOpen
  }
  summary() {
    const med = (x: number[]) => { if (!x.length) return null; const s = [...x].sort((a, b) => a - b); return Math.round(s[Math.floor(s.length / 2)]!) }
    const p95 = (x: number[]) => { if (!x.length) return null; const s = [...x].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!) }
    return { onsets: this.onsets.length, onsetMedianMs: med(this.onsets), onsetP95Ms: p95(this.onsets), offsets: this.offsets.length, offsetMedianMs: med(this.offsets), offsetP95Ms: p95(this.offsets) }
  }
}

/**
 * The mouth artwork the renderer can use. The supplied Vidya image has ONE closed, smiling mouth and open eyes only,
 * so none of these exist yet: the renderer draws a shape only when its file is in rig.json (never a generated face).
 */
export const MOUTH_ASSETS: Record<Viseme, string> = {
  rest: 'mouth-rest.png', mbp: 'mouth-mbp.png', fv: 'mouth-fv.png', aa: 'mouth-a.png', ee: 'mouth-e-i.png',
  oo: 'mouth-u.png', oh: 'mouth-o.png', l: 'mouth-l.png', td: 'mouth-t-d-s.png', kg: 'mouth-k-g.png',
}
