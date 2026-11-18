import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { TUTOR, api } from '../lib/api.ts'
import { FEASIBILITY_LABEL, hours, type AgentCard, type AgentMessage, type AgentView, type ProposalView, type TurnResponse } from '../lib/agent.ts'
import { prefs } from '../lib/storage.ts'
import { LANGUAGES, type Language } from '../lib/tutor.ts'
import { speak, stopSpeaking, type VoiceLang } from '../lib/voice.ts'
import { Button, Card, ErrorNote, Loading, PageHeader, inputCls, useAction, useLoad } from '../ui/kit.tsx'
import { Markdown } from '../ui/Markdown.tsx'
import { MicButton, ReadAloudToggle } from '../ui/VoiceControls.tsx'

const A = `${TUTOR}/agent`
const STEP_ICON: Record<string, string> = { done: '✓', failed: '!', running: '…', pending: '○', skipped: '–' }

/** Study companion: one conversation that onboards, plans, and runs the student's learning workflow. */
export default function Companion() {
  const [language, setLanguage] = useState<Language>(prefs.language())
  const v = useLoad<AgentView>(`agent:${language}`, (s) => api.get(`${A}?language=${language}`, s))
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [draft, setDraft] = useState('')
  const [readAloud, setReadAloud] = useState(false)
  const [source, setSource] = useState<'text' | 'voice'>('text')
  const send = useAction()
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => { if (v.data) setMessages(v.data.messages) }, [v.data])
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [messages.length])
  useEffect(() => { if (v.data?.messages.some((m) => !m.seen)) void api.post(`${A}/messages/seen`).catch(() => {}) }, [v.data])
  useEffect(() => () => stopSpeaking(), [])

  if (v.loading && !v.data) return <Loading label="Opening your companion" />
  if (v.error || !v.data) return <ErrorNote error={v.error} retry={v.reload} feature="study companion" />
  const view = v.data
  const courseId = view.profile.courseId ?? view.courses[0]?.id ?? ''
  const pendingId = view.state.pendingProposalId

  const apply = (r: TurnResponse) => {
    setMessages((m) => [...m.filter((x) => !x.id.startsWith('local-')), ...r.messages])
    v.setData({ ...view, conversationId: r.conversationId, state: r.state, messages: [...messages.filter((x) => !x.id.startsWith('local-')), ...r.messages], pendingProposal: r.messages.flatMap((m) => m.cards).find((c) => c.type === 'plan_proposal')?.proposal ?? (r.state.pendingProposalId ? view.pendingProposal : null) })
    const reply = r.messages.at(-1)
    if (readAloud && reply?.role === 'agent') speak([reply.content], language as VoiceLang)
  }
  const submit = async (text: string) => {
    const message = text.trim()
    if (!message) return
    stopSpeaking()
    setDraft('')
    setMessages((m) => [...m, { id: `local-${Date.now()}`, role: 'student', kind: 'text', content: message, cards: [], createdAt: new Date().toISOString(), seen: true }])
    const r = await send.run(() => api.post<TurnResponse>(`${A}/messages`, { conversationId: view.conversationId, message, language, source }))
    setSource('text')
    if (r) apply(r)
    else setDraft(message)
  }
  const decide = async (id: string, approve: boolean) => {
    stopSpeaking()
    const r = await send.run(() => api.post<TurnResponse>(`${A}/proposals/${id}/${approve ? 'approve' : 'reject'}`, { conversationId: view.conversationId }))
    if (r) apply(r)
  }
  const restart = async () => {
    await send.run(() => api.post(`${A}/conversations`))
    v.reload()
  }
  const forget = async () => {
    if (!window.confirm('Delete everything the companion remembers about you (goals, conversations, scheduled milestones)? Your course progress and plans stay.')) return
    await send.run(() => api.del(`${A}/memory`))
    v.reload()
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <PageHeader title="Study companion" eyebrow="Your plan, your pace">
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="ag-lang">Language</label>
          <select id="ag-lang" value={language} onChange={(e) => { const l = e.target.value as Language; setLanguage(l); prefs.setLanguage(l) }} className={`${inputCls} w-auto`}>
            {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
          <ReadAloudToggle on={readAloud} onChange={(on) => { setReadAloud(on); if (!on) stopSpeaking() }} />
          <details className="relative">
            <summary className="min-h-11 cursor-pointer list-none rounded-lg border border-line px-3 py-2 text-sm">More</summary>
            <div className="absolute right-0 z-10 mt-1 grid w-56 gap-1 rounded-lg border border-line bg-surface p-2 shadow">
              <button type="button" className="rounded px-2 py-2 text-left text-sm hover:bg-surface-2" onClick={() => void restart()}>New conversation</button>
              <button type="button" className="rounded px-2 py-2 text-left text-sm text-danger hover:bg-surface-2" onClick={() => void forget()}>Forget what you know about me</button>
            </div>
          </details>
        </div>
      </PageHeader>

      {view.state.nextSession?.items.length ? <AgendaCard agenda={view.state.nextSession} title="Your next session" /> : null}

      <Card className="p-0">
        <ol aria-label="Conversation" aria-live="polite" className="flex max-h-[60dvh] min-h-[40dvh] flex-col gap-3 overflow-y-auto p-4">
          {messages.map((m) => (
            <li key={m.id} className={m.role === 'student' ? 'self-end max-w-[85%]' : 'max-w-[95%]'}>
              <div className={m.role === 'student' ? 'rounded-2xl rounded-br-sm bg-navy px-4 py-2 text-on-navy' : m.kind === 'nudge' ? 'rounded-2xl rounded-bl-sm border border-accent/40 bg-accent/10 px-4 py-2' : 'rounded-2xl rounded-bl-sm bg-surface-2 px-4 py-2'}>
                {m.kind === 'nudge' ? <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Reminder</p> : null}
                {m.role === 'agent' ? <Markdown text={m.content} /> : <p className="whitespace-pre-wrap">{m.content}</p>}
              </div>
              {m.cards.map((c, i) => <CardView key={i} card={c} pendingId={pendingId} busy={send.busy} onDecide={decide} />)}
            </li>
          ))}
          {send.busy ? <li className="text-sm text-muted" role="status">Thinking…</li> : null}
          <div ref={end} />
        </ol>
        <form className="flex items-end gap-2 border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); void submit(draft) }}>
          <label htmlFor="ag-input" className="sr-only">Message</label>
          <textarea id="ag-input" rows={2} value={draft} onChange={(e) => { setDraft(e.target.value); stopSpeaking() }} maxLength={4000}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(draft) } }}
            placeholder={view.state.phase === 'onboarding' ? 'e.g. "Mera physics exam 15 Dec ko hai, roz 1 ghanta padh sakta hoon"' : 'Ask, plan, or tell me how it went…'} className={`${inputCls} flex-1 resize-none`} />
          {courseId ? <MicButton courseId={courseId} language={language} disabled={send.busy} onStart={stopSpeaking} onText={(t) => { setSource('voice'); setDraft((d) => (d.trim() ? `${d.trim()} ${t}` : t)) }} /> : null}
          <Button type="submit" variant="primary" busy={send.busy} disabled={!draft.trim()}>Send</Button>
        </form>
        {send.error ? <div className="px-3 pb-3"><ErrorNote error={send.error} /></div> : null}
      </Card>
    </div>
  )
}

function CardView({ card, pendingId, busy, onDecide }: { card: AgentCard; pendingId: string | null; busy: boolean; onDecide: (id: string, approve: boolean) => void }) {
  if (card.type === 'plan_proposal' && card.proposal) return <ProposalCard p={card.proposal} pending={pendingId === card.proposal.id} busy={busy} onDecide={onDecide} />
  if (card.type === 'workflow' && card.workflow) {
    return (
      <ul aria-label="What I did" className="mt-2 grid gap-1 text-sm text-muted">
        {card.workflow.steps.map((s) => <li key={s.name}><span aria-hidden className="inline-block w-5">{STEP_ICON[s.status] ?? '○'}</span>{s.name}{s.status === 'failed' ? ' — not finished' : ''}</li>)}
      </ul>
    )
  }
  if (card.type === 'agenda' && card.agenda) return <AgendaCard agenda={card.agenda} title="Today's session" />
  if (card.type === 'links' && card.links?.length) return <div className="mt-2 flex flex-wrap gap-2">{card.links.map((l) => <Link key={l.href} to={l.href} className="rounded-lg border border-line-strong px-3 py-2 text-sm font-semibold text-accent">{l.label} →</Link>)}</div>
  if (card.type === 'sources' && card.sources?.length) {
    return <ul className="mt-2 grid gap-1 text-sm">{card.sources.map((s) => <li key={s.href}><Link to={s.href} className="text-accent underline">{s.filename}, {s.pages}</Link></li>)}</ul>
  }
  return null
}

function ProposalCard({ p, pending, busy, onDecide }: { p: ProposalView; pending: boolean; busy: boolean; onDecide: (id: string, approve: boolean) => void }) {
  const r = p.roadmap
  const tone = r.feasibility === 'comfortable' ? 'text-ok' : r.feasibility === 'tight' ? 'text-warn' : 'text-danger'
  return (
    <Card className="mt-2 grid gap-3 p-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">Proposed plan · {p.courseTitle}</p>
        <p className="mt-1 text-sm">{p.inputs.examDate ? `Until ${p.inputs.examDate}` : `Next ${r.horizon.days} days`} · {p.inputs.dailyMinutes} min on {p.inputs.studyDaysPerWeek} day(s)/week</p>
        <p className={`mt-1 font-semibold ${tone}`}>{FEASIBILITY_LABEL[r.feasibility]}: {hours(r.requiredMinutes)} of work, {hours(r.availableMinutes)} available{r.suggestedDailyMinutes ? ` — about ${r.suggestedDailyMinutes} min/day would fit everything` : ''}</p>
      </div>
      {p.strategy ? <p className="text-sm"><span className="font-semibold">Strategy: {p.strategy.label}</span> <span className="text-muted">— {Object.entries(p.strategy.mix).filter(([, v]) => v > 0).map(([k, v]) => `${k === 'teachBack' ? 'explain-back' : k} ${Math.round(v * 100)}%`).join(' · ')}</span></p> : null}
      {p.examEvidence ? <p className="text-sm text-muted">{p.examEvidence.papers ? `Priorities use ${p.examEvidence.papers} past/sample paper(s): ${p.examEvidence.top.slice(0, 3).map((t) => `${t.name} (${t.confidence} confidence)`).join(', ')}.` : 'No past papers added yet — priorities follow the syllabus weights. Add papers in Exam insights to sharpen them.'}</p> : null}
      <ol className="grid gap-2">
        {r.milestones.map((m) => (
          <li key={m.seq} className="rounded-lg border border-line p-2 text-sm">
            <span className="font-semibold">{m.title}</span> <span className="text-muted">· by {m.due}</span>
            <span className="block text-xs text-muted">Then: {r.checkpoints.find((c) => c.seq === m.seq)?.title ?? 'checkpoint'}</span>
          </li>
        ))}
      </ol>
      {r.gaps.length ? <p className="text-sm"><span className="font-semibold">Prerequisites to firm up first:</span> {r.gaps.join(', ')}</p> : null}
      {r.dropped.length ? <p className="text-sm text-danger">Not scheduled: {r.dropped.map((x) => x.name).join(', ')} — not enough time.</p> : null}
      <details className="text-sm">
        <summary className="cursor-pointer">Weekly load and reasoning</summary>
        <ul className="mt-1 grid gap-1">{r.weeks.map((w) => <li key={w.week}>Week {w.week} (from {w.start}): learn {w.learn} min · practice {w.practice} min · revision {w.review} min</li>)}</ul>
        <ul className="mt-2 list-disc pl-5 text-muted">{r.rationale.map((x) => <li key={x}>{x}</li>)}</ul>
      </details>
      {pending ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" busy={busy} onClick={() => onDecide(p.id, true)}>Approve plan</Button>
          <Button busy={busy} onClick={() => onDecide(p.id, false)}>Change something</Button>
        </div>
      ) : null}
    </Card>
  )
}

function AgendaCard({ agenda, title }: { agenda: { items: { kind: string; label: string; minutes: number; href?: string }[]; totalMinutes: number }; title: string }) {
  return (
    <Card className="mt-2 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{title} · about {agenda.totalMinutes} min</p>
      <ol className="mt-2 grid gap-1">
        {agenda.items.map((i) => <li key={i.label} className="text-sm">{i.href ? <Link to={i.href} className="font-semibold text-accent">{i.label}</Link> : i.label} <span className="text-muted">· {i.minutes} min</span></li>)}
      </ol>
    </Card>
  )
}
