import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { AgentCard, AgentMessage, IntakeView, ProposalView } from '../../../web/src/lib/agent.ts'
import { post, S } from '../lib/client.ts'
import { CUSTOM, destinationFor, intakePayload, visibleQuestions, type Destination } from '../lib/logic.ts'
import type { Tutor } from '../lib/useTutor.ts'
import { Icon } from './Icon.tsx'
import { MathText, RichText } from './RichText.tsx'

const STARTERS = ['Explain quadratic equations step by step', 'I want to learn Physics class 10, chapter Electricity', 'I have notes and want to learn from them', 'Help me prepare for an exam']

export function ChatPanel({ tutor, open, goDocument }: { tutor: Tutor; open: (d: Destination) => void; goDocument: () => void }) {
  const [draft, setDraft] = useState('')
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [tutor.messages.length, tutor.live.length, tutor.busy])
  const submit = (e?: FormEvent) => { e?.preventDefault(); const t = draft.trim(); if (!t || tutor.busy) return; setDraft(''); void tutor.send(t) }
  const fresh = !tutor.messages.some((m) => m.role === 'student')
  const lastId = tutor.messages.at(-1)?.id
  const ctx = tutor.bookContext
  return (
    <>
      <ol className="td-log" aria-label="Conversation" aria-live="polite">
        {!tutor.view && !tutor.error ? <li className="td-skeleton" aria-label="Loading conversation"><i /><i /><i /></li> : null}
        {tutor.messages.map((m) => <Bubble key={m.id} m={m} last={m.id === lastId} tutor={tutor} open={open} goDocument={goDocument} />)}
        {tutor.busy ? (
          <li className="td-msg is-ai" role="status">
            <div className="td-work">
              {tutor.live.length ? tutor.live.map((s, i) => <p key={s.text} className={i === tutor.live.length - 1 ? 'is-now' : ''}><span aria-hidden>{i === tutor.live.length - 1 ? <b className="td-spin" /> : <Icon name="check" />}</span>{s.text}</p>) : <p className="is-now"><span aria-hidden><b className="td-spin" /></span>Connecting…</p>}
            </div>
          </li>
        ) : null}
        <div ref={end} />
      </ol>
      {tutor.error ? <div role="alert" className="td-chat-error"><span>{tutor.error}</span>{tutor.canRetry ? <button type="button" onClick={tutor.retry}>Retry</button> : <button type="button" onClick={() => tutor.setError(null)}>Dismiss</button>}</div> : null}
      {fresh && tutor.view && !tutor.busy ? <div className="td-starters" aria-label="Suggested prompts">{STARTERS.map((s) => <button key={s} type="button" onClick={() => void tutor.send(s)}>{s}</button>)}</div> : null}
      {ctx ? <div className="td-context"><span>Asking about page {ctx.pageNo}{ctx.selection ? `: “${ctx.selection.slice(0, 70)}${ctx.selection.length > 70 ? '…' : ''}”` : ''}</span>{ctx.selection ? <button type="button" aria-label="Remove selected text" onClick={() => tutor.setBookContext({ ...ctx, selection: null, blockId: null })}><Icon name="close" /></button> : null}</div> : null}
      <form className="td-composer" onSubmit={submit}>
        <button type="button" className="td-icon-btn" onClick={goDocument} aria-label="Upload study material"><Icon name="clip" /></button>
        <label className="td-sr" htmlFor="td-msg">Message Vidya</label>
        <textarea id="td-msg" rows={1} maxLength={4000} value={draft} placeholder={ctx ? 'Ask about this page…' : 'Ask anything, or share your goal…'} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }} />
        <button type="submit" className="td-send" disabled={!draft.trim() || tutor.busy} aria-label="Send"><Icon name="send" /></button>
      </form>
    </>
  )
}

function Bubble({ m, last, tutor, open, goDocument }: { m: AgentMessage; last: boolean; tutor: Tutor; open: (d: Destination) => void; goDocument: () => void }) {
  if (m.role === 'student') return <li className="td-msg is-me"><div><p>{m.content}</p></div></li>
  return (
    <li className="td-msg is-ai">
      <div className="td-ai-text"><RichText text={m.content} /></div>
      {m.cards.map((c, i) => <CardView key={i} card={c} last={last} tutor={tutor} open={open} goDocument={goDocument} />)}
    </li>
  )
}

function CardView({ card, last, tutor, open, goDocument }: { card: AgentCard; last: boolean; tutor: Tutor; open: (d: Destination) => void; goDocument: () => void }) {
  if (card.type === 'choices' && card.choices?.length) return last ? <div className="td-choices">{card.choices.map((c, i) => <button key={`${i}:${c}`} type="button" disabled={tutor.busy} onClick={() => void tutor.send(c)}>{c}</button>)}</div> : null
  if (card.type === 'intake' && card.intake) return last ? <IntakeCard intake={card.intake} tutor={tutor} /> : <p className="td-muted-note">Answers sent</p>
  if (card.type === 'upload') return last ? <button type="button" className="td-link" onClick={goDocument}><Icon name="clip" />Open document upload</button> : null
  if (card.type === 'plan_proposal' && card.proposal) return <PlanCard p={card.proposal} tutor={tutor} />
  if (card.type === 'workflow' && card.workflow) return <ul className="td-steps" aria-label="What the Tutor did">{card.workflow.steps.map((s) => <li key={s.name} className={`is-${s.status}`}>{s.status === 'done' ? <Icon name="check" /> : <span aria-hidden>·</span>}{s.name}{s.status === 'skipped' ? ' (skipped)' : s.status === 'failed' ? ' (not finished)' : ''}</li>)}</ul>
  if (card.type === 'agenda' && card.agenda) return <div className="td-agenda"><strong>Today · about {card.agenda.totalMinutes} min</strong><ul>{card.agenda.items.map((x) => <li key={x.label}><span><MathText text={x.label} /></span><small>{x.minutes} min</small></li>)}</ul></div>
  if (card.type === 'links' && card.links?.length) return <>{card.links.map((l) => { const d = destinationFor(l.href); return d ? <button key={l.href} type="button" className="td-link" onClick={() => open(d)}><Icon name="send" />{l.label}</button> : <p key={l.href} className="td-muted-note">{l.label} is available in the full product.</p> })}</>
  if (card.type === 'sources' && card.sources?.length) return <ul className="td-sources">{card.sources.map((s) => <li key={s.href}>Source: {s.filename}, {s.pages}</li>)}</ul>
  if (card.type === 'book_answer' && card.bookAnswer) {
    const { bookId, resumeTo } = card.bookAnswer
    return resumeTo && last ? <button type="button" className="td-link" onClick={() => void post(`${S}/books/${bookId}/resume`).then(() => { open({ view: 'notebook', bookId }) }, tutor.fail)}><Icon name="book" />Back to the lesson (p. {resumeTo.pageNo})</button> : <p className="td-muted-note">Saved to your notebook</p>
  }
  return null
}

/** Every onboarding question that still matters, together: pick, or type your own; one "Start learning" sends them all. */
function IntakeCard({ intake, tutor }: { intake: IntakeView; tutor: Tutor }) {
  const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries(intake.questions.filter((q) => q.default).map((q) => [q.slot, q.default!])))
  const [custom, setCustom] = useState<Record<string, string>>({})
  const [review, setReview] = useState(false)
  const shown = visibleQuestions(intake.questions, answers)
  const { answers: payload, summary, missing } = intakePayload(intake.questions, answers, custom)
  const done = shown.filter((q) => payload[q.slot]).length
  const submit = (e: FormEvent) => { e.preventDefault(); if (missing.length || tutor.busy) return; void tutor.send(summary, { intake: { id: intake.id, answers: payload, review } }) }
  return (
    <form className="td-intake" onSubmit={submit} aria-label="Personalise your learning">
      <div className="td-intake-head">
        <strong>Personalise your learning</strong>
        <span aria-live="polite">{done} of {shown.length} answered</span>
        <span className="td-bar" aria-hidden><i style={{ width: `${shown.length ? (done / shown.length) * 100 : 0}%` }} /></span>
      </div>
      {shown.map((q, i) => (
        <fieldset key={q.slot}>
          <legend>{i + 1}. {q.label}{q.required ? <em> required</em> : q.default ? null : <em> optional</em>}</legend>
          <div className="td-intake-opts">
            {q.options.map((o) => (
              <label key={o.value} className={answers[q.slot] === o.value ? 'is-on' : ''}>
                <input type="radio" name={`${intake.id}-${q.slot}`} value={o.value} checked={answers[q.slot] === o.value} onChange={() => setAnswers((a) => ({ ...a, [q.slot]: o.value }))} />{o.label}
              </label>
            ))}
            {q.allowCustom ? <label className={answers[q.slot] === CUSTOM ? 'is-on' : ''}><input type="radio" name={`${intake.id}-${q.slot}`} value={CUSTOM} checked={answers[q.slot] === CUSTOM} onChange={() => setAnswers((a) => ({ ...a, [q.slot]: CUSTOM }))} />Other…</label> : null}
          </div>
          {answers[q.slot] === CUSTOM ? <input className="td-intake-custom" type="text" maxLength={160} autoFocus aria-label={`${q.label}: your own answer`} placeholder="Type your answer" value={custom[q.slot] ?? ''} onChange={(e) => setCustom((c) => ({ ...c, [q.slot]: e.target.value }))} /> : null}
        </fieldset>
      ))}
      <label className="td-intake-review"><input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} />Show me the plan before we start</label>
      <button type="submit" className="td-primary" disabled={tutor.busy || missing.length > 0}><Icon name="spark" />{tutor.busy ? 'Preparing…' : 'Start learning'}</button>
    </form>
  )
}

export function PlanCard({ p, tutor }: { p: ProposalView; tutor: Tutor }) {
  const pending = tutor.view?.state.pendingProposalId === p.id
  const r = p.roadmap
  const budget = (r.horizon as { totalMinutes?: number | null }).totalMinutes ?? null
  return (
    <div className="td-plan">
      <p className="td-eyebrow">Proposed roadmap</p>
      <h3>{p.courseTitle}</h3>
      <p className="td-plan-meta">{Math.round(r.requiredMinutes / 6) / 10} h of work · {r.feasibility === 'comfortable' ? 'fits comfortably' : r.feasibility === 'tight' ? 'tight but possible' : 'does not fully fit'}{r.horizon.fixedDate ? ` · by ${r.horizon.end}` : budget ? ` · ${r.horizon.days} day${r.horizon.days === 1 ? '' : 's'} at ${r.effectiveDailyMinutes} min` : ' · self-paced'}</p>
      {r.dropped.length ? <p className="td-muted-note">{budget ? `Your ${Math.round(budget / 6) / 10} h covers ${r.milestones.flatMap((m) => m.conceptIds).length} topics. Not included: ` : 'Not included: '}{r.dropped.slice(0, 4).map((d) => d.name).join(', ')}{r.dropped.length > 4 ? ` +${r.dropped.length - 4} more` : ''}.</p> : null}
      <ol>{r.milestones.map((m) => <li key={m.seq}><span>{m.seq}</span><p><MathText text={m.conceptNames.join(' · ')} /></p></li>)}</ol>
      {pending ? <div className="td-row"><button type="button" className="td-primary" disabled={tutor.busy} onClick={() => void tutor.decide(p.id, true)}>Approve and start</button><button type="button" className="td-ghost" disabled={tutor.busy} onClick={() => void tutor.decide(p.id, false)}>Change something</button></div> : null}
    </div>
  )
}
