/** Incremental Server-Sent Events parser (text/event-stream), independent of EventSource so POST works. */

export interface SseEvent {
  event: string
  data: string
}

export class SseParser {
  private buf = ''
  private event = ''
  private data: string[] = []

  /** Feed a decoded text chunk; returns the events completed by it. */
  feed(chunk: string): SseEvent[] {
    this.buf += chunk
    const out: SseEvent[] = []
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buf)
      if (!m) break
      // a lone trailing \r may be the first half of \r\n: wait for more input
      if (m[0] === '\r' && m.index === this.buf.length - 1) break
      const line = this.buf.slice(0, m.index)
      this.buf = this.buf.slice(m.index + m[0].length)
      const ev = this.line(line)
      if (ev) out.push(ev)
    }
    return out
  }

  /** Flush at end of stream (a final event without its blank line still counts). */
  end(): SseEvent[] {
    const out: SseEvent[] = []
    if (this.buf) {
      const ev = this.line(this.buf)
      this.buf = ''
      if (ev) out.push(ev)
    }
    const ev = this.line('')
    if (ev) out.push(ev)
    return out
  }

  private line(line: string): SseEvent | null {
    if (line === '') {
      if (!this.data.length) { this.event = ''; return null }
      const ev = { event: this.event || 'message', data: this.data.join('\n') }
      this.event = ''
      this.data = []
      return ev
    }
    if (line.startsWith(':')) return null
    const i = line.indexOf(':')
    const field = i < 0 ? line : line.slice(0, i)
    let value = i < 0 ? '' : line.slice(i + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') this.data.push(value)
    else if (field === 'event') this.event = value
    return null
  }
}

export type TurnStreamEvent =
  | { kind: 'start'; move: string; hintLevel: number; policyNote: string | null }
  | { kind: 'progress'; text: string; index: number | null }
  | { kind: 'turn'; turn: unknown }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'ignore' }

/**
 * Interpret one SSE event of the tutor turn stream. Lenient about the discriminator (`type`/`kind`/`event`)
 * and where the final turn lives (`turn` field, or the event itself when it carries `segments`).
 */
export function interpretTurnEvent(ev: SseEvent): TurnStreamEvent {
  let j: Record<string, unknown>
  try { j = JSON.parse(ev.data) as Record<string, unknown> } catch { return ev.event === 'error' ? { kind: 'error', code: 'stream_error', message: ev.data } : { kind: 'ignore' } }
  if (!j || typeof j !== 'object') return { kind: 'ignore' }
  const type = String(j.type ?? j.kind ?? (ev.event !== 'message' ? ev.event : ''))
  if (ev.event === 'error' || type === 'error') {
    const e = (j.error && typeof j.error === 'object' ? j.error : j) as { code?: unknown; message?: unknown }
    return { kind: 'error', code: typeof e.code === 'string' ? e.code : 'stream_error', message: typeof e.message === 'string' ? e.message : 'The tutor stopped unexpectedly.' }
  }
  if (type === 'turn' || type === 'final' || type === 'done') return { kind: 'turn', turn: j.turn ?? j.data ?? j }
  if (type === 'start') return { kind: 'start', move: String(j.move ?? ''), hintLevel: Number(j.hintLevel) || 0, policyNote: typeof j.policyNote === 'string' ? j.policyNote : null }
  if (type === 'progress' || type === 'delta' || type === 'partial') {
    const text = j.text ?? j.partial ?? j.delta ?? j.content
    const index = Number.isInteger(j.index) ? (j.index as number) : null
    return typeof text === 'string' ? { kind: 'progress', text, index } : { kind: 'ignore' }
  }
  if (Array.isArray(j.segments)) return { kind: 'turn', turn: j }
  return { kind: 'ignore' }
}

/** Draft text of a streamed turn: per-segment deltas (`index`), or one running text (cumulative or delta). */
export class DraftText {
  private parts: string[] = []
  private single = ''
  add(ev: { text: string; index: number | null }): string {
    if (ev.index === null) this.single = applyProgress(this.single, ev.text)
    else this.parts[ev.index] = (this.parts[ev.index] ?? '') + ev.text
    return this.toString()
  }
  toString(): string { return [this.single, ...this.parts].filter(Boolean).join('\n\n') }
}

/** Progress may be cumulative ("partial text so far") or a delta; handle both without duplicating text. */
export function applyProgress(prev: string, text: string): string {
  if (!prev) return text
  if (text.startsWith(prev)) return text
  return prev + text
}
