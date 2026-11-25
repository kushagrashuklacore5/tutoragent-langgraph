/** Microphone capture for Raise Hand. Audio goes only to the server's transcribe endpoint; nothing is kept here. */
export type MicProblem = 'unsupported' | 'denied' | 'no_device' | 'too_short' | 'failed'

export const MIC_MESSAGE: Record<MicProblem, string> = {
  unsupported: 'Voice input is not available in this browser. Please type your question.',
  denied: 'Microphone access is blocked. Allow it in your browser settings, or type your question.',
  no_device: 'No microphone was found. Please type your question.',
  too_short: 'That was too short to hear. Please try again.',
  failed: 'The microphone could not start. Please try again, or type your question.',
}
export function micProblem(e: unknown): MicProblem {
  const n = (e as { name?: string } | null)?.name
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'denied'
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'no_device'
  return 'failed'
}
export class MicError extends Error {
  problem: MicProblem
  constructor(problem: MicProblem) { super(MIC_MESSAGE[problem]); this.problem = problem }
}
/** webm on Chrome/Firefox/Android, mp4 on Safari/iOS */
export const pickMime = (ok: (t: string) => boolean) => ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find(ok) ?? ''
export const MAX_RECORD_MS = 60_000

export class MicRecorder {
  private rec: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private chunks: Blob[] = []
  private startedAt = 0
  private cancelled = false

  async start() {
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) throw new MicError('unsupported')
    try { this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }) } catch (e) { throw new MicError(micProblem(e)) }
    if (this.cancelled) { this.release(); return }
    const mimeType = pickMime((t) => MediaRecorder.isTypeSupported(t))
    this.rec = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined)
    this.chunks = []
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data) }
    this.rec.start()
    this.startedAt = performance.now()
  }
  stop(): Promise<Blob> {
    const r = this.rec
    if (!r || r.state === 'inactive') { this.release(); return Promise.reject(new MicError('too_short')) }
    return new Promise((resolve, reject) => {
      r.onstop = () => {
        const held = performance.now() - this.startedAt
        const blob = new Blob(this.chunks, { type: r.mimeType || 'audio/webm' })
        this.release()
        if (held < 500 || blob.size < 500) reject(new MicError('too_short')); else resolve(blob)
      }
      r.stop()
    })
  }
  cancel() {
    this.cancelled = true
    if (this.rec && this.rec.state !== 'inactive') { this.rec.onstop = null; this.rec.stop() }
    this.release()
  }
  private release() { this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null; this.rec = null; this.chunks = [] }
}
