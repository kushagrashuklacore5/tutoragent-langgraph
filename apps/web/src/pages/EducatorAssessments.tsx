import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { TUTOR, api } from '../lib/api.ts'
import type { ConceptGraph } from '../lib/tutor.ts'
import { useSession } from '../session.tsx'
import { Button, Card, EmptyState, ErrorNote, Field, Notice, PageHeader, Skeleton, inputCls, useAction, useLoad } from '../ui/kit.tsx'
import { Markdown } from '../ui/Markdown.tsx'

const TYPES = ['mcq', 'numeric', 'expression', 'short', 'descriptive'] as const
type QType = typeof TYPES[number]
const TYPE_LABEL: Record<QType, string> = { mcq: 'Multiple choice', numeric: 'Numerical', expression: 'Expression', short: 'Short answer', descriptive: 'Written (rubric)' }

interface EduAssessment { id: string; title: string; mode: string; timeLimitMinutes: number | null; status: string; maxAttempts: number | null; questionCount: number; adaptive: boolean; sections: { title: string; count: number; types?: string[] }[] }
interface GenResult { accepted: { id: string; stem: string; type: string }[]; rejected: { stem: string; type: string; reasons: string[] }[]; sourcesUsed: number }

export default function EducatorAssessments() {
  const { courseId = '' } = useParams()
  const s = useSession()
  const course = s.courses.find((c) => c.id === courseId)
  const graph = useLoad(`eg:${courseId}`, (sig) => api.get<ConceptGraph>(`${TUTOR}/courses/${courseId}/concepts`, sig))
  const list = useLoad(`ea:${courseId}`, (sig) => api.get<EduAssessment[]>(`${TUTOR}/courses/${courseId}/assessments`, sig))
  const [open, setOpen] = useState<string | null>(null)
  if (!course) return <EmptyState title="Course not found"><Link to="/educator" className="text-accent underline">Back to your courses</Link></EmptyState>
  const concepts = graph.data?.concepts.filter((c) => c.status === 'approved') ?? []
  return (
    <>
      <PageHeader title="Assessments" eyebrow={<Link to={`/educator/courses/${courseId}`} className="hover:underline">{course.code} · {course.title}</Link>} />
      <div className="grid gap-6 xl:grid-cols-2">
        <Generate courseId={courseId} concepts={concepts} />
        <Create courseId={courseId} concepts={concepts} onCreated={list.reload} />
      </div>
      <section aria-labelledby="al-h" className="mt-8">
        <h2 id="al-h" className="mb-3 text-lg font-semibold">Your assessments</h2>
        {list.loading ? <Skeleton /> : list.error ? <ErrorNote error={list.error} retry={list.reload} /> : !list.data!.length ? <p className="text-muted">None yet.</p> : (
          <ul className="grid gap-3">{list.data!.map((a) => (
            <li key={a.id}><Card>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><p className="font-semibold">{a.title}</p><p className="text-xs text-muted">{a.mode} · {a.questionCount} questions{a.timeLimitMinutes ? ` · ${a.timeLimitMinutes} min` : ''} · {a.adaptive ? 'adaptive selection' : 'fixed difficulty'} · <span className={a.status === 'published' ? 'font-semibold text-ok' : ''}>{a.status}</span></p></div>
                <div className="flex gap-2">
                  <StatusButton id={a.id} status={a.status} onChanged={list.reload} />
                  <Button variant="ghost" onClick={() => setOpen(open === a.id ? null : a.id)} aria-expanded={open === a.id}>{open === a.id ? 'Hide results' : 'Results & review'}</Button>
                </div>
              </div>
              {open === a.id ? <AssessmentResults id={a.id} /> : null}
            </Card></li>
          ))}</ul>
        )}
      </section>
    </>
  )
}

function StatusButton({ id, status, onChanged }: { id: string; status: string; onChanged: () => void }) {
  const a = useAction()
  const next = status === 'published' ? 'draft' : 'published'
  return <Button busy={a.busy} onClick={() => void a.run(async () => { await api.put(`${TUTOR}/assessments/${id}`, { status: next }); onChanged() })}>{status === 'published' ? 'Unpublish' : 'Publish'}</Button>
}

function TypePicker({ value, onChange, name }: { value: QType[]; onChange: (v: QType[]) => void; name: string }) {
  return (
    <fieldset><legend className="mb-1 text-sm font-semibold text-fg-soft">Question types</legend>
      <div className="flex flex-wrap gap-2">{TYPES.map((t) => (
        <label key={t} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line px-3 text-sm"><input type="checkbox" name={name} checked={value.includes(t)} onChange={(e) => onChange(e.target.checked ? [...value, t] : value.filter((x) => x !== t))} className="h-4 w-4 accent-[var(--color-accent)]" />{TYPE_LABEL[t]}</label>
      ))}</div>
    </fieldset>
  )
}

function Generate({ courseId, concepts }: { courseId: string; concepts: { id: string; name: string }[] }) {
  const [conceptId, setConceptId] = useState('')
  const [count, setCount] = useState(5)
  const [types, setTypes] = useState<QType[]>(['mcq', 'numeric', 'short', 'descriptive'])
  const [difficulty, setDifficulty] = useState('mixed')
  const [res, setRes] = useState<GenResult | null>(null)
  const a = useAction()
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setRes(null)
    const r = await a.run(() => api.post<GenResult>(`${TUTOR}/courses/${courseId}/items/generate`, { conceptId, count, types, difficulty }))
    if (r) setRes(r)
  }
  return (
    <Card>
      <form onSubmit={submit} className="grid gap-3">
        <h2 className="text-lg font-semibold">Generate questions from course material</h2>
        <p className="text-sm text-muted">Questions are written from your approved (educator-uploaded) material only, checked for grounding, answer-key validity, maths correctness and duplicates, and saved as drafts for your review. Students never see drafts.</p>
        <Field id="gc" label="Concept"><select id="gc" value={conceptId} onChange={(e) => setConceptId(e.target.value)} className={inputCls}><option value="">Choose…</option>{concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field id="gn" label="How many (1-10)"><input id="gn" type="number" min={1} max={10} value={count} onChange={(e) => setCount(Number(e.target.value))} className={inputCls} /></Field>
          <Field id="gd" label="Difficulty"><select id="gd" value={difficulty} onChange={(e) => setDifficulty(e.target.value)} className={inputCls}>{['mixed', 'easy', 'medium', 'hard'].map((x) => <option key={x}>{x}</option>)}</select></Field>
        </div>
        <TypePicker value={types} onChange={setTypes} name="gtypes" />
        {a.error ? <ErrorNote error={a.error} /> : null}
        <Button type="submit" variant="primary" busy={a.busy} disabled={!conceptId || !types.length} className="justify-self-start">Generate drafts</Button>
      </form>
      {res ? (
        <div className="mt-4 space-y-2" aria-live="polite">
          <Notice tone={res.accepted.length ? 'ok' : 'warn'} title={`${res.accepted.length} draft${res.accepted.length === 1 ? '' : 's'} ready for review`}>
            Based on {res.sourcesUsed} passage{res.sourcesUsed === 1 ? '' : 's'} of course material. <Link to={`/educator/courses/${courseId}/questions`} className="font-semibold text-accent underline">Review and approve drafts</Link>
          </Notice>
          {res.rejected.length ? (
            <details className="text-sm"><summary className="cursor-pointer font-semibold">{res.rejected.length} rejected by validation</summary>
              <ul className="mt-1 space-y-1">{res.rejected.map((r, i) => <li key={i} className="rounded bg-surface-2 p-2"><span className="text-xs text-muted">{r.type}</span> {r.stem}<span className="block text-xs text-warn">{r.reasons.join('; ')}</span></li>)}</ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </Card>
  )
}

function Create({ courseId, concepts, onCreated }: { courseId: string; concepts: { id: string; name: string }[]; onCreated: () => void }) {
  const [title, setTitle] = useState('')
  const [mode, setMode] = useState('practice')
  const [limit, setLimit] = useState('')
  const [maxAttempts, setMaxAttempts] = useState('')
  const [adaptive, setAdaptive] = useState(true)
  const [publish, setPublish] = useState(false)
  const [chosen, setChosen] = useState<string[]>([])
  const [count, setCount] = useState(5)
  const [types, setTypes] = useState<QType[]>([])
  const [ok, setOk] = useState(false)
  const a = useAction()
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const r = await a.run(() => api.post(`${TUTOR}/courses/${courseId}/assessments`, {
      title: title.trim(), mode, timeLimitMinutes: limit ? Number(limit) : null, maxAttempts: maxAttempts ? Number(maxAttempts) : null, adaptive, publish,
      sections: [{ title: 'Questions', conceptIds: chosen, count, types, difficulty: adaptive ? 'adaptive' : 'mixed' }],
    }))
    if (r) { setOk(true); setTitle(''); onCreated() }
  }
  return (
    <Card>
      <form onSubmit={submit} className="grid gap-3">
        <h2 className="text-lg font-semibold">Create an assessment</h2>
        <Field id="at" label="Title"><input id="at" value={title} onChange={(e) => { setTitle(e.target.value); setOk(false) }} maxLength={200} className={inputCls} /></Field>
        <div className="grid grid-cols-3 gap-3">
          <Field id="am" label="Mode"><select id="am" value={mode} onChange={(e) => setMode(e.target.value)} className={inputCls}><option value="practice">Practice</option><option value="exam">Exam simulation</option><option value="diagnostic">Diagnostic</option></select></Field>
          <Field id="al" label="Time limit (min)"><input id="al" type="number" min={1} max={600} value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="None" className={inputCls} /></Field>
          <Field id="ax" label="Max attempts"><input id="ax" type="number" min={1} max={50} value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)} placeholder="Unlimited" className={inputCls} /></Field>
        </div>
        <fieldset><legend className="mb-1 text-sm font-semibold text-fg-soft">Concepts</legend>
          <div className="flex flex-wrap gap-2">{concepts.map((c) => <label key={c.id} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line px-3 text-sm"><input type="checkbox" checked={chosen.includes(c.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, c.id] : chosen.filter((x) => x !== c.id))} className="h-4 w-4 accent-[var(--color-accent)]" />{c.name}</label>)}</div>
        </fieldset>
        <Field id="ac" label="Number of questions"><input id="ac" type="number" min={1} max={50} value={count} onChange={(e) => setCount(Number(e.target.value))} className={`${inputCls} w-32`} /></Field>
        <TypePicker value={types} onChange={setTypes} name="atypes" />
        <label className="inline-flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={adaptive} onChange={(e) => setAdaptive(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />Adapt to each student (difficulty near their mastery, transfer checks, weak prerequisites)</label>
        <label className="inline-flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />Publish to students now</label>
        {a.error ? <ErrorNote error={a.error} /> : null}
        {ok ? <Notice tone="ok">Assessment created.</Notice> : null}
        <Button type="submit" variant="primary" busy={a.busy} disabled={!title.trim() || !chosen.length} className="justify-self-start">Create assessment</Button>
      </form>
    </Card>
  )
}

interface Results { attempts: { id: string; student: string; status: string; score: number | null; maxScore: number | null; submittedAt: string | null; weaknesses: string[]; recallNotApplied: string[]; gradingRuns?: number; gradingError?: string | null }[]; items: { itemId: string; stem: string; type: string; responses: number; facility: number | null; pendingReview: number }[] }
interface ReviewRow { responseId: string; student: string; stem: string; type: string; answer: unknown; points: number; maxPoints: number; needsReview: boolean; reason: string | null; criteria: { id: string; criterion: string; points: number; awarded: number; feedback: string; educatorAdjusted?: boolean }[] | null; modelAnswer: string; override: { reason: string; count?: number } | null }

function RetryMarking({ id, runs, error, onDone }: { id: string; runs: number; error: string | null; onDone: () => void }) {
  const a = useAction()
  return (
    <span className="block text-xs">
      {runs ? `${runs} run${runs === 1 ? '' : 's'}` : 'queued'}{error ? ` · ${error}` : ''}
      <button type="button" className="ml-2 font-semibold text-accent underline disabled:opacity-50" disabled={a.busy} onClick={() => void a.run(async () => { await api.post(`${TUTOR}/assessment-attempts/${id}/retry-marking`); onDone() })}>Retry marking now</button>
      {a.error ? <span className="block text-danger">Could not queue a retry.</span> : null}
    </span>
  )
}

function AssessmentResults({ id }: { id: string }) {
  const r = useLoad(`ar:${id}`, (sig) => api.get<Results>(`${TUTOR}/assessments/${id}/results`, sig))
  const [all, setAll] = useState(false)
  const q = useLoad(`aq:${id}:${all}`, (sig) => api.get<ReviewRow[]>(`${TUTOR}/assessments/${id}/review${all ? '?all=true' : ''}`, sig))
  if (r.loading || q.loading) return <div className="mt-3"><Skeleton /></div>
  if (r.error) return <div className="mt-3"><ErrorNote error={r.error} /></div>
  const d = r.data!
  return (
    <div className="mt-4 grid gap-4">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[36rem] text-left text-sm"><caption className="sr-only">Attempts</caption>
          <thead className="text-xs uppercase text-muted"><tr><th scope="col" className="py-1 pr-3">Student</th><th scope="col" className="pr-3">Status</th><th scope="col" className="pr-3">Score</th><th scope="col">Weak areas</th></tr></thead>
          <tbody>{d.attempts.map((x) => <tr key={x.id} className="border-t border-line"><th scope="row" className="py-1 pr-3 font-normal">{x.student}</th><td className="pr-3">{x.status.replace('_', ' ')}{x.status === 'grading' ? <RetryMarking id={x.id} runs={x.gradingRuns ?? 0} error={x.gradingError ?? null} onDone={() => r.reload()} /> : null}</td><td className="pr-3">{x.score ?? '—'}/{x.maxScore ?? '—'}</td><td>{[...x.weaknesses, ...x.recallNotApplied.map((c) => `${c} (recall ok, application weak)`)].join(', ') || '—'}</td></tr>)}</tbody>
        </table>
        {!d.attempts.length ? <p className="text-sm text-muted">No attempts yet.</p> : null}
      </div>
      {d.items.length ? (
        <div><h3 className="text-sm font-semibold">Question difficulty (facility = average score)</h3>
          <ul className="mt-1 space-y-1 text-sm">{d.items.map((i) => <li key={i.itemId}><span className="font-mono">{i.facility === null ? '—' : `${Math.round(i.facility * 100)}%`}</span> · {i.stem.slice(0, 110)}{i.stem.length > 110 ? '…' : ''} <span className="text-xs text-muted">({i.responses} answers{i.pendingReview ? `, ${i.pendingReview} to review` : ''})</span></li>)}</ul></div>
      ) : null}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">{all ? 'All AI-marked answers' : 'Marks to review'} ({q.data?.length ?? 0})</h3>
          <label className="inline-flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />Show all AI-marked answers (to check or override)</label></div>
        {q.error ? <ErrorNote error={q.error} /> : !q.data?.length ? <p className="text-sm text-muted">Nothing waiting for review.</p> : (
          <ul className="mt-2 space-y-3">{q.data.map((row) => <ReviewItem key={row.responseId} row={row} onDone={() => { q.reload(); r.reload() }} />)}</ul>
        )}
      </div>
    </div>
  )
}

function ReviewItem({ row, onDone }: { row: ReviewRow; onDone: () => void }) {
  const [points, setPoints] = useState(String(row.points))
  const [marks, setMarks] = useState<Record<string, string>>(Object.fromEntries((row.criteria ?? []).map((c) => [c.id, String(c.awarded)])))
  const rubric = !!row.criteria?.length
  const total = rubric ? row.criteria!.reduce((a, c) => a + (Number(marks[c.id]) || 0), 0) : Number(points)
  const [reason, setReason] = useState('')
  const a = useAction()
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const body = rubric ? { criteria: row.criteria!.map((c) => ({ id: c.id, awarded: Number(marks[c.id]) })), reason: reason.trim() } : { points: Number(points), reason: reason.trim() }
    const r = await a.run(() => api.post(`${TUTOR}/assessment-responses/${row.responseId}/override`, body))
    if (r) onDone()
  }
  const id = `rv-${row.responseId}`
  return (
    <li className="rounded-lg border border-line p-3">
      <p className="text-xs text-muted">{row.student} · {row.needsReview ? 'provisional' : row.override ? 'educator mark' : 'AI mark'} {row.points}/{row.maxPoints}{row.reason ? ` · ${row.reason}` : ''}{row.override ? ` · overridden: ${row.override.reason}` : ''}</p>
      <div className="mt-1 text-sm"><Markdown text={row.stem} /></div>
      <p className="mt-2 whitespace-pre-wrap rounded bg-surface-2 p-2 text-sm">{typeof row.answer === 'string' ? row.answer : JSON.stringify(row.answer)}</p>
      {row.criteria?.length && Math.abs(row.criteria.reduce((s, c) => s + c.awarded, 0) - row.points) > 0.01
        ? <p className="mt-2 text-xs text-muted">The total was set directly (before per-criterion marking); the criterion marks below are the AI's. Marking each criterion replaces the total with their sum.</p>
        : null}
      {row.criteria?.length ? <ul className="mt-2 space-y-1 text-xs">{row.criteria.map((c) => <li key={c.id}><span className="font-semibold">{c.awarded}/{c.points}</span> {c.criterion}{c.feedback ? ` — ${c.feedback}` : ''}</li>)}</ul> : null}
      <details className="mt-1 text-xs"><summary className="cursor-pointer">Model answer</summary><p className="mt-1">{row.modelAnswer}</p></details>
      <form onSubmit={submit} className="mt-2 flex flex-wrap items-end gap-2">
        {rubric ? (
          <fieldset className="grid w-full gap-1"><legend className="text-xs font-semibold text-fg-soft">Mark each criterion (total {total}/{row.maxPoints})</legend>
            {row.criteria!.map((c) => (
              <label key={c.id} className="flex flex-wrap items-center gap-2 text-xs"><input type="number" step={0.5} min={0} max={c.points} value={marks[c.id] ?? ''} onChange={(e) => setMarks({ ...marks, [c.id]: e.target.value })} className={`${inputCls} w-20`} aria-label={`Marks for: ${c.criterion}`} /> / {c.points} · {c.criterion}{c.educatorAdjusted ? ' (adjusted)' : ''}</label>
            ))}
          </fieldset>
        ) : <Field id={`${id}-p`} label={`Mark (0-${row.maxPoints})`}><input id={`${id}-p`} type="number" step={0.5} min={0} max={row.maxPoints} value={points} onChange={(e) => setPoints(e.target.value)} className={`${inputCls} w-28`} /></Field>}
        <Field id={`${id}-r`} label="Reason (recorded in the audit log)"><input id={`${id}-r`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} className={`${inputCls} w-72`} /></Field>
        <Button type="submit" variant="primary" busy={a.busy} disabled={reason.trim().length < 5}>Confirm mark</Button>
      </form>
      {a.error ? <div className="mt-2"><ErrorNote error={a.error} /></div> : null}
    </li>
  )
}
