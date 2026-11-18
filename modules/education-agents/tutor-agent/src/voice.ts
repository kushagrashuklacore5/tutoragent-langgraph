import { badRequest } from '@platform/core'
import type { ModuleDeps, RouteDef, TaskDefinition } from '@platform/contracts'
import { P, requireEnrolled, uuid } from './common.ts'

/**
 * Voice input for the Tutor: speech-to-text through the gateway (provider-neutral; Whisper on Groq is
 * one deployment option). Audio is processed in memory and never stored; the transcript is returned to
 * the student, who sends it as a normal tutor turn (so every teaching, grounding and integrity rule applies
 * unchanged). Speech output uses the browser's speech synthesis, so no audio of the tutor's reply leaves
 * the device.
 */
export const TRANSCRIBE_TASK = 'education.tutor.transcribe'
export const VOICE_TASKS: TaskDefinition[] = [{
  id: TRANSCRIBE_TASK, owner: 'education.tutor', category: 'speech_to_text',
  requires: { operation: 'transcribe' }, dataClass: 'student_content', determinism: 'flexible', fallback: 'eligible_only',
}]

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024 // ~10 min of compressed speech
const LANGS = new Set(['en', 'hi'])

/** Detect the container from magic bytes; the declared content type alone is not trusted. */
export function sniffAudio(b: Buffer): string | null {
  if (b.length < 12) return null
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'audio/webm'
  if (b.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg'
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav'
  if (b.toString('ascii', 4, 8) === 'ftyp') return 'audio/mp4'
  if (b.toString('ascii', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)) return 'audio/mpeg'
  return null
}

export function voiceRoutes(d: ModuleDeps): RouteDef[] {
  return [{
    method: 'POST', path: '/courses/:courseId/voice/transcribe', permission: P.study, rawBody: { maxBytes: MAX_AUDIO_BYTES },
    handler: async ({ principal, params, query, body }) => {
      const courseId = uuid(params.courseId, 'courseId')
      if (!Buffer.isBuffer(body) || body.length < 100) throw badRequest('audio_required', 'Send the recording as the request body')
      const mimeType = sniffAudio(body) // by content, never by the declared type
      if (!mimeType) throw badRequest('audio_invalid', 'Unsupported audio format (use webm, ogg, wav, mp3 or m4a)')
      const language = query.get('language')
      const course = await d.inTenant(principal, (t) => requireEnrolled(t, principal, courseId))
      const r = await d.ai(principal).transcribe(TRANSCRIBE_TASK, {
        audio: body, mimeType, language: language && LANGS.has(language) ? language : undefined, prompt: `${course.title}.`,
      })
      return { text: r.text.slice(0, 8000), language: r.language, durationSec: r.durationSec }
    },
  }]
}

