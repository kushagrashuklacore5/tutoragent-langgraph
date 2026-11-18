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

export function pickVoice<V extends { lang: string; name: string; localService?: boolean }>(voices: V[], lang: VoiceLang): V | null {
  for (const tag of voiceTags(lang)) {
    const t = tag.toLowerCase()
    const exact = voices.filter((v) => v.lang.toLowerCase().replace('_', '-') === t || v.lang.toLowerCase().replace('_', '-').startsWith(t + '-'))
    if (exact.length) return exact.find((v) => v.localService) ?? exact[0]!
  }
  return null
}

/** Speak a sequence of texts; returns a cancel function. Starting new speech or recording cancels (barge-in). */
export function speak(texts: string[], lang: VoiceLang, onEnd?: () => void): () => void {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined
  if (!synth) { onEnd?.(); return () => {} }
  synth.cancel()
  const voice = pickVoice(synth.getVoices(), lang)
  const parts = texts.map(speakable).filter(Boolean)
  parts.forEach((t, i) => {
    const u = new SpeechSynthesisUtterance(t)
    if (voice) u.voice = voice
    u.lang = voice?.lang ?? voiceTags(lang)[0]!
    if (i === parts.length - 1) u.onend = () => onEnd?.()
    synth.speak(u)
  })
  if (!parts.length) onEnd?.()
  return () => synth.cancel()
}

export const stopSpeaking = () => { if (typeof window !== 'undefined') window.speechSynthesis?.cancel() }
export const canRecord = () => typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'
export const canSpeak = () => typeof window !== 'undefined' && 'speechSynthesis' in window

/** Preferred recording container supported by this browser (the server sniffs the content anyway). */
export function recordingType(): string | undefined {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t
  return undefined
}
