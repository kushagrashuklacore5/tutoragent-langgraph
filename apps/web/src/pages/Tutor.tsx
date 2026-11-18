import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useSearchParams } from 'react-router'
import { TUTOR, api, describeError } from '../lib/api.ts'
import { prefs, sessionGet, sessionSet } from '../lib/storage.ts'
import { historyEntries, sendTurn, sessionTitle, type Entry, type SessionDetail, type SessionSummary, type TurnInput, type TurnStart } from '../lib/turns.ts'
import { HINT_STEPS, LANGUAGES, MOVE_LABEL, type Citation, type ConceptGraph, type Language, type TurnResponse } from '../lib/tutor.ts'
import { Icon } from '../ui/icons.tsx'
import { Button, Card, ErrorNote, Field, Notice, PageHeader, inputCls, useLoad } from '../ui/kit.tsx'
import { Markdown } from '../ui/Markdown.tsx'
import { SegmentList } from '../ui/Segments.tsx'
import { PagePreview, SourceOverlay, useMedia } from '../ui/SourcePanel.tsx'
import { useCourse } from './CourseLayout.tsx'
import { speak, stopSpeaking, type VoiceLang } from '../lib/voice.ts'
import { MicButton, ReadAloudToggle } from '../ui/VoiceControls.tsx'

interface Thread { sessionId: string; problem: string; conceptId: string | null; graded: boolean; language: Language; entries: Entry[] }

const ASSESSMENT: Record<TurnResponse['assessment'], string | null> = { correct: 'Your attempt looks right', partial: 'Partly there', incorrect: 'Not quite yet', not_an_attempt: null }

export function HintLadder({ level, move }: { level: number; move: TurnResponse['move'] | null }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <ol className="flex items-center gap-1" aria-label={`Hint ladder: level ${level} of 4${level ? ` (${HINT_STEPS[level - 1]})` : ''}`}>
        {HINT_STEPS.map((step, i) => {
          const on = i < level
          return (
            <li key={step} className="flex items-center gap-1">
              <span className={`anim inline-flex h-7 items-center rounded-md border px-2 text-[0.74rem] font-semibold ${on ? 'border-accent bg-src-course-bg text-src-course' : 'border-line text-faint'}`}>
                <span aria-hidden className="mr-1 font-mono">{i + 1}</span>{step}
                {on ? <span className="sr-only"> (used)</span> : null}
              </span>
            </li>
          )
        })}
      </ol>
      {move ? <span className="text-sm text-muted">Now: <span className="font-semibold text-fg-soft">{MOVE_LABEL[move]}</span></span> : null}
    </div>
  )
}

export default function Tutor() {
  const course = useCourse()
  const [params] = useSearchParams()
  const key = `ebs.tutor.${course.id}`
  const [thread, setThreadState] = useState<Thread | null>(() => sessionGet<Thread>(key))
  const setThread = (t: Thread | null) => { setThreadState(t); sessionSet(key, t) }
  const [citation, setCitation] = useState<Citation | null>(null)
  const wide = useMedia('(min-width: 1280px)')

  return (
    <div className={wide && citation ? 'grid grid-cols-[minmax(0,1fr)_24rem] gap-6' : ''}>
      <div className="min-w-0">
        {thread ? (
          <Conversation thread={thread} setThread={setThread} onCitation={setCitation} />
        ) : (
          <StartSession courseId={course.id} initialConcept={params.get('conceptId')} integrity={course.integrity_mode} onStart={setThread} />
        )}
      </div>
      {wide && citation ? (
        <aside aria-label="Source" className="sticky top-4 h-fit rounded-xl border border-line bg-surface p-4">
          <div className="mb-2 flex items-center justify-between"><h2 className="font-semibold">Source</h2>
            <button type="button" onClick={() => setCitation(null)} aria-label="Close source" className="inline-flex h-11 w-11 items-center justify-center rounded-lg hover:bg-surface-2"><Icon name="x" /></button></div>
          <PagePreview c={citation} courseId={course.id} />
        </aside>
      ) : null}
      <SourceOverlay citation={citation} onClose={() => setCitation(null)} courseId={course.id} />
    </div>
  )
}

function StartSession({ courseId, initialConcept, integrity, onStart }: { courseId: string; initialConcept: string | null; integrity: string; onStart: (t: Thread) => void }) {
  const graph = useLoad(`g:${courseId}`, (sig) => api.get<ConceptGraph>(`${TUTOR}/courses/${courseId}/concepts`, sig))
  const [problem, setProblem] = useState('')
  const [conceptId, setConceptId] = useState(initialConcept ?? '')
  const [graded, setGraded] = useState(false)
  const [language, setLanguage] = useState<Language>(prefs.language())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const start = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const r = await api.post<{ id: string }>(`${TUTOR}/sessions`, { courseId, conceptId: conceptId || undefined, problem: problem.trim() || undefined, graded, language })
      prefs.setLanguage(language)
      onStart({ sessionId: r.id, problem: problem.trim(), conceptId: conceptId || null, graded, language, entries: [] })
    } catch (err) { setError(err) } finally { setBusy(false) }
  }

  return (
    <>
      <PageHeader title="Tutor" eyebrow="Work it out together" />
      <Card className="max-w-2xl">
        <form onSubmit={start} className="flex flex-col gap-4">
          <p className="text-fg-soft">The tutor asks before it tells: you get hints step by step, and every part of an answer says where it comes from.</p>
          <Field id="problem" label="What are you working on? (optional)" hint="Paste a question or describe what you are stuck on. Leave empty to ask about a concept.">
            <textarea id="problem" rows={4} value={problem} onChange={(e) => setProblem(e.target.value)} className={inputCls} aria-describedby="problem-hint" maxLength={8000} />
          </Field>
          <Field id="concept" label="Concept (optional)">
            <select id="concept" value={conceptId} onChange={(e) => setConceptId(e.target.value)} className={inputCls}>
              <option value="">Not sure / general</option>
              {graph.data?.concepts.filter((c) => c.status === 'approved').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="lang" label="Language">
              <select id="lang" value={language} onChange={(e) => setLanguage(e.target.value as Language)} className={inputCls}>
                {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </Field>
            <label className="flex min-h-11 items-center gap-2 self-end text-[0.94rem]">
              <input type="checkbox" checked={graded} onChange={(e) => setGraded(e.target.checked)} className="h-5 w-5 accent-[var(--color-accent)]" />
              This is graded work (assignment or test)
            </label>
          </div>
          {integrity === 'hint_only' || graded ? <Notice tone="info" icon="lifebuoy">{integrity === 'hint_only' ? 'In this course' : 'For graded work'} the tutor gives hints, not full solutions.</Notice> : null}
          {error ? <ErrorNote error={error} /> : null}
          <Button type="submit" variant="primary" busy={busy} className="self-start">Start</Button>
        </form>
      </Card>
      <RecentSessions courseId={courseId} onOpen={onStart} />
    </>
  )
}

const exchanges = (turns: number) => { const n = Math.ceil(turns / 2); return `${n} exchange${n === 1 ? '' : 's'}` }
const LANG_LABEL = Object.fromEntries(LANGUAGES.map((l) => [l.value, l.label]))
const when = (iso: string) => {
  const d = new Date(iso)
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

/** The student's own past conversations in this course; opening one restores the transcript from the server. */
function RecentSessions({ courseId, onOpen }: { courseId: string; onOpen: (t: Thread) => void }) {
  const list = useLoad(`sessions:${courseId}`, (sig) => api.get<SessionSummary[]>(`${TUTOR}/courses/${courseId}/sessions?limit=20`, sig))
  const [opening, setOpening] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const open = async (id: string) => {
    setOpening(id); setError(null)
    try {
      const s = await api.get<SessionDetail>(`${TUTOR}/sessions/${id}`)
      onOpen({ sessionId: s.id, problem: s.problem ?? '', conceptId: s.conceptId, graded: s.graded, language: (LANG_LABEL[s.language] ? s.language : 'en') as Language, entries: historyEntries(s.turns) })
    } catch (e) { setError(e) } finally { setOpening(null) }
  }
  const rows = (list.data ?? []).filter((s) => s.turns > 0)
  if (list.error) return <div className="mt-6 max-w-2xl"><ErrorNote error={list.error} /></div>
  if (!rows.length) return null
  return (
    <section aria-labelledby="recent-h" className="mt-8 max-w-2xl">
      <h2 id="recent-h" className="mb-2 text-lg font-semibold">Continue a conversation</h2>
      {error ? <div className="mb-2"><ErrorNote error={error} /></div> : null}
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
        {rows.map((s) => (
          <li key={s.id}>
            <button type="button" onClick={() => void open(s.id)} disabled={!!opening} aria-busy={opening === s.id}
              className="anim flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2 disabled:opacity-60">
              <Icon name="chat" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{sessionTitle(s)}</span>
                <span className="block text-xs text-muted">{exchanges(s.turns)} · {LANG_LABEL[s.language] ?? s.language}{s.graded ? ' · graded work' : ''}</span>
              </span>
              <time dateTime={s.lastActivityAt} className="shrink-0 text-xs text-muted">{opening === s.id ? 'Opening…' : when(s.lastActivityAt)}</time>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Conversation({ thread, setThread, onCitation }: { thread: Thread; setThread: (t: Thread | null) => void; onCitation: (c: Citation) => void }) {
  const course = useCourse()
  const [draft, setDraft] = useState('')
  const [readAloud, setReadAloud] = useState(false)
  useEffect(() => () => stopSpeaking(), [])
  const [pending, setPending] = useState<{ text: string; progress: string; start?: TurnStart } | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [switching, setSwitching] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const end = useRef<HTMLDivElement>(null)
  const lastTutor = [...thread.entries].reverse().find((e): e is Extract<Entry, { role: 'tutor' }> => e.role === 'tutor')?.turn ?? null
  const hintOnly = course.integrity_mode === 'hint_only' || thread.graded

  useEffect(() => { end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }) }, [thread.entries.length, pending?.progress])
  useEffect(() => () => abort.current?.abort(), [])

  const send = async (input: TurnInput, kind?: 'stuck' | 'full') => {
    if (pending) return
    stopSpeaking()
    const ac = new AbortController()
    abort.current = ac
    setError(null)
    setPending({ text: input.message, progress: '' })
    setDraft('')
    try {
      const turn = await sendTurn(thread.sessionId, input, (p) => setPending((cur) => (cur ? { ...cur, progress: p } : cur)), ac.signal,
        (start) => setPending((cur) => (cur ? { ...cur, start } : cur)))
      setThread({ ...thread, entries: [...thread.entries, { role: 'student', text: input.message, kind }, { role: 'tutor', turn }] })
      if (readAloud) speak([...turn.segments.map((x) => x.text), ...(turn.checkQuestion ? [turn.checkQuestion] : [])], thread.language as VoiceLang)
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) { setError(e); setDraft(input.message) }
    } finally {
      setPending(null)
      abort.current = null
    }
  }

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (draft.trim()) void send({ message: draft.trim() })
  }
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() }
  }

  const changeLanguage = async (language: Language) => {
    // language is fixed per session on the server: switching starts a fresh session on the same problem
    setSwitching(true)
    try {
      const r = await api.post<{ id: string }>(`${TUTOR}/sessions`, { courseId: course.id, conceptId: thread.conceptId ?? undefined, problem: thread.problem || undefined, graded: thread.graded, language })
      prefs.setLanguage(language)
      setThread({ ...thread, sessionId: r.id, language, entries: [] })
    } catch (e) { setError(e) } finally { setSwitching(false) }
  }

  return (
    <div className="flex min-h-[calc(100dvh-16rem)] flex-col">
      {/* pinned problem + hint ladder */}
      <div className="sticky top-[3.6rem] z-10 -mx-4 border-b border-line bg-bg/95 px-4 pb-3 pt-1 sm:mx-0 sm:rounded-b-xl sm:px-0 md:top-0">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h1 tabIndex={-1} className="text-xl font-bold">Tutor</h1>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="session-lang" className="sr-only">Language</label>
            <select id="session-lang" value={thread.language} disabled={switching || !!pending} onChange={(e) => void changeLanguage(e.target.value as Language)} className="min-h-11 rounded-lg border border-line-strong bg-surface px-2 text-sm">
              {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
            <Button variant="ghost" icon="plus" onClick={() => { abort.current?.abort(); setThread(null) }}>New</Button>
          </div>
        </div>
        {thread.problem ? (
          <details open className="mt-2 rounded-lg border border-line bg-surface p-3">
            <summary className="cursor-pointer text-sm font-semibold text-muted">Problem{thread.graded ? ' · graded work' : ''}</summary>
            <div className="mt-1 max-h-40 overflow-y-auto"><Markdown text={thread.problem} /></div>
          </details>
        ) : null}
        <div className="mt-2"><HintLadder level={lastTutor?.hintLevel ?? 0} move={lastTutor?.move ?? null} /></div>
      </div>

      <ol className="flex-1 space-y-5 py-5" aria-label="Conversation">
        {!thread.entries.length && !pending ? (
          <li className="text-muted">{thread.problem ? 'Start by telling the tutor what you have tried, or how you would begin.' : 'Ask about any idea in this course.'}</li>
        ) : null}
        {thread.entries.map((e, i) => e.role === 'student' ? (
          <li key={i} className="ml-auto max-w-[85%] rounded-xl rounded-br-sm bg-navy px-4 py-2.5 text-on-navy">
            <span className="sr-only">You: </span>
            {e.kind === 'stuck' ? <span className="mb-1 block text-xs font-semibold opacity-80">I'm stuck</span> : e.kind === 'full' ? <span className="mb-1 block text-xs font-semibold opacity-80">Asked for the full solution</span> : null}
            <p className="whitespace-pre-wrap break-words">{e.text}</p>
          </li>
        ) : (
          <li key={i} className="max-w-full">
            <article className="rounded-xl border border-line bg-surface p-4" aria-label="Tutor reply">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">{MOVE_LABEL[e.turn.move]}{e.turn.move === 'hint' && e.turn.hintLevel ? ` · level ${e.turn.hintLevel} (${HINT_STEPS[e.turn.hintLevel - 1]})` : ''}</p>
              {e.turn.policyNote ? <div className="mb-3"><Notice tone="warn" icon="lifebuoy" title="Hints only here">{e.turn.policyNote}</Notice></div> : null}
              <SegmentList segments={e.turn.segments} onOpenCitation={onCitation} />
              {(() => {
                const maths = e.turn.segments.filter((s) => s.math === 'failed').length
                const sources = Math.max(0, e.turn.relabelled - maths)
                return sources ? <p className="mt-3 text-xs text-muted">{sources} part{sources === 1 ? ' was' : 's were'} marked “Not certain” because no matching course source was found.</p> : null
              })()}
              {e.turn.retrievalDegraded ? <p className="mt-3 text-xs text-muted" role="note">Your course material couldn’t be searched just now, so this reply isn’t based on it. Try again shortly for cited answers.</p> : null}
              {e.turn.checkQuestion ? (
                <div className="mt-3 rounded-lg border border-line-strong bg-surface-2 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">Check yourself</p>
                  <Markdown text={e.turn.checkQuestion} />
                </div>
              ) : null}
              {ASSESSMENT[e.turn.assessment] ? <p className="mt-3 text-sm text-muted">Tutor's read of your last attempt: <span className="font-semibold text-fg-soft">{ASSESSMENT[e.turn.assessment]}</span></p> : null}
            </article>
          </li>
        ))}
        {pending ? (
          <>
            <li className="ml-auto max-w-[85%] rounded-xl rounded-br-sm bg-navy px-4 py-2.5 text-on-navy"><p className="whitespace-pre-wrap break-words">{pending.text}</p></li>
            <li className="rounded-xl border border-dashed border-line-strong bg-surface p-4" aria-live="polite" aria-busy="true">
              <p className="mb-1 flex items-center gap-2 text-sm font-semibold text-muted"><span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden />
                Tutor is writing…{pending.start ? ` (${MOVE_LABEL[pending.start.move]}${pending.start.move === 'hint' && pending.start.hintLevel ? `, level ${pending.start.hintLevel}` : ''})` : ''}</p>
              {pending.start?.policyNote ? <div className="my-2"><Notice tone="warn" icon="lifebuoy" title="Hints only here">{pending.start.policyNote}</Notice></div> : null}
              {pending.progress ? <p className="whitespace-pre-wrap text-fg-soft">{pending.progress}</p> : <p className="text-sm text-muted">This can take a little while on a busy model.</p>}
              {pending.progress ? <p className="mt-1 text-xs text-muted">Draft — source labels appear when the answer is checked.</p> : null}
              <button type="button" onClick={() => abort.current?.abort()} className="mt-2 min-h-11 text-sm font-semibold text-muted underline">Stop waiting</button>
            </li>
          </>
        ) : null}
      </ol>
      <div ref={end} />

      {error ? <div className="mb-3"><Notice tone="danger" title="The tutor could not reply">{describeError(error)}</Notice></div> : null}

      <form onSubmit={submit} className="sticky bottom-[4.25rem] z-10 -mx-4 border-t border-line bg-bg/95 px-4 py-3 sm:mx-0 sm:px-0 md:bottom-0">
        <label htmlFor="msg" className="sr-only">Your message</label>
        <div className="flex items-end gap-2">
          <textarea id="msg" rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} maxLength={8000}
            placeholder="Your attempt, a question, or what you tried…" className={`${inputCls} min-h-12 resize-y`} />
          <MicButton courseId={course.id} language={thread.language} disabled={!!pending} onStart={stopSpeaking} onText={(t) => setDraft((d) => (d.trim() ? `${d.trim()} ${t}` : t))} />
          <Button type="submit" variant="primary" icon="send" disabled={!draft.trim() || !!pending} aria-label="Send">
            <span className="hidden sm:inline">Send</span>
          </Button>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button variant="secondary" icon="lifebuoy" disabled={!!pending} onClick={() => void send({ message: draft.trim() || "I'm stuck.", stuck: true }, 'stuck')}>I'm stuck</Button>
          <Button variant="ghost" icon="eye" disabled={!!pending} onClick={() => void send({ message: draft.trim() || 'Please show me the full solution.', requestFullAnswer: true }, 'full')}
            title={hintOnly ? 'Graded or hint-only work: you will get a stronger hint instead' : 'Allowed after genuine attempts'}>
            Show full solution
          </Button>
          <ReadAloudToggle on={readAloud} onChange={(v) => { setReadAloud(v); if (!v) stopSpeaking() }} />
          <span className="self-center text-xs text-muted">Enter to send · Shift+Enter for a new line · maths shown as plain text</span>
        </div>
      </form>
    </div>
  )
}
