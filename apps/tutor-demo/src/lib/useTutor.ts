import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentMessage, AgentView, TurnResponse } from '../../../web/src/lib/agent.ts'
import { AGENT, DemoError, friendly, getView, post, streamTurn, type LiveStep } from './client.ts'
import { destinationFor, type Destination } from './logic.ts'

export interface BookContext { bookId: string; pageNo: number; blockId: string | null; selection: string | null }
export type Language = 'en' | 'hi' | 'hinglish'

/** The one conversation of the demo, on the existing Tutor endpoints. One request at a time (no double submits). */
export function useTutor(onOpen: (d: Destination) => void, onExpired: () => void) {
  const [language, setLanguage] = useState<Language>('en')
  const [view, setView] = useState<AgentView | null>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [live, setLive] = useState<LiveStep[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [bookContext, setBookContext] = useState<BookContext | null>(null)
  const inFlight = useRef(false)
  const retryRef = useRef<(() => void) | null>(null)
  const abort = useRef<AbortController | null>(null)
  const open = useRef(onOpen); open.current = onOpen
  const expired = useRef(onExpired); expired.current = onExpired

  // panels show their own errors; they only report here so an ended session always leaves the workspace
  const fail = useCallback((e: unknown) => {
    if (e instanceof DemoError && e.code === 'session_expired') expired.current()
  }, [])
  const failTurn = useCallback((e: unknown) => {
    fail(e)
    if (e instanceof DemoError && (e.code === 'cancelled' || e.code === 'session_expired')) return
    setError(friendly(e))
  }, [fail])
  const refresh = useCallback(async () => {
    const v = await getView(language)
    setView(v)
    setMessages(v.messages)
    return v
  }, [language])

  useEffect(() => {
    const ctl = new AbortController()
    getView(language, ctl.signal).then((v) => { setView(v); setMessages(v.messages) }, failTurn)
    return () => ctl.abort()
  }, [language, failTurn])
  useEffect(() => () => abort.current?.abort(), [])

  const finish = useCallback(async (r: TurnResponse) => {
    await refresh()
    const link = r.messages.at(-1)?.cards.find((c) => c.type === 'links' && c.auto)?.links?.[0]
    const d = link ? destinationFor(link.href) : null
    if (d) open.current(d)
    return r
  }, [refresh])

  const send = useCallback(async (message: string, extra: { documentId?: string; documentTitle?: string; intake?: { id: string; answers: Record<string, string>; review: boolean } } = {}): Promise<TurnResponse | null> => {
    const text = message.trim()
    if (!text || inFlight.current || !view) return null
    inFlight.current = true
    setBusy(true); setError(null); setLive([])
    retryRef.current = () => { void send(text, extra) }
    setMessages((m) => [...m, { id: `local-${Date.now()}`, role: 'student', kind: 'text', content: text, cards: [], createdAt: new Date().toISOString(), seen: true }])
    const ctl = new AbortController()
    abort.current = ctl
    try {
      const r = await streamTurn({ conversationId: view.conversationId, message: text, language, source: 'text', context: bookContext ?? undefined, ...extra }, (s) => setLive((l) => (l.at(-1)?.text === s.text ? l : [...l, s])), ctl.signal)
      retryRef.current = null
      return await finish(r)
    } catch (e) {
      failTurn(e)
      await refresh().catch(() => undefined)
      return null
    } finally { inFlight.current = false; setBusy(false); setLive([]) }
  }, [view, language, bookContext, finish, failTurn, refresh])

  const decide = useCallback(async (proposalId: string, approve: boolean) => {
    if (inFlight.current || !view) return
    inFlight.current = true
    setBusy(true); setError(null)
    setLive([{ text: approve ? 'Saving your plan…' : 'Keeping the plan open for changes…', agent: 'planner' }])
    retryRef.current = () => { void decide(proposalId, approve) }
    try {
      const r = await post<TurnResponse>(`${AGENT}/proposals/${proposalId}/${approve ? 'approve' : 'reject'}`, { conversationId: view.conversationId })
      retryRef.current = null
      await finish(r)
    } catch (e) { failTurn(e); await refresh().catch(() => undefined) } finally { inFlight.current = false; setBusy(false); setLive([]) }
  }, [view, finish, failTurn, refresh])

  const retry = useCallback(() => { const r = retryRef.current; setError(null); r?.() }, [])
  return { language, setLanguage, view, messages, live, busy, error, setError, send, decide, retry, canRetry: !!retryRef.current, refresh, bookContext, setBookContext, fail }
}
export type Tutor = ReturnType<typeof useTutor>
