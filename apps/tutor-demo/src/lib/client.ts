/**
 * The demo's only door to the existing Tutor API. Bearer token only (no cookies), a dedicated demo identity, timeouts,
 * and honest errors. Sign-in uses the platform's existing magic-link flow, which hands the link back ONLY on a local
 * development server; on any other deployment the demo reports that guest access is not enabled.
 */
import { SseParser } from '../../../web/src/lib/sse.ts'
import type { AgentView, TurnResponse } from '../../../web/src/lib/agent.ts'
import type { Block, Page } from '../../../web/src/lib/studio.ts'
import { DEMO, isDemoIdentity, sessionExpiry, sessionUsable, type StoredSession } from './logic.ts'

export const TUTOR = '/api/m/education.tutor'
export const AGENT = `${TUTOR}/agent`
export const S = `${TUTOR}/studio`
const KEY = 'ebtd.session'
const ENDED = 'Your demo session has ended. Start a new one to continue.'

export class DemoError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 0) { super(message); this.code = code; this.status = status }
}
export const friendly = (e: unknown) => (e instanceof DemoError ? e.message : 'Something went wrong. Please try again.')

function readSession(): StoredSession | null {
  try { const r = sessionStorage.getItem(KEY); return r ? (JSON.parse(r) as StoredSession) : null } catch { return null }
}
let session: StoredSession | null = readSession()
function setSession(s: StoredSession | null) {
  session = s
  try { if (s) sessionStorage.setItem(KEY, JSON.stringify(s)); else sessionStorage.removeItem(KEY) } catch { /* private mode: memory only */ }
}
export const hasSession = () => sessionUsable(session, Date.now())
export const sessionEndsAt = () => session?.expiresAt ?? 0
function token(): string {
  if (!sessionUsable(session, Date.now())) { setSession(null); throw new DemoError('session_expired', ENDED, 401) }
  return session.token
}

async function fromResponse(res: Response) {
  const body = await res.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
  const code = body?.error?.code ?? 'request_failed'
  if (res.status === 401) { setSession(null); return new DemoError('session_expired', ENDED, 401) }
  if (res.status === 429) return new DemoError(code, 'The demo is busy. Please wait a moment and try again.', 429)
  if (res.status === 409) return new DemoError(code, body?.error?.message ?? 'Another step is still running. Please try again.', 409)
  if (res.status === 503 || code.startsWith('ai_')) return new DemoError(code, 'The AI service is unavailable right now. Please try again shortly.', res.status)
  if (res.status >= 500) return new DemoError(code, 'The Tutor could not finish this step. Please try again.', res.status)
  return new DemoError(code, body?.error?.message ?? 'That request could not be completed.', res.status)
}

async function send(path: string, init: RequestInit, timeoutMs: number, outer?: AbortSignal): Promise<Response> {
  const bearer = token()
  const ctl = new AbortController()
  const timer = window.setTimeout(() => ctl.abort(), timeoutMs)
  const onOuter = () => ctl.abort()
  outer?.addEventListener('abort', onOuter)
  try {
    const res = await fetch(path, { ...init, credentials: 'omit', signal: ctl.signal, headers: { authorization: `Bearer ${bearer}`, ...init.headers } })
    if (!res.ok) throw await fromResponse(res)
    return res
  } catch (e) {
    if (e instanceof DemoError) throw e
    if (outer?.aborted) throw new DemoError('cancelled', 'Cancelled.')
    if (ctl.signal.aborted) throw new DemoError('timeout', 'That took too long. Please try again.')
    throw new DemoError('network', 'Cannot reach the Tutor. Check your connection and try again.')
  } finally { window.clearTimeout(timer); outer?.removeEventListener('abort', onOuter) }
}
const json = async <T,>(r: Response) => (r.status === 204 ? undefined : await r.json()) as T
export const get = async <T,>(path: string, signal?: AbortSignal) => json<T>(await send(path, {}, 30_000, signal))
export const post = async <T,>(path: string, body: unknown = {}, timeoutMs = 120_000, signal?: AbortSignal) => json<T>(await send(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, timeoutMs, signal))
export const postAudio = async <T,>(path: string, audio: Blob, timeoutMs = 45_000, signal?: AbortSignal) => json<T>(await send(path, { method: 'POST', headers: { 'content-type': audio.type.split(';')[0] || 'audio/webm' }, body: audio }, timeoutMs, signal))
const del = (path: string) => send(path, { method: 'DELETE' }, 30_000)

/** Open a session for the dedicated demo learner and verify who it really is before anything else runs. */
export async function startSession(): Promise<void> {
  if (hasSession()) {
    const me = await get<{ email?: string }>('/api/me').catch(() => null)
    if (me && isDemoIdentity(me.email)) return
    setSession(null)
  }
  const pub = (path: string, body: unknown) => fetch(path, { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  let linkRes: Response
  try { linkRes = await pub('/api/auth/magic-link', { tenantSlug: DEMO.tenant, email: DEMO.email }) } catch { throw new DemoError('network', 'Cannot reach the Tutor. Check that the service is running.') }
  if (!linkRes.ok) throw await fromResponse(linkRes)
  const link = (await linkRes.json() as { devLink?: string }).devLink
  const magic = link ? /#token=([A-Za-z0-9_-]+)/.exec(link)?.[1] : undefined
  if (!magic) throw new DemoError('guest_unavailable', 'Public guest access is not enabled on this server yet, or the demo learner is temporarily rate limited. Please try again later.')
  const v = await pub('/api/auth/verify', { token: magic, ageAttestation: 'adult' })
  if (!v.ok) throw await fromResponse(v)
  const s = await v.json() as { sessionToken: string; expiresAt?: string }
  setSession({ token: s.sessionToken, expiresAt: sessionExpiry(s.expiresAt, Date.now()) })
  const me = await get<{ email?: string }>('/api/me')
  if (!isDemoIdentity(me.email)) { await endSession(); throw new DemoError('wrong_identity', 'The demo could not verify its learner account, so it stopped.') }
}
export async function endSession() {
  if (hasSession()) await send('/api/auth/logout', { method: 'POST' }, 10_000).catch(() => undefined)
  setSession(null)
}
/** Clear this demo learner's conversation, memory and notebooks. Refuses to run for any other identity. */
export async function resetDemo() {
  const me = await get<{ email?: string }>('/api/me')
  if (!isDemoIdentity(me.email)) throw new DemoError('wrong_identity', 'Reset is only available for the demo learner.')
  for (const b of await get<{ id: string }[]>(`${S}/books`)) await del(`${S}/books/${b.id}`)
  await del(`${AGENT}/memory`)
}

async function readSse(res: Response, onEvent: (e: { event: string; data: unknown }) => void) {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const parser = new SseParser()
  const handle = (evs: { event: string; data: string }[]) => { for (const ev of evs) onEvent({ event: ev.event, data: JSON.parse(ev.data) }) }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    handle(parser.feed(decoder.decode(value, { stream: true })))
  }
  handle(parser.feed(decoder.decode()))
  handle(parser.end())
}

/** Speech as audio chunks while it is generated. Throws before the first chunk if streaming is unavailable. */
export async function* streamSpeech(bookId: string, token: string, signal: AbortSignal): AsyncIterable<Uint8Array> {
  const res = await send(`${S}/books/${bookId}/live/speech/stream`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify({ token }) }, 8_000, signal)
  const reader = res.body!.getReader()
  const stop = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', stop, { once: true })
  const decoder = new TextDecoder(), parser = new SseParser()
  const decode = (ev: { event: string; data: string }) => {
    const d = JSON.parse(ev.data) as { audio?: string; message?: string }
    if (ev.event === 'error' || !d.audio) throw new DemoError('stream_failed', d.message ?? 'The voice stream stopped.')
    const bin = atob(d.audio), out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  }
  try {
    for (;;) {
      let timer = 0
      const stalled = new Promise<never>((_, no) => { timer = window.setTimeout(() => no(new DemoError('timeout', 'The voice stream stalled.')), 10_000) })
      const { done, value } = await Promise.race([reader.read(), stalled]).finally(() => window.clearTimeout(timer))
      if (done) break
      for (const ev of parser.feed(decoder.decode(value, { stream: true }))) yield decode(ev)
    }
    for (const ev of [...parser.feed(decoder.decode()), ...parser.end()]) yield decode(ev)
  } finally { signal.removeEventListener('abort', stop); stop() }
}

export interface LiveStep { text: string; agent: string }
export async function streamTurn(body: Record<string, unknown>, onStep: (s: LiveStep) => void, signal?: AbortSignal): Promise<TurnResponse> {
  const res = await send(`${AGENT}/messages/stream`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body) }, 180_000, signal)
  const got: { result?: TurnResponse } = {}
  await readSse(res, ({ event, data }) => {
    const e = data as { type?: string; text?: string; agent?: string; result?: TurnResponse; code?: string; message?: string; status?: number }
    if (event === 'error' || e.type === 'failed') throw new DemoError(e.code ?? 'stream_failed', e.code?.startsWith('ai_') ? 'The AI service is unavailable right now. Please try again shortly.' : e.message ?? 'The Tutor could not finish this step.', e.status ?? 502)
    if (e.type === 'status' && e.text) onStep({ text: e.text, agent: e.agent ?? 'tutor' })
    if (e.type === 'done' && e.result) got.result = e.result
  })
  if (!got.result) throw new DemoError('stream_incomplete', 'The Tutor stopped before finishing. Please try again.')
  return got.result
}
export async function streamSection(bookId: string, sectionId: string, onBlock: (b: Block) => void, signal?: AbortSignal): Promise<Page[]> {
  const res = await send(`${S}/books/${bookId}/sections/${sectionId}/generate`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: '{}' }, 180_000, signal)
  const got: { pages?: Page[] } = {}
  await readSse(res, ({ event, data }) => {
    const e = data as { type?: string; block?: Block; pages?: Page[]; code?: string; message?: string }
    if (event === 'error') throw new DemoError(e.code ?? 'stream_failed', e.message ?? 'The Tutor stopped writing this section.')
    if (e.type === 'block' && e.block) onBlock(e.block)
    if (e.type === 'section' && e.pages) got.pages = e.pages
  })
  if (!got.pages) throw new DemoError('stream_incomplete', 'The Tutor stopped before finishing this section.')
  return got.pages
}
/** Upload through the existing endpoints: into a course, or (no course yet) into a new one the document will name. */
export function uploadFile(courseId: string | null, file: File, mime: string, onProgress: (p: number) => void): Promise<{ documentId: string; courseId?: string }> {
  return new Promise((resolve, reject) => {
    let bearer: string
    try { bearer = token() } catch (e) { reject(e); return }
    const xhr = new XMLHttpRequest()
    const q = `filename=${encodeURIComponent(file.name)}`
    xhr.open('POST', courseId ? `${TUTOR}/courses/${courseId}/materials?${q}` : `${AGENT}/material?${q}`)
    xhr.setRequestHeader('content-type', mime)
    xhr.setRequestHeader('authorization', `Bearer ${bearer}`)
    xhr.timeout = 180_000
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total) }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { resolve(JSON.parse(xhr.responseText) as { documentId: string; courseId?: string }); return }
      let msg = 'The upload was rejected.'
      try { msg = (JSON.parse(xhr.responseText) as { error?: { message?: string } }).error?.message ?? msg } catch { /* not JSON */ }
      reject(new DemoError('upload_failed', msg, xhr.status))
    }
    xhr.onerror = () => reject(new DemoError('network', 'The upload failed. Check your connection.'))
    xhr.ontimeout = () => reject(new DemoError('timeout', 'The upload took too long.'))
    xhr.send(file)
  })
}
export const getView = (language: string, signal?: AbortSignal) => get<AgentView>(`${AGENT}?language=${language}`, signal)
