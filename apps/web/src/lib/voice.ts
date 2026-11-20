/**
 * Voice I/O helpers. Speech input goes to the server's transcription task (provider-neutral); speech
 * output uses the browser's SpeechSynthesis, so reply audio is generated on the device (free, offline,
 * Hindi voices on most systems). Pure helpers are unit-tested; browser APIs are feature-detected.
 */
export type VoiceLang = 'en' | 'hi' | 'hinglish'

/** Text suitable for reading aloud: no markdown symbols, links or code fences; maths spoken plainly. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_#>`|]/g, '')
    .replace(/\$([^$]+)\$/g, '$1')
    .replace(/\^2\b/g, ' squared').replace(/\^3\b/g, ' cubed').replace(/\^/g, ' to the power ')
    .replace(/\s*=\s*/g, ' equals ').replace(/(\d)\s*\/\s*(\d)/g, '$1 over $2')
    .replace(/\s+/g, ' ').trim()
}

/** BCP-47 tags in preference order for a tutor language. Hinglish is read by an Indian-English voice. */
export function voiceTags(lang: VoiceLang): string[] {
  return lang === 'hi' ? ['hi-IN', 'hi'] : ['en-IN', 'en-GB', 'en-US', 'en']
}

/**
 * Voice quality ranking (researched): the best free Indian voices are the neural "Online (Natural)" voices in
 * Microsoft Edge (en-IN Neerja/Prabhat, hi-IN Swara/Madhur), then Google's हिन्दी/English (India) voices in Chrome,
 * then the Windows desktop voices (Heera, Ravi, Kalpana, Hemant). Anything else is a last resort: we never just take
 * the browser default. A voice the student picked in Settings always wins.
 */
const GOOD = /(neerja|prabhat|swara|madhur|aarav|ananya|kavya|google .*(india|हिन्दी|hindi)|heera|ravi|kalpana|hemant|rishi|lekha|veena)/i
export function voiceScore(v: { lang: string; name: string; localService?: boolean }, lang: VoiceLang): number {
  const tag = v.lang.toLowerCase().replace('_', '-')
  const tags = voiceTags(lang).map((t) => t.toLowerCase())
  const i = tags.findIndex((t) => tag === t || tag.startsWith(t + '-'))
  if (i < 0) return -1
  let s = 100 - i * 30
  if (/natural|neural|online/i.test(v.name)) s += 40
  if (GOOD.test(v.name)) s += 25
  if (/espeak|robot|novelty|whisper|zarvox|bad news|bells/i.test(v.name)) s -= 80
  return s
}
const PICK_KEY = 'ebs.voiceName'
export function preferredVoiceName(): string | null { try { return localStorage.getItem(PICK_KEY) } catch { return null } }
export function setPreferredVoiceName(name: string | null) { try { if (name) localStorage.setItem(PICK_KEY, name); else localStorage.removeItem(PICK_KEY) } catch { /* private mode */ } }

export function rankVoices<V extends { lang: string; name: string; localService?: boolean }>(voices: V[], lang: VoiceLang): V[] {
  return voices.map((v) => ({ v, s: voiceScore(v, lang) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).map((x) => x.v)
}
export function pickVoice<V extends { lang: string; name: string; localService?: boolean }>(voices: V[], lang: VoiceLang, preferred: string | null = null): V | null {
  const ranked = rankVoices(voices, lang)
  return (preferred ? ranked.find((v) => v.name === preferred) : undefined) ?? ranked[0] ?? null
}

/** Long utterances are cut off by some engines (~15 s): speak sentence-sized chunks. */
export function chunks(text: string, max = 220): string[] {
  const out: string[] = []
  for (const sentence of text.match(/[^.!?।]+[.!?।]*\s*/g) ?? [text]) {
    let rest = sentence.trim()
    while (rest.length > max) { const cut = rest.lastIndexOf(' ', max); out.push(rest.slice(0, cut > 40 ? cut : max)); rest = rest.slice(cut > 40 ? cut + 1 : max) }
    if (rest) out.push(rest)
  }
  return out
}

/** Speak a sequence of texts; returns a cancel function. Starting new speech or recording cancels (barge-in). */
export function speak(texts: string[], lang: VoiceLang, onEnd?: () => void): () => void {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined
  if (!synth) { onEnd?.(); return () => {} }
  synth.cancel()
  const voice = pickVoice(synth.getVoices(), lang, preferredVoiceName())
  const parts = texts.map(speakable).filter(Boolean).flatMap((t) => chunks(t))
  let cancelled = false
  parts.forEach((t, i) => {
    const u = new SpeechSynthesisUtterance(t)
    if (voice) u.voice = voice
    u.lang = voice?.lang ?? voiceTags(lang)[0]!
    u.rate = lang === 'en' ? 0.98 : 0.95
    if (i === parts.length - 1) u.onend = () => { if (!cancelled) onEnd?.() }
    synth.speak(u)
  })
  if (!parts.length) onEnd?.()
  return () => { cancelled = true; synth.cancel() }
}
/** Pause/resume the current speech without losing the place (interruption, then resume). */
export const pauseSpeaking = () => { if (typeof window !== 'undefined') window.speechSynthesis?.pause() }
export const resumeSpeaking = () => { if (typeof window !== 'undefined') window.speechSynthesis?.resume() }
export const isPaused = () => typeof window !== 'undefined' && !!window.speechSynthesis?.paused

export const stopSpeaking = () => { if (typeof window !== 'undefined') window.speechSynthesis?.cancel() }
export const canRecord = () => typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'
export const canSpeak = () => typeof window !== 'undefined' && 'speechSynthesis' in window

/** Preferred recording container supported by this browser (the server sniffs the content anyway). */
export function recordingType(): string | undefined {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t
  return undefined
}
