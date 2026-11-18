import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { TUTOR, api } from '../lib/api.ts'
import { Button, Card, ErrorNote, Notice, PageHeader, Skeleton, inputCls, useAction, useLoad } from '../ui/kit.tsx'
import { Markdown } from '../ui/Markdown.tsx'
import { DiagnosisPanel } from '../ui/Diagnosis.tsx'
import { NextStep } from '../ui/NextStep.tsx'
import { useCourse } from './CourseLayout.tsx'

type QType = 'mcq' | 'numeric' | 'expression' | 'short' | 'descriptive'
interface Question { itemId: string; section: number; sectionTitle: string; type: QType; stem: string; points: number; conceptName: string; options?: string[]; multiple?: boolean; unit?: string }
interface Criterion { id: string; criterion: string; points: number; awarded: number; feedback: string; missing: string[] }
interface ResultRow extends Question {
  response: unknown; points: number; maxPoints: number; needsReview: boolean; reviewNote: string | null; gradedBy: string; feedback: string; criteria: Criterion[] | null
  incorrectAssumptions: string[]; correctAnswer: string; explanation: string; attemptId: string | null; overridden: boolean
}
interface Summary { score: number; maxScore: number; percent: number | null; pendingReview: number; byConcept: { name: string; points: number; maxPoints: number; percent: number | null }[]; byType: { type: QType; percent: number | null }[]; strengths: string[]; weaknesses: string[]; recallNotApplied: string[]; confidentWrong: number }
export interface AttemptView {
  id: string; title: string; mode: string; status: 'in_progress' | 'grading' | 'graded' | 'needs_review'; deadlineAt: string | null; serverNow: string; sections: string[]
  grading?: { runs: number; lastError: string | null; startedAt: string | null; maxAiRuns: number }
  questions?: Question[]; drafts?: Record<string, { response: unknown; confidence: string | null }>
  score?: number | null; maxScore?: number | null; summary?: Summary | null; results?: ResultRow[]
}

const TYPE_LABEL: Record<QType, string> = { mcq: 'Multiple choice', numeric: 'Numerical', expression: 'Expression', short: 'Short answer', descriptive: 'Written answer' }
const objective = (t: QType) => t === 'mcq' || t === 'numeric' || t === 'expression'

export default function TakeAssessment() {
  const course = useCourse()
  const { attemptId = '' } = useParams()
  const v = useLoad(`attempt:${attemptId}`, (sig) => api.get<AttemptView>(`${TUTOR}/assessment-attempts/${attemptId}`, sig))
  const base = `/app/education/tutor/courses/${course.id}`
  if (v.loading && !v.data) return <Skeleton lines={8} />
  if (v.error) return <ErrorNote error={v.error} retry={v.reload} />
  const a = v.data!
  return a.status === 'in_progress' ? <Attempt a={a} onDone={(r) => v.setData(r)} /> : <Results a={a} base={base} courseId={course.id} />
}

function useCountdown(deadlineAt: string | null, serverNow: string) {
  const offset = useMemo(() => new Date(serverNow).getTime() - Date.now(), [serverNow])
  const [left, setLeft] = useState<number | null>(deadlineAt ? new Date(deadlineAt).getTime() - (Date.now() + offset) : null)
  useEffect(() => {
    if (!deadlineAt) return
    const t = window.setInterval(() => setLeft(new Date(deadlineAt).getTime() - (Date.now() + offset)), 1000)
    return () => window.clearInterval(t)
  }, [deadlineAt, offset])
  return left
}

function Attempt({ a, onDone }: { a: AttemptView; onDone: (r: AttemptView) => void }) {
  const [answers, setAnswers] = useState<Record<string, { response: unknown; confidence: string | null }>>(a.drafts ?? {})
  const [saved, setSaved] = useState<Record<string, 'saving' | 'saved' | 'error'>>({})
  const [confirming, setConfirming] = useState(false)
  const timers = useRef<Record<string, number>>({})
  const submitA = useAction()
  const left = useCountdown(a.deadlineAt, a.serverNow)
  const questions = a.questions ?? []

  const save = (itemId: string, next: { response: unknown; confidence: string | null }) => {
    setAnswers((s) => ({ ...s, [itemId]: next }))
    window.clearTimeout(timers.current[itemId])
    timers.current[itemId] = window.setTimeout(async () => {
      setSaved((s) => ({ ...s, [itemId]: 'saving' }))
      try { await api.put(`${TUTOR}/assessment-attempts/${a.id}/responses`, { itemId, ...next }); setSaved((s) => ({ ...s, [itemId]: 'saved' })) } catch { setSaved((s) => ({ ...s, [itemId]: 'error' })) }
    }, 700)
  }
  const submit = async () => {
    // flush pending autosaves first so the last keystrokes are included
    await Promise.all(Object.entries(timers.current).map(async ([itemId, t]) => {
      window.clearTimeout(t)
      const ans = answers[itemId]
      if (ans) await api.put(`${TUTOR}/assessment-attempts/${a.id}/responses`, { itemId, ...ans }).catch(() => undefined)
    }))
    timers.current = {}
    const r = await submitA.run(() => api.post<AttemptView>(`${TUTOR}/assessment-attempts/${a.id}/submit`))
    if (r) onDone(r)
  }
  useEffect(() => { if (left !== null && left <= 0) void submit() }, [left !== null && left <= 0]) // eslint-disable-line react-hooks/exhaustive-deps

  const answeredCount = questions.filter((q) => { const x = answers[q.itemId]?.response; return x !== undefined && x !== null && x !== '' && !(Array.isArray(x) && !x.length) }).length
  const mm = left !== null ? Math.max(0, Math.floor(left / 60000)) : null
  const ss = left !== null ? Math.max(0, Math.floor((left % 60000) / 1000)) : null
  let lastSection = -1
  return (
    <>
      <PageHeader title={a.title} eyebrow="Assessment" />
      <div className="sticky top-[3.6rem] z-10 -mx-4 mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-line bg-bg/95 px-4 py-2 md:top-0">
        <p className="text-sm text-fg-soft">{answeredCount} of {questions.length} answered · answers save automatically</p>
        {left !== null ? <p role="timer" aria-live={left < 120000 ? 'assertive' : 'off'} className={`font-mono text-sm font-semibold ${left < 120000 ? 'text-danger' : ''}`}>Time left {mm}:{String(ss).padStart(2, '0')}</p> : null}
      </div>
      <ol className="space-y-4">
        {questions.map((q, i) => {
          const header = q.section !== lastSection ? (lastSection = q.section, <h2 className="mt-6 text-lg font-semibold">{q.sectionTitle}</h2>) : null
          const ans = answers[q.itemId] ?? { response: null, confidence: null }
          return (
            <li key={q.itemId}>
              {header}
              <Card aria-labelledby={`q-${q.itemId}`}>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                  <span id={`q-${q.itemId}`} className="font-semibold">Question {i + 1} · {TYPE_LABEL[q.type]} · {q.points} mark{q.points === 1 ? '' : 's'}</span>
                  <span aria-live="polite">{saved[q.itemId] === 'saving' ? 'Saving…' : saved[q.itemId] === 'saved' ? 'Saved' : saved[q.itemId] === 'error' ? <span className="text-danger">Not saved — check your connection</span> : null}</span>
                </div>
                <Markdown text={q.stem} />
                <div className="mt-3"><AnswerInput q={q} value={ans.response} onChange={(r) => save(q.itemId, { ...ans, response: r })} /></div>
                {objective(q.type) ? (
                  <fieldset className="mt-3 flex flex-wrap items-center gap-3 text-sm">
                    <legend className="mb-1 text-xs font-semibold text-fg-soft">How sure are you?</legend>
                    {(['sure', 'unsure', 'guess'] as const).map((c) => (
                      <label key={c} className="inline-flex min-h-11 items-center gap-2"><input type="radio" name={`conf-${q.itemId}`} checked={ans.confidence === c} onChange={() => save(q.itemId, { ...ans, confidence: c })} className="h-4 w-4 accent-[var(--color-accent)]" />{c === 'sure' ? 'Sure' : c === 'unsure' ? 'Not sure' : 'Guessing'}</label>
                    ))}
                  </fieldset>
                ) : null}
              </Card>
            </li>
          )
        })}
      </ol>
      <div className="mt-6">
        {submitA.error ? <div className="mb-2"><ErrorNote error={submitA.error} /></div> : null}
        {confirming ? (
          <Notice tone="warn" icon="alert" title={`Submit now? ${questions.length - answeredCount ? `${questions.length - answeredCount} question(s) are unanswered.` : 'All questions answered.'}`}>
            <div className="mt-2 flex gap-2"><Button variant="primary" busy={submitA.busy} onClick={() => void submit()}>Submit for marking</Button><Button variant="ghost" onClick={() => setConfirming(false)}>Keep working</Button></div>
          </Notice>
        ) : <Button variant="primary" onClick={() => setConfirming(true)}>Finish and submit</Button>}
      </div>
    </>
  )
}

function AnswerInput({ q, value, onChange }: { q: Question; value: unknown; onChange: (v: unknown) => void }) {
  const id = `a-${q.itemId}`
  if (q.type === 'mcq') {
    const chosen = Array.isArray(value) ? value.map(String) : typeof value === 'string' ? [value] : []
    return (
      <fieldset className="grid gap-2">
        <legend className="sr-only">Choose {q.multiple ? 'all that apply' : 'one'}</legend>
        {q.options!.map((o) => (
          <label key={o} className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-3 ${chosen.includes(o) ? 'border-accent bg-src-course-bg' : 'border-line'}`}>
            <input type={q.multiple ? 'checkbox' : 'radio'} name={id} checked={chosen.includes(o)} className="h-4 w-4 accent-[var(--color-accent)]"
              onChange={(e) => onChange(q.multiple ? (e.target.checked ? [...chosen, o] : chosen.filter((x) => x !== o)) : o)} />
            <span className="min-w-0"><Markdown text={o} /></span>
          </label>
        ))}
        {q.multiple ? <p className="text-xs text-muted">Select all that apply.</p> : null}
      </fieldset>
    )
  }
  if (q.type === 'descriptive') {
    return (<><label htmlFor={id} className="sr-only">Your answer</label>
      <textarea id={id} rows={7} maxLength={8000} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} className={inputCls} placeholder="Explain your reasoning in full sentences." /></>)
  }
  return (<><label htmlFor={id} className="sr-only">Your answer</label>
    <div className="flex items-center gap-2">
      <input id={id} inputMode={q.type === 'numeric' ? 'decimal' : 'text'} autoComplete="off" spellCheck={q.type === 'short'} maxLength={q.type === 'short' ? 300 : 500}
        value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} className={`${inputCls} ${q.type === 'short' ? '' : 'w-56 font-mono'}`}
        placeholder={q.type === 'numeric' ? 'Your number' : q.type === 'expression' ? 'e.g. 2*x + 1' : 'Your answer'} />
      {q.unit ? <span className="text-sm text-muted">{q.unit}</span> : null}
    </div></>)
}

const show = (r: unknown) => (r === null || r === undefined || r === '' ? 'No answer' : Array.isArray(r) ? r.join(', ') : String(r))

function Results({ a, base, courseId }: { a: AttemptView; base: string; courseId: string }) {
  const s = a.summary
  return (
    <>
      <PageHeader title={a.title} eyebrow="Results" />
      {a.status === 'grading' ? (
        <Notice tone={a.grading?.lastError ? 'warn' : 'info'} icon="clock" title={a.grading?.lastError ? 'Marking was interrupted — retrying automatically' : 'Marking in progress'}>
          Your answers are saved and submitted. {a.grading?.lastError ? 'We will keep retrying; if automatic marking keeps failing, your educator will mark your written answers.' : 'Refresh in a moment.'}
          {a.grading && a.grading.runs > 1 ? ` (attempt ${a.grading.runs})` : ''}
        </Notice>
      ) : null}
      {s ? (
        <Card className="mb-4">
          <p className="text-3xl font-bold">{s.score}<span className="text-lg font-semibold text-muted"> / {s.maxScore}</span>{s.percent !== null ? <span className="ml-2 text-base text-muted">({s.percent}%)</span> : null}</p>
          {s.pendingReview ? <p className="mt-1 text-sm text-warn">{s.pendingReview} answer{s.pendingReview === 1 ? ' is' : 's are'} waiting for your educator to confirm the mark; the score above counts only confirmed marks.</p> : null}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div><h2 className="text-sm font-semibold text-fg-soft">By concept</h2><ul className="mt-1 text-sm">{s.byConcept.map((c) => <li key={c.name}>{c.name}: {c.points}/{c.maxPoints}{c.percent !== null ? ` (${c.percent}%)` : ' (pending)'}</li>)}</ul></div>
            <div><h2 className="text-sm font-semibold text-fg-soft">By question type</h2><ul className="mt-1 text-sm">{s.byType.map((t) => <li key={t.type}>{TYPE_LABEL[t.type]}: {t.percent !== null ? `${t.percent}%` : 'pending'}</li>)}</ul></div>
          </div>
          {s.strengths.length ? <p className="mt-3 text-sm"><span className="font-semibold text-ok">Strong:</span> {s.strengths.join(', ')}</p> : null}
          {s.weaknesses.length ? <p className="mt-1 text-sm"><span className="font-semibold text-warn">Needs work:</span> {s.weaknesses.join(', ')}</p> : null}
          {s.recallNotApplied.length ? <p className="mt-1 text-sm">You recall {s.recallNotApplied.join(', ')} well but found applying it harder — practise problems in new situations next.</p> : null}
          {s.confidentWrong ? <p className="mt-1 text-sm">{s.confidentWrong} answer{s.confidentWrong === 1 ? '' : 's'} you were sure about {s.confidentWrong === 1 ? 'was' : 'were'} wrong — worth revisiting.</p> : null}
          <p className="mt-2 text-xs text-muted">Missed questions were added to your revision cards. Written answers were marked against a rubric by AI and checked automatically; uncertain marks go to your educator.</p>
        </Card>
      ) : null}
      <NextStep courseId={courseId} base={base} />
      <ol className="space-y-4">
        {(a.results ?? []).map((r, i) => {
          return (
            <li key={r.itemId}>
              <Card>
                <p className="mb-2 text-xs font-semibold text-muted">Question {i + 1} · {TYPE_LABEL[r.type]} · {r.conceptName}</p>
                <Markdown text={r.stem} />
                <p className="mt-2 text-sm"><span className="font-semibold">Your answer:</span> <span className="whitespace-pre-wrap">{show(r.response)}</span></p>
                <p className={`mt-1 text-sm font-semibold ${r.needsReview ? 'text-warn' : r.points > 0 ? 'text-ok' : 'text-danger'}`}>
                  {r.needsReview ? `Provisional: ${r.reviewNote}` : `${resultPoints(r)}`}{r.overridden ? ' · marked by your educator' : ''}
                </p>
                {r.criteria?.length ? (
                  <ul className="mt-2 space-y-1 text-sm">{r.criteria.map((c) => (
                    <li key={c.id} className="rounded-md bg-surface-2 p-2"><span className="font-semibold">{c.awarded}/{c.points}</span> · {c.criterion}{c.feedback ? <span className="block text-fg-soft">{c.feedback}</span> : null}{c.missing.length ? <span className="block text-xs text-muted">Missing: {c.missing.join('; ')}</span> : null}</li>
                  ))}</ul>
                ) : null}
                {r.incorrectAssumptions?.length ? <p className="mt-1 text-sm text-warn">Check this: {r.incorrectAssumptions.join('; ')}</p> : null}
                {r.feedback && !r.criteria ? <p className="mt-1 text-sm text-fg-soft">{r.feedback}</p> : r.feedback ? <p className="mt-2 text-sm text-fg-soft">{r.feedback}</p> : null}
                <details className="mt-2 text-sm"><summary className="cursor-pointer font-semibold text-accent">Answer and explanation</summary>
                  <p className="mt-1"><span className="font-semibold">Answer:</span> {r.correctAnswer}</p>{r.explanation ? <div className="mt-1"><Markdown text={r.explanation} /></div> : null}</details>
                {!r.needsReview && r.attemptId && r.points < r.maxPoints && objective(r.type) ? <div className="mt-3"><DiagnosisPanel attemptId={r.attemptId} /></div> : null}
              </Card>
            </li>
          )
        })}
      </ol>
      <Link to={`${base}/assessments`} className="mt-6 inline-flex min-h-11 items-center font-semibold text-accent hover:underline">Back to assessments</Link>
    </>
  )
}

function resultPoints(r: ResultRow) {
  return `${r.points}/${r.maxPoints} mark${r.maxPoints === 1 ? '' : 's'}`
}
