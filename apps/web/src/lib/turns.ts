import { ApiError, TUTOR, api, isEndpointMissing, toApiError } from './api.ts'
import { DraftText, SseParser, interpretTurnEvent } from './sse.ts'
import { normalizeSegments, type TurnResponse } from './tutor.ts'

export interface TurnInput { message: string; stuck?: boolean; requestFullAnswer?: boolean }

/** Coerce whatever the server sent into a safe TurnResponse. */
export function normalizeTurn(raw: unknown): TurnResponse {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const move = typeof o.move === 'string' ? o.move : 'explain'
  return {
    move: (['ask', 'hint', 'explain', 'worked_solution', 'rescue_probe', 'check'].includes(move) ? move : 'explain') as TurnResponse['move'],
    hintLevel: Math.max(0, Math.min(4, Number(o.hintLevel) || 0)),
    policyNote: typeof o.policyNote === 'string' && o.policyNote ? o.policyNote : null,
    segments: normalizeSegments(o.segments),
    relabelled: Number(o.relabelled) || 0,
    checkQuestion: typeof o.checkQuestion === 'string' && o.checkQuestion ? o.checkQuestion : null,
    ...(o.retrievalDegraded === true ? { retrievalDegraded: true } : {}),
    assessment: (['correct', 'partial', 'incorrect', 'not_an_attempt'].includes(String(o.assessment)) ? o.assessment : 'not_an_attempt') as TurnResponse['assessment'],
  }
}

let streamingUnavailable = false

/**
 * Send a tutor turn. Tries the streaming route first (progress text via `onProgress`); if the server does
 * not have it (404/405) falls back to the plain route and stops trying streaming for this page load.
 */
export interface TurnStart { move: TurnResponse['move']; hintLevel: number; policyNote: string | null }

export async function sendTurn(sessionId: string, input: TurnInput, onProgress: (text: string) => void, signal?: AbortSignal, onStart?: (s: TurnStart) => void): Promise<TurnResponse> {
  const base = `${TUTOR}/sessions/${encodeURIComponent(sessionId)}/turns`
  if (!streamingUnavailable) {
    try {
      return await streamTurn(`${base}/stream`, input, onProgress, signal, onStart)
    } catch (e) {
      if (!isEndpointMissing(e)) throw e
      streamingUnavailable = true
    }
  }
  return normalizeTurn(await api.post<unknown>(base, input, signal))
}

async function streamTurn(url: string, input: TurnInput, onProgress: (text: string) => void, signal?: AbortSignal, onStart?: (s: TurnStart) => void): Promise<TurnResponse> {
  let res: Response
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(input), credentials: 'same-origin', signal })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw toApiError(0, null)
  }
  if (!res.ok) {
    let body: unknown = null
    try { body = await res.json() } catch { /* not json */ }
    throw toApiError(res.status, body)
  }
  // A server that answers JSON (no stream) still yields a turn
  if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) return normalizeTurn(await res.json())
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const parser = new SseParser()
  const draft = new DraftText()
  let final: TurnResponse | null = null
  const handle = (evs: ReturnType<SseParser['feed']>) => {
    for (const ev of evs) {
      const r = interpretTurnEvent(ev)
      if (r.kind === 'start') onStart?.({ move: normalizeTurn({ move: r.move }).move, hintLevel: r.hintLevel, policyNote: r.policyNote })
      else if (r.kind === 'progress') onProgress(draft.add(r))
      else if (r.kind === 'turn') final = normalizeTurn(r.turn)
      else if (r.kind === 'error') throw new ApiError(502, r.code, r.message)
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    handle(parser.feed(decoder.decode(value, { stream: true })))
  }
  handle(parser.feed(decoder.decode()))
  handle(parser.end())
  if (!final) throw new ApiError(502, 'stream_incomplete', 'The tutor stopped before finishing. Please try again.')
  return final
}

// ── past conversations ──
export type Entry = { role: 'student'; text: string; kind?: 'stuck' | 'full' } | { role: 'tutor'; turn: TurnResponse }
export interface SessionSummary { id: string; conceptId: string | null; conceptName: string | null; problem: string | null; graded: boolean; language: string; createdAt: string; lastActivityAt: string; turns: number }
export interface SessionDetail { id: string; courseId: string; conceptId: string | null; problem: string | null; graded: boolean; language: string; turns: unknown[] }

/** Rebuild the on-screen transcript from a stored session (tutor turns go through the same normaliser as live ones). */
export function historyEntries(turns: unknown[]): Entry[] {
  return turns.flatMap((raw): Entry[] => {
    const t = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    if (t.role === 'student') return typeof t.content === 'string' ? [{ role: 'student', text: t.content }] : []
    if (t.role !== 'tutor') return []
    const turn = normalizeTurn({ move: t.move, hintLevel: t.hintLevel, segments: t.segments })
    if (!turn.segments.length && typeof t.content === 'string' && t.content) turn.segments = [{ text: t.content, source: 'uncertain', citations: [] }]
    return [{ role: 'tutor', turn }]
  })
}

/** "Limits — Find lim x->2 …" style title for a session list row. */
export function sessionTitle(s: Pick<SessionSummary, 'conceptName' | 'problem'>): string {
  const p = s.problem?.replace(/\s+/g, ' ').trim()
  const short = p && p.length > 80 ? p.slice(0, 77) + '…' : p
  return [s.conceptName, short].filter(Boolean).join(' — ') || 'General question'
}
