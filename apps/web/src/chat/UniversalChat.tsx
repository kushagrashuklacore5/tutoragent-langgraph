import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { TUTOR, api, describeError } from '../lib/api.ts'
import { AGENTS, agentOf, streamTurn, type LiveStatus, FEASIBILITY_LABEL, hours, type AgentCard, type AgentMessage, type AgentView, type IntakeView, type ProposalView, type TurnResponse } from '../lib/agent.ts'
import { CUSTOM, intakePayload, visibleQuestions } from '../lib/intake.ts'
import { prefs } from '../lib/storage.ts'
import { LANGUAGES, type Language } from '../lib/tutor.ts'
import { canSpeak, speak, stopSpeaking, type VoiceLang } from '../lib/voice.ts'
import { Button, ErrorNote, Loading, useAction, useLoad } from '../ui/kit.tsx'
import { Markdown } from '../ui/Markdown.tsx'
import { uploadMaterial } from '../lib/upload.ts'
import { checkUpload, type Material } from '../lib/tutor.ts'
import { useSession } from '../session.tsx'
import { MicButton } from '../ui/VoiceControls.tsx'

const A = `${TUTOR}/agent`
const STEP_ICON: Record<string, string> = { done: '✓', failed: '!', running: '…', pending: '○', skipped: '–' }

/** Goal discovery: one tap to say what kind of help is needed (or just type it). */
export const GOALS: { label: string; say: string; icon: string }[] = [
  { label: 'Board / semester exam', say: 'I want to prepare for my board / semester exam.', icon: '🎯' },
  { label: 'Understand a concept deeply', say: 'I want to understand a concept properly, not just memorise it.', icon: '🧠' },
  { label: 'Quick explanation', say: 'I just need a quick explanation of something.', icon: '⚡' },
  { label: 'Revise before an exam', say: 'I want to revise the important topics before my exam.', icon: '🔁' },
  { label: "Prepare for tomorrow's class", say: "I want to prepare before tomorrow's class.", icon: '📅' },
  { label: 'Practical / hands-on skill', say: 'I want to learn a practical, hands-on skill.', icon: '🛠️' },
  { label: 'Interview preparation', say: 'I want to prepare for an interview.', icon: '💼' },
  { label: 'Project-based learning', say: 'I want to learn by building a project.', icon: '🧩' },
  { label: 'Homework / a question', say: 'I need help solving a homework question.', icon: '✍️' },
  { label: 'Explore out of curiosity', say: 'I want to explore a topic out of curiosity.', icon: '🔭' },
]

/**
 * The ONE conversation with the learning agent. `home` = full study desk; `dock` = the same conversation in a side
 * panel on every other page. When the agent starts an activity the student asked for, its workspace opens by itself.
 */
/** When the chat sits beside a book: page-aware doubts are answered inside that book (same conversation). */
export interface BookChat {
  bookId: string; courseId: string; pageNo: number; blockId: string | null; selection: string | null
  onClearSelection: () => void; onAnswer: (text: string) => void; onResume: () => void
  /** a page-aware prompt from the book (e.g. you opened another page) */
  notice?: { text: string; canResume: boolean } | null
}

export function UniversalChat({ variant, onClose, book }: { variant: 'home' | 'dock'; onClose?: () => void; book?: BookChat }) {
  const navigate = useNavigate()
  const session = useSession()
  const [language, setLanguage] = useState<Language>(prefs.language())
  const v = useLoad<AgentView>(`agent:${language}`, (s) => api.get(`${A}?language=${language}`, s))
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [draft, setDraft] = useState('')
  const [voiceOut, setVoiceOut] = useState(() => { try { return localStorage.getItem('ebs.voiceOut') === '1' } catch { return false } })
  const [source, setSource] = useState<'text' | 'voice'>('text')
  const [opening, setOpening] = useState<{ label: string; href: string } | null>(null)
  const send = useAction()
  const [live, setLive] = useState<LiveStatus[]>([])
  const [up, setUp] = useState<{ name: string; phase: 'uploading' | 'reading' | 'error'; progress: number; error?: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const end = useRef<HTMLDivElement>(null)
  const openTimer = useRef<number | undefined>(undefined)

  useEffect(() => { if (v.data) setMessages(v.data.messages) }, [v.data])
  // the conversation's language (e.g. the student asked "Hindi mein baat karo") becomes the picker's value
  useEffect(() => { const l = v.data?.profile.language; if (l && l !== language) { setLanguage(l); prefs.setLanguage(l) } }, [v.data?.profile.language]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }) }, [messages.length, send.busy])
  useEffect(() => { if (v.data?.messages.some((m) => !m.seen)) void api.post(`${A}/messages/seen`).catch(() => {}) }, [v.data])
  useEffect(() => () => { stopSpeaking(); window.clearTimeout(openTimer.current) }, [])

  if (v.loading && !v.data) return <Loading label="Opening your study desk" />
  if (v.error || !v.data) return <ErrorNote error={v.error} retry={v.reload} feature="study companion" />
  const view = v.data
  const courseId = view.profile.courseId ?? view.courses[0]?.id ?? ''
  const pendingId = view.state.pendingProposalId
  const fresh = messages.filter((m) => m.role === 'student').length === 0
  // goal buttons only before the student has said anything (the view profile is not refreshed per turn)
  const needsGoal = fresh && !(view.profile as { objective?: string }).objective

  const apply = (r: TurnResponse) => {
    setMessages((m) => [...m.filter((x) => !x.id.startsWith('local-')), ...r.messages])
    v.setData({ ...view, conversationId: r.conversationId, state: r.state, messages: [...messages.filter((x) => !x.id.startsWith('local-')), ...r.messages], pendingProposal: r.messages.flatMap((m) => m.cards).find((c) => c.type === 'plan_proposal')?.proposal ?? (r.state.pendingProposalId ? view.pendingProposal : null) })
    const reply = r.messages.at(-1)
    // a course the agent just created must be known to the course and practice pages
    if (reply?.cards.some((c) => c.links?.some((l) => /\/courses\/[0-9a-f-]{36}/.test(l.href) && !session.courses.some((x) => l.href.includes(x.id))))) void session.refreshCourses()
    const answered = reply?.cards.find((c) => c.type === 'book_answer')
    if (book && answered && reply) { book.onAnswer(reply.content); book.onClearSelection() }
    const said = (r as TurnResponse & { profile?: { language?: Language } }).profile?.language
    if (said && said !== language) { setLanguage(said); prefs.setLanguage(said) }
    else if (voiceOut && reply?.role === 'agent') speak([reply.content], language as VoiceLang)
    // the agent acted: open the workspace it started (the student can cancel within a moment)
    const auto = reply?.cards.find((c) => c.type === 'links' && c.auto)?.links?.[0]
    if (auto) {
      setOpening(auto)
      openTimer.current = window.setTimeout(() => { setOpening(null); onClose?.(); navigate(auto.href) }, 1400)
    }
  }
  const submit = async (text: string, from: 'text' | 'voice' = source, extra: { documentId?: string; documentTitle?: string; intake?: { id: string; answers: Record<string, string>; review: boolean } } = {}) => {
    const message = text.trim()
    if (!message || send.busy) return
    stopSpeaking()
    setDraft('')
    setMessages((m) => [...m, { id: `local-${Date.now()}`, role: 'student', kind: 'text', content: message, cards: [], createdAt: new Date().toISOString(), seen: true }])
    const context = book ? { bookId: book.bookId, pageNo: book.pageNo, blockId: book.blockId, selection: book.selection } : undefined
    setLive([])
    const r = await send.run(() => streamTurn(A, { conversationId: view.conversationId, message, language, source: from, context, ...extra }, (st) => setLive((l) => (l.at(-1)?.text === st.text ? l : [...l, st]))))
    setLive([])
    setSource('text')
    if (r) apply(r)
    else setDraft(message)
  }
  // ── upload from the chat: the file goes to the course's materials, is read, then the tutor teaches from it ──
  const attach = async (file: File) => {
    // the course of THIS conversation right now (it may have been chosen or created a moment ago)
    const fresh = book ? null : await api.get<AgentView>(`${A}?language=${language}`).catch(() => null)
    const prof = fresh?.profile ?? view.profile
    const list = fresh?.courses ?? view.courses
    // no subject yet is fine: the document itself will tell us what it is about
    let target = book?.courseId ?? prof.courseId ?? (list.length === 1 ? list[0]!.id : '')
    const check = checkUpload(file.name, file.size, file.type)
    if ('error' in check) { setUp({ name: file.name, phase: 'error', progress: 0, error: /\.(jpe?g|png|heic|webp)$/i.test(file.name) ? 'Photos cannot be read yet. Please upload a PDF, DOCX, PPTX or TXT file (you can save photos as a PDF).' : check.error }); return }
    setUp({ name: file.name, phase: 'uploading', progress: 0 })
    try {
      const up1 = await uploadMaterial(target || null, file, check.mime, (progress) => setUp((u) => (u ? { ...u, progress } : u)))
      const documentId = up1.documentId
      if (!target && up1.courseId) { target = up1.courseId; void session.refreshCourses() }
      setUp({ name: file.name, phase: 'reading', progress: 1 })
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => window.setTimeout(r, 2000))
        const list = await api.get<Material[]>(`${TUTOR}/courses/${target}/materials`)
        const doc = list.find((m) => m.documentId === documentId)
        // ready OR failed: the tutor reports on the file in the conversation (never pretends a failed file was read)
        if (doc?.status === 'ready' || doc?.status === 'failed') {
          setUp(null)
          await submit(`I have uploaded my notes: ${file.name}. Teach me from them.`, 'text', { documentId, documentTitle: file.name })
          return
        }
      }
      throw new Error('Reading the file is taking long. It will appear under Materials when ready.')
    } catch (e) { setUp({ name: file.name, phase: 'error', progress: 0, error: e instanceof Error && !('status' in e) ? e.message : describeError(e) }) }
  }
  const decide = async (id: string, approve: boolean) => {
    stopSpeaking()
    const r = await send.run(() => api.post<TurnResponse>(`${A}/proposals/${id}/${approve ? 'approve' : 'reject'}`, { conversationId: view.conversationId }))
    if (r) apply(r)
  }
  const restart = async () => { await send.run(() => api.post(`${A}/conversations`)); v.reload() }
  const forget = async () => {
    if (!window.confirm('Delete everything the companion remembers about you (goals, conversations, scheduled milestones)? Your course progress and plans stay.')) return
    await send.run(() => api.del(`${A}/memory`))
    v.reload()
  }
  const toggleVoice = () => { const on = !voiceOut; setVoiceOut(on); try { localStorage.setItem('ebs.voiceOut', on ? '1' : '0') } catch { /* private mode */ } if (!on) stopSpeaking() }

  const dock = variant === 'dock'
  return (
    <div className={`uc flex min-h-0 flex-col ${dock ? 'h-full' : 'uc-home'}`}>
      <header className={`flex flex-wrap items-center gap-2 ${dock ? 'border-b border-line px-4 py-3' : 'mb-2'}`}>
        {book ? <p className="min-w-0 flex-1 text-sm font-semibold">Ask about this page</p> : (<>
          <span aria-hidden className="uc-avatar">ए</span>
          <div className="min-w-0 flex-1">
            <p className="font-semibold leading-tight">Ek Bharat tutor</p>
            <p className="truncate text-xs text-muted">{view.state.appliedPlan ? 'Your plan is active — ask anything, or say “continue”' : 'Plans, teaches, tests, revises — all from here'}</p>
          </div>
        </>)}
        <label className="sr-only" htmlFor={`lang-${variant}`}>Language</label>
        <select id={`lang-${variant}`} value={language} onChange={(e) => { const l = e.target.value as Language; setLanguage(l); prefs.setLanguage(l) }} className="uc-pill">
          {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
        </select>
        {canSpeak() ? <button type="button" className={`uc-pill ${voiceOut ? 'uc-pill-on' : ''}`} aria-pressed={voiceOut} onClick={toggleVoice} title="Read replies aloud">{voiceOut ? '🔊 Voice on' : '🔈 Voice off'}</button> : null}
        <details className="relative">
          <summary className="uc-pill cursor-pointer list-none" aria-label="More options">⋯</summary>
          <div className="absolute right-0 z-20 mt-1 grid w-60 gap-1 rounded-xl border border-line bg-surface p-2 shadow-xl">
            <button type="button" className="rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2" onClick={() => void restart()}>New conversation</button>
            <Link to="/today" className="rounded-lg px-3 py-2 text-sm hover:bg-surface-2">Today's dashboard</Link>
            <button type="button" className="rounded-lg px-3 py-2 text-left text-sm text-danger hover:bg-surface-2" onClick={() => void forget()}>Forget what you know about me</button>
          </div>
        </details>
        {onClose ? <button type="button" className="uc-pill" onClick={onClose} aria-label="Close chat">✕</button> : null}
      </header>

      <ol aria-label="Conversation" aria-live="polite" className={`uc-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto ${dock ? 'px-4 py-4' : 'py-4'}`}>
        {fresh && !dock ? (
          <li className="uc-hero">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Your personal learning companion</p>
            <h1 className="mt-2 font-serif text-3xl leading-tight sm:text-4xl" tabIndex={-1}>What do you want to achieve?</h1>
            <p className="mt-2 max-w-xl text-muted">Tell me in your own words — Hindi, English or Hinglish. I'll plan it, teach it in your book, test you when it helps, and keep your revision on track.</p>
          </li>
        ) : null}
        {messages.map((m) => (
          <li key={m.id} className={m.role === 'student' ? 'uc-row-me' : 'uc-row-ai'}>
            {m.role === 'agent' ? <span aria-hidden title={AGENTS[agentOf(m)].name} className={`uc-avatar uc-avatar-sm ${AGENTS[agentOf(m)].tone}`}>{AGENTS[agentOf(m)].icon}</span> : null}
            <div className="min-w-0">
              {m.role === 'agent' && agentOf(m) !== 'tutor' ? <p className="uc-agent-name">{AGENTS[agentOf(m)].name}</p> : null}
              <div className={m.role === 'student' ? 'uc-me' : m.kind === 'nudge' ? 'uc-ai uc-nudge' : 'uc-ai'}>
                {m.kind === 'nudge' ? <p className="mb-1 text-[0.7rem] font-semibold uppercase tracking-wider text-accent">Reminder</p> : null}
                {m.role === 'agent' ? <Markdown text={m.content} /> : <p className="whitespace-pre-wrap">{m.content}</p>}
              </div>
              {m.cards.map((c, i) => <CardView key={i} card={c} pendingId={pendingId} busy={send.busy} onDecide={decide} last={m.id === messages.at(-1)?.id} onChoose={(t) => void submit(t, 'text')} onIntake={(t, intake) => void submit(t, 'text', { intake })} onResume={book?.onResume} onAttach={() => fileRef.current?.click()} />)}
            </div>
          </li>
        ))}
        {needsGoal && !send.busy ? (
          <li aria-label="Choose a goal">
            <div className={`grid gap-2 ${dock ? 'grid-cols-1' : 'sm:grid-cols-2'}`}>
              {GOALS.map((g) => <button key={g.label} type="button" className="uc-goal" onClick={() => void submit(g.say, 'text')}><span aria-hidden className="text-lg">{g.icon}</span><span>{g.label}</span></button>)}
            </div>
            <p className="mt-2 text-xs text-muted">…or describe your goal in your own words below.</p>
          </li>
        ) : null}
        {send.busy ? (
          <li className="uc-row-ai" role="status" aria-live="polite">
            <span aria-hidden className={`uc-avatar uc-avatar-sm ${AGENTS[live.at(-1)?.agent ?? 'tutor'].tone}`}>{AGENTS[live.at(-1)?.agent ?? 'tutor'].icon}</span>
            <div className="uc-work">
              {live.length ? live.map((st, i) => (
                <p key={i} className={i === live.length - 1 ? 'uc-work-now' : 'uc-work-done'}>
                  <span aria-hidden>{i === live.length - 1 ? <span className="uc-spinner inline-block align-[-2px]" /> : '✓'}</span> <span className="uc-work-who">{AGENTS[st.agent].name}</span> {st.text}
                </p>
              )) : <span className="uc-typing" aria-label="Thinking"><i /><i /><i /></span>}
            </div>
          </li>
        ) : null}
        <div ref={end} />
      </ol>

      {book?.notice ? (
        <div role="status" className="uc-opening mx-3">
          <span className="flex-1">{book.notice.text}</span>
          {book.notice.canResume ? <button type="button" className="font-semibold text-accent" onClick={book.onResume}>Back to the lesson</button> : null}
        </div>
      ) : null}
      {opening ? (
        <div role="status" className="uc-opening">
          <span className="uc-spinner" aria-hidden />
          <span className="flex-1">Opening <b>{opening.label}</b>…</span>
          <button type="button" className="font-semibold text-accent" onClick={() => { window.clearTimeout(openTimer.current); setOpening(null) }}>Stay here</button>
        </div>
      ) : null}

      {up ? (
        <div role="status" className={`uc-opening ${dock ? 'mx-3' : ''}`}>
          {up.phase === 'error' ? <span aria-hidden>⚠️</span> : <span className="uc-spinner" aria-hidden />}
          <span className="flex-1">{up.phase === 'uploading' ? `Uploading ${up.name}… ${Math.round(up.progress * 100)}%` : up.phase === 'reading' ? `Reading ${up.name} — this takes a few seconds per page…` : up.error}</span>
          {up.phase === 'error' ? <button type="button" className="font-semibold text-accent" onClick={() => setUp(null)}>OK</button> : null}
        </div>
      ) : null}
      {book?.selection ? (
        <div className="mx-3 mt-2 flex items-start gap-2 rounded-lg bg-surface-2 p-2 text-xs">
          <span className="line-clamp-3 flex-1">About: “{book.selection}” <span className="text-muted">(p. {book.pageNo})</span></span>
          <button type="button" aria-label="Remove selection" onClick={book.onClearSelection}>✕</button>
        </div>
      ) : null}
      <form className={`uc-composer ${dock ? 'm-3' : 'mt-2'}`} onSubmit={(e) => { e.preventDefault(); void submit(draft || (book?.selection ? 'Explain this simply' : '')) }}>
        <label htmlFor={`msg-${variant}`} className="sr-only">Message</label>
        <textarea id={`msg-${variant}`} rows={dock ? 2 : 2} value={draft} onChange={(e) => { setDraft(e.target.value); stopSpeaking() }} maxLength={4000}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(draft) } }}
          placeholder={book ? (book.selection ? 'What about it? (explain simply, give an example…)' : `Ask about page ${book.pageNo}, or say “quiz me”, “continue”…`) : needsGoal ? 'e.g. "Mera Chemistry exam 7 din mein hai, Acids Bases Salts samjhao"' : 'Ask anything, or say “continue”, “quiz me”, “revise”, “show my weak topics”…'}
          className="min-h-[3rem] w-full flex-1 resize-none bg-transparent px-1 py-2 outline-none placeholder:text-faint" />
        <div className="flex items-center gap-1">
          <input ref={fileRef} type="file" hidden accept=".pdf,.docx,.pptx,.txt,application/pdf,text/plain,image/*" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void attach(f) }} />
          <button type="button" className="uc-pill" aria-label="Attach notes or a PDF" title="Attach your notes (PDF, DOCX, PPTX, TXT)" disabled={send.busy || up?.phase === 'uploading' || up?.phase === 'reading'} onClick={() => fileRef.current?.click()}>📎</button>
          {book || courseId ? <MicButton courseId={book?.courseId ?? courseId} language={language} disabled={send.busy} onStart={stopSpeaking} onText={(t) => { setSource('voice'); setDraft((d) => (d.trim() ? `${d.trim()} ${t}` : t)) }} /> : null}
          <Button type="submit" variant="primary" busy={send.busy} disabled={!draft.trim() && !book?.selection} aria-label="Send">Send</Button>
        </div>
      </form>
      {send.error ? <div className="px-3 pb-3"><ErrorNote error={send.error} /></div> : null}
    </div>
  )
}

function CardView({ card, pendingId, busy, onDecide, last, onChoose, onIntake, onResume, onAttach }: { card: AgentCard; pendingId: string | null; busy: boolean; onDecide: (id: string, approve: boolean) => void; last: boolean; onChoose: (text: string) => void; onIntake: (summary: string, intake: { id: string; answers: Record<string, string>; review: boolean }) => void; onResume?: () => void; onAttach: () => void }) {
  if (card.type === 'intake' && card.intake) return last ? <IntakeCard intake={card.intake} busy={busy} onSubmit={onIntake} /> : <p className="mt-1 text-xs text-muted">Answers sent</p>
  if (card.type === 'upload') return last ? <div className="mt-2"><button type="button" className="uc-action" disabled={busy} onClick={onAttach}>📎 Attach your PDF or notes</button><p className="mt-1 text-xs text-muted">PDF, DOCX, PPTX or TXT · I read it, then build your plan from it</p></div> : null
  if (card.type === 'choices' && card.choices?.length) {
    if (!last) return null
    return <div className="mt-2 flex flex-wrap gap-2" aria-label="Quick answers">{card.choices.map((c) => <button key={c} type="button" disabled={busy} className="uc-goal min-h-0 py-2" onClick={() => onChoose(c)}>{c}</button>)}</div>
  }
  if (card.type === 'book_answer') return card.bookAnswer?.resumeTo && onResume && last ? <div className="mt-2"><button type="button" className="uc-action" onClick={onResume}>Back to the lesson (p. {card.bookAnswer.resumeTo.pageNo}) <span aria-hidden>→</span></button></div> : <p className="mt-1 text-xs text-muted">Saved to your notebook</p>
  if (card.type === 'plan_proposal' && card.proposal) return <ProposalCard p={card.proposal} pending={pendingId === card.proposal.id} busy={busy} onDecide={onDecide} />
  if (card.type === 'workflow' && card.workflow) {
    return (
      <ul aria-label="What I did" className="uc-steps">
        {card.workflow.steps.map((s) => <li key={s.name} className={`uc-step uc-step-${s.status}`}><span aria-hidden>{STEP_ICON[s.status] ?? '○'}</span>{s.name}{s.status === 'failed' ? ' — not finished' : s.status === 'skipped' ? ' — skipped' : ''}</li>)}
      </ul>
    )
  }
  if (card.type === 'agenda' && card.agenda) return <AgendaCard agenda={card.agenda} title="Today's session" />
  if (card.type === 'links' && card.links?.length) return <div className="mt-2 flex flex-wrap gap-2">{card.links.map((l) => <Link key={l.href} to={l.href} className="uc-action">{l.label} <span aria-hidden>→</span></Link>)}</div>
  if (card.type === 'sources' && card.sources?.length) return <ul className="mt-2 grid gap-1 text-sm">{card.sources.map((s) => <li key={s.href}><Link to={s.href} className="text-accent underline">{s.filename}, {s.pages}</Link></li>)}</ul>
  return null
}

/** Every onboarding question that still matters, together; one "Start learning" sends them all. */
function IntakeCard({ intake, busy, onSubmit }: { intake: IntakeView; busy: boolean; onSubmit: (summary: string, intake: { id: string; answers: Record<string, string>; review: boolean }) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries(intake.questions.filter((q) => q.default).map((q) => [q.slot, q.default!])))
  const [custom, setCustom] = useState<Record<string, string>>({})
  const [review, setReview] = useState(false)
  const shown = visibleQuestions(intake.questions, answers)
  const { answers: payload, summary, missing } = intakePayload(intake.questions, answers, custom)
  const done = shown.filter((q) => payload[q.slot]).length
  return (
    <form className="uc-plan mt-2 grid gap-3" aria-label="Personalise your learning" onSubmit={(e) => { e.preventDefault(); if (!missing.length && !busy) onSubmit(summary, { id: intake.id, answers: payload, review }) }}>
      <p className="text-sm font-semibold">Personalise your learning <span className="font-normal text-muted" aria-live="polite">· {done} of {shown.length} answered</span></p>
      {shown.map((q, i) => (
        <fieldset key={q.slot} className="grid gap-1">
          <legend className="text-sm font-medium">{i + 1}. {q.label}{q.required ? <span className="text-muted"> (required)</span> : q.default ? null : <span className="text-muted"> (optional)</span>}</legend>
          <div className="flex flex-wrap gap-2">
            {[...q.options, ...(q.allowCustom ? [{ value: CUSTOM, label: 'Other…' }] : [])].map((o) => (
              <label key={o.value} className={`uc-goal min-h-0 cursor-pointer py-2 ${answers[q.slot] === o.value ? 'ring-2 ring-accent' : ''}`}>
                <input type="radio" className="sr-only" name={`${intake.id}-${q.slot}`} value={o.value} checked={answers[q.slot] === o.value} onChange={() => setAnswers((a) => ({ ...a, [q.slot]: o.value }))} />{o.label}
              </label>
            ))}
          </div>
          {answers[q.slot] === CUSTOM ? <input type="text" maxLength={160} className="rounded border px-2 py-1" aria-label={`${q.label}: your own answer`} placeholder="Type your answer" value={custom[q.slot] ?? ''} onChange={(e) => setCustom((c) => ({ ...c, [q.slot]: e.target.value }))} /> : null}
        </fieldset>
      ))}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} />Show me the plan before we start</label>
      <div><Button type="submit" variant="primary" busy={busy} disabled={missing.length > 0}>Start learning</Button></div>
    </form>
  )
}

function ProposalCard({ p, pending, busy, onDecide }: { p: ProposalView; pending: boolean; busy: boolean; onDecide: (id: string, approve: boolean) => void }) {
  const r = p.roadmap
  const tone = r.feasibility === 'comfortable' ? 'text-ok' : r.feasibility === 'tight' ? 'text-warn' : 'text-danger'
  const selfPaced = !p.inputs.examDate
  return (
    <section className="uc-plan">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[0.7rem] font-semibold uppercase tracking-[0.16em] text-accent">Your learning roadmap · {p.courseTitle}</p>
        <span className="uc-tag">{selfPaced ? 'Self-paced' : `Exam ${p.inputs.examDate}`}</span>
      </div>
      <p className={`mt-2 font-semibold ${tone}`}>{selfPaced ? `About ${hours(r.requiredMinutes)} of focused work, at your pace` : `${FEASIBILITY_LABEL[r.feasibility]}: ${hours(r.requiredMinutes)} of work, ${hours(r.availableMinutes)} available`}{!selfPaced && r.suggestedDailyMinutes ? ` — about ${r.suggestedDailyMinutes} min/day would fit everything` : ''}</p>
      {p.strategy ? <p className="mt-1 text-sm text-muted">Approach: <b className="text-fg">{p.strategy.label}</b></p> : null}
      <ol className="uc-timeline">
        {r.milestones.map((m, i) => (
          <li key={m.seq}>
            <span className="uc-dot" aria-hidden>{i + 1}</span>
            <div><p className="font-semibold">{m.title.replace(/^(Week \d+|Step \d+): /, '')}</p><p className="text-xs text-muted">{selfPaced ? 'then a short check' : `by ${m.due} · then a short check`}</p></div>
          </li>
        ))}
      </ol>
      {r.gaps.length ? <p className="mt-2 text-sm"><b>Strengthen first:</b> {r.gaps.join(', ')}</p> : null}
      {p.examEvidence ? <p className="mt-1 text-xs text-muted">{p.examEvidence.papers ? `Priorities use ${p.examEvidence.papers} past/sample paper(s).` : 'No past papers yet — priorities follow the syllabus. You can add papers any time.'}</p> : null}
      {r.dropped.length ? <p className="mt-1 text-sm text-danger">Not covered in time: {r.dropped.map((x) => x.name).join(', ')}.</p> : null}
      <details className="mt-2 text-sm"><summary className="cursor-pointer text-muted">Why this order</summary><ul className="mt-1 list-disc pl-5 text-muted">{r.rationale.map((x) => <li key={x}>{x}</li>)}</ul></details>
      {pending ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" busy={busy} onClick={() => onDecide(p.id, true)}>Looks good — start</Button>
          <Button busy={busy} onClick={() => onDecide(p.id, false)}>Change something</Button>
        </div>
      ) : null}
    </section>
  )
}

function AgendaCard({ agenda, title }: { agenda: { items: { kind: string; label: string; minutes: number; href?: string }[]; totalMinutes: number }; title: string }) {
  return (
    <section className="uc-plan">
      <p className="text-[0.7rem] font-semibold uppercase tracking-[0.16em] text-accent">{title} · about {agenda.totalMinutes} min</p>
      <ol className="mt-2 grid gap-1">{agenda.items.map((i) => <li key={i.label} className="text-sm">{i.href ? <Link to={i.href} className="font-semibold text-accent">{i.label}</Link> : i.label} <span className="text-muted">· {i.minutes} min</span></li>)}</ol>
    </section>
  )
}
