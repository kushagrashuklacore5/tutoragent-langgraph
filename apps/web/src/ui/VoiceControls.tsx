import { useEffect, useRef, useState } from 'react'
import { TUTOR, describeError, request } from '../lib/api.ts'
import { canRecord, canSpeak, recordingType } from '../lib/voice.ts'
import { Icon } from './icons.tsx'

const MAX_SECONDS = 120

/**
 * Microphone button: records, uploads to the course's transcription route and hands the transcript back
 * so the student can check it before sending. `onStart` lets the page stop any speech playback (barge-in).
 */
export function MicButton({ courseId, language, disabled, onStart, onText }: { courseId: string; language: string; disabled?: boolean; onStart: () => void; onText: (t: string) => void }) {
  const [state, setState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [secs, setSecs] = useState(0)
  const rec = useRef<MediaRecorder | null>(null)
  const timer = useRef<number | null>(null)
  useEffect(() => () => {
    rec.current?.stream.getTracks().forEach((t) => t.stop())
    if (timer.current) window.clearInterval(timer.current)
  }, [])
  if (!canRecord()) return null

  const stop = () => { if (rec.current?.state === 'recording') rec.current.stop() }
  const start = async () => {
    setError(null)
    onStart()
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    } catch {
      setError('Microphone access was blocked. Allow it in your browser to speak to the tutor.')
      return
    }
    const type = recordingType()
    const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
    const chunks: Blob[] = []
    r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
    r.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop())
      if (timer.current) window.clearInterval(timer.current)
      setState('transcribing')
      try {
        const blob = new Blob(chunks, { type: r.mimeType || 'audio/webm' })
        const lang = language === 'hi' || language === 'en' ? `?language=${language}` : ''
        const j = await request<{ text: string }>('POST', `${TUTOR}/courses/${courseId}/voice/transcribe${lang}`, undefined, { raw: blob, contentType: blob.type })
        if (j.text?.trim()) onText(j.text.trim())
        else setError('Nothing was heard. Try again a little closer to the microphone.')
      } catch (e) {
        setError(describeError(e))
      } finally {
        setState('idle')
      }
    }
    rec.current = r
    r.start()
    setSecs(0)
    setState('recording')
    timer.current = window.setInterval(() => setSecs((s) => {
      if (s + 1 >= MAX_SECONDS) stop()
      return s + 1
    }), 1000)
  }
  const label = state === 'recording' ? `Stop recording (${secs} seconds)` : state === 'transcribing' ? 'Transcribing' : 'Speak your message'
  return (
    <span className="inline-flex flex-col">
      <button type="button" onClick={() => (state === 'recording' ? stop() : void start())} disabled={disabled || state === 'transcribing'} aria-pressed={state === 'recording'} aria-label={label} title={label}
        className={`inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-lg border px-3 ${state === 'recording' ? 'border-danger bg-danger-bg text-danger' : 'border-line-strong bg-surface'} disabled:opacity-50`}>
        <Icon name={state === 'recording' ? 'x' : 'chat'} size={18} />
        <span className="text-sm">{state === 'recording' ? `${secs}s` : state === 'transcribing' ? 'Transcribing…' : 'Speak'}</span>
      </button>
      {error ? <span role="alert" className="mt-1 max-w-64 text-xs text-danger">{error}</span> : null}
    </span>
  )
}

/** Toggle for reading tutor replies aloud (on-device speech synthesis). */
export function ReadAloudToggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  if (!canSpeak()) return null
  return (
    <label className="inline-flex min-h-11 items-center gap-2 text-sm">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
      Read replies aloud
    </label>
  )
}
