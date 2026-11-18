import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { TUTOR, api } from '../lib/api.ts'
import type { ConceptGraph } from '../lib/tutor.ts'
import { useSession } from '../session.tsx'
import { Button, Card, EmptyState, ErrorNote, Field, Notice, PageHeader, Skeleton, inputCls, useAction, useLoad } from '../ui/kit.tsx'
import { Markdown } from '../ui/Markdown.tsx'

type Spec =
  | { type: 'mcq'; options: string[]; correct: string[] }
  | { type: 'numeric'; value: number; tolerance: number; relative?: boolean; unit?: string }
  | { type: 'expression'; value: string; assume?: string }
  | { type: 'short'; modelAnswer: string; acceptable: string[]; rubric: { id: string; criterion: string; points: number; keyPoints: string[] }[] }
  | { type: 'descriptive'; modelAnswer: string; rubric: { id: string; criterion: string; points: number; keyPoints: string[] }[] }
export interface ManagedItem {
  id: string; conceptId: string; conceptName: string; type: Spec['type']; stem: string; answerSpec: Spec; explanation: string
  difficulty: number; retired: boolean; createdAt: string; updatedAt: string | null; stats: { attempts: number; correctRate: number | null }
  status?: 'draft' | 'approved'; origin?: string; learningObjective?: string; cognitive?: string
  sourceRefs?: { filename: string; pageStart: number }[]; validation?: { checks?: string[]; model?: string } | null
}

/** Human-readable answer key for the educator view. */
export function answerKey(s: Spec): string {
  if (s.type === 'mcq') return s.correct.join(', ')
  if (s.type === 'numeric') return `${s.value}${s.unit ? ` ${s.unit}` : ''}${s.tolerance ? ` ± ${s.tolerance}${s.relative ? ' (relative)' : ''}` : ''}`
  if (s.type === 'expression') return `${s.value} (any equivalent form)`
  return `${s.modelAnswer} — marked by rubric (${s.rubric.reduce((a, c) => a + c.points, 0)} marks)`
}
const TYPE_LABEL = { mcq: 'Multiple choice', numeric: 'Numerical', expression: 'Expression', short: 'Short answer', descriptive: 'Written (rubric)' } as const

export default function EducatorQuestions() {
  const { courseId = '' } = useParams()
  const s = useSession()
  const course = s.courses.find((c) => c.id === courseId)
  const [conceptId, setConceptId] = useState('')
  const [retired, setRetired] = useState(false)
  const [status, setStatus] = useState('')
  const graph = useLoad(`eg:${courseId}`, (sig) => api.get<ConceptGraph>(`${TUTOR}/courses/${courseId}/concepts`, sig))
  const qs = new URLSearchParams({ ...(conceptId ? { conceptId } : {}), ...(retired ? { includeRetired: 'true' } : {}), ...(status ? { status } : {}) }).toString()
  const items = useLoad(`items:${courseId}:${qs}`, (sig) => api.get<ManagedItem[]>(`${TUTOR}/courses/${courseId}/items${qs ? `?${qs}` : ''}`, sig))
  if (!course) return <EmptyState title="Course not found"><Link to="/educator" className="text-accent underline">Back to your courses</Link></EmptyState>

  return (
    <>
      <PageHeader title="Practice questions" eyebrow={<Link to={`/educator/courses/${courseId}`} className="hover:underline">{course.code} · {course.title}</Link>} />
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <Field id="qc" label="Concept">
          <select id="qc" value={conceptId} onChange={(e) => setConceptId(e.target.value)} className={`${inputCls} w-64`}>
            <option value="">All concepts</option>
            {graph.data?.concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field id="qst" label="Status"><select id="qst" value={status} onChange={(e) => setStatus(e.target.value)} className={`${inputCls} w-40`}><option value="">All</option><option value="draft">Drafts to review</option><option value="approved">Approved</option></select></Field>
        <label className="inline-flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={retired} onChange={(e) => setRetired(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />Show retired</label>
        <Link to={`/educator/courses/${courseId}`} className="ml-auto inline-flex min-h-11 items-center font-semibold text-accent hover:underline">Add a question</Link>
      </div>
      {items.loading && !items.data ? <Skeleton lines={5} /> : items.error ? <ErrorNote error={items.error} retry={items.reload} /> : !items.data!.length ? (
        <EmptyState title="No questions yet">Add questions from the course page; they appear here with answer keys and results.</EmptyState>
      ) : (
        <ul className="grid gap-3">{items.data!.map((it) => <ItemCard key={it.id} it={it} onChanged={items.reload} />)}</ul>
      )}
    </>
  )
}

function ItemCard({ it, onChanged }: { it: ManagedItem; onChanged: () => void }) {
  const [editing, setEditing] = useState(false)
  const a = useAction()
  const toggle = () => void a.run(async () => { await api.post(`${TUTOR}/items/${it.id}/${it.retired ? 'restore' : 'retire'}`); onChanged() })
  const approve = () => void a.run(async () => { await api.post(`${TUTOR}/items/${it.id}/approve`); onChanged() })
  return (
    <li>
      <Card className={it.retired ? 'opacity-70' : ''} aria-label={`Question: ${it.stem.slice(0, 60)}`}>
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded bg-surface-2 px-2 py-0.5 font-semibold">{it.conceptName}</span>
          <span className="text-muted">{TYPE_LABEL[it.type]} · difficulty {it.difficulty.toFixed(1)}</span>
          {it.retired ? <span className="rounded bg-warn-bg px-2 py-0.5 font-semibold text-warn">Retired — hidden from students</span> : null}
          {it.status === 'draft' ? <span className="rounded bg-src-uncertain-bg px-2 py-0.5 font-semibold text-src-uncertain">Draft — not visible to students</span> : null}
          {it.origin === 'ai_generated' ? <span className="rounded bg-surface-2 px-2 py-0.5">AI-generated{it.cognitive ? ` · ${it.cognitive}` : ''}</span> : null}
          <span className="ml-auto text-muted">{it.stats.attempts} attempt{it.stats.attempts === 1 ? '' : 's'}{it.stats.correctRate !== null ? ` · ${Math.round(it.stats.correctRate * 100)}% correct` : ''}</span>
        </div>
        {editing ? <EditItem it={it} onDone={() => { setEditing(false); onChanged() }} onCancel={() => setEditing(false)} /> : (
          <>
            <Markdown text={it.stem} />
            {it.answerSpec.type === 'mcq' ? <ul className="mt-2 list-disc pl-5 text-sm">{it.answerSpec.options.map((o) => <li key={o} className={(it.answerSpec as { correct: string[] }).correct.includes(o) ? 'font-semibold text-ok' : ''}>{o}</li>)}</ul> : null}
            <p className="mt-2 text-sm"><span className="font-semibold">Answer:</span> <span className="font-mono">{answerKey(it.answerSpec)}</span></p>
            {it.explanation ? <div className="mt-1 text-sm text-fg-soft"><span className="font-semibold">Explanation:</span> <Markdown text={it.explanation} /></div> : null}
            {it.answerSpec.type === 'short' || it.answerSpec.type === 'descriptive' ? <ul className="mt-2 space-y-1 text-sm">{it.answerSpec.rubric.map((c) => <li key={c.id} className="rounded bg-surface-2 p-2"><span className="font-semibold">{c.points}</span> · {c.criterion}<span className="block text-xs text-muted">Looks for: {c.keyPoints.join('; ')}</span></li>)}</ul> : null}
            {it.learningObjective ? <p className="mt-2 text-xs text-muted">Objective: {it.learningObjective}</p> : null}
            {it.sourceRefs?.length ? <p className="mt-1 text-xs text-muted">Source: {it.sourceRefs.map((r) => `${r.filename} p.${r.pageStart}`).join(', ')}</p> : null}
            {it.validation?.checks?.length ? <p className="mt-1 text-xs text-ok">Checks passed: {it.validation.checks.join(' · ')}</p> : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {it.status === 'draft' ? <Button variant="primary" icon="check" busy={a.busy} onClick={approve}>Approve</Button> : null}
              <Button icon="pen" onClick={() => setEditing(true)}>Edit</Button>
              <Button variant="ghost" busy={a.busy} onClick={toggle}>{it.retired ? 'Restore' : 'Retire'}</Button>
            </div>
            {a.error ? <div className="mt-2"><ErrorNote error={a.error} /></div> : null}
          </>
        )}
      </Card>
    </li>
  )
}

function EditItem({ it, onDone, onCancel }: { it: ManagedItem; onDone: () => void; onCancel: () => void }) {
  const [stem, setStem] = useState(it.stem)
  const [explanation, setExplanation] = useState(it.explanation)
  const [difficulty, setDifficulty] = useState(it.difficulty)
  const locked = it.stats.attempts > 0
  const s = it.answerSpec
  const [value, setValue] = useState(s.type === 'mcq' ? '' : s.type === 'short' || s.type === 'descriptive' ? s.modelAnswer : String(s.value))
  const [tolerance, setTolerance] = useState(s.type === 'numeric' ? String(s.tolerance) : '0')
  const [options, setOptions] = useState(s.type === 'mcq' ? s.options.join('\n') : '')
  const [correct, setCorrect] = useState<string[]>(s.type === 'mcq' ? s.correct : [])
  const a = useAction()
  const opts = options.split('\n').map((o) => o.trim()).filter(Boolean)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const answerSpec = locked ? undefined : s.type === 'mcq' ? { type: 'mcq', options: opts, correct: correct.filter((c) => opts.includes(c)) }
      : s.type === 'numeric' ? { ...s, value: Number(value), tolerance: Number(tolerance) } : s.type === 'short' || s.type === 'descriptive' ? { ...s, modelAnswer: value.trim() } : { ...s, value: value.trim() }
    const r = await a.run(() => api.put(`${TUTOR}/items/${it.id}`, { stem: stem.trim(), explanation, difficulty, ...(answerSpec ? { answerSpec } : {}) }))
    if (r !== undefined) onDone()
  }
  const p = `e-${it.id}`
  return (
    <form onSubmit={submit} className="grid gap-3">
      <Field id={`${p}-s`} label="Question"><textarea id={`${p}-s`} rows={3} value={stem} onChange={(e) => setStem(e.target.value)} className={inputCls} /></Field>
      {locked ? <Notice tone="info" icon="lifebuoy">Students have answered this question, so its answer key is locked to keep their past results meaningful. To change the answer, retire it and add a corrected question.</Notice> : s.type === 'mcq' ? (
        <>
          <Field id={`${p}-o`} label="Options (one per line)"><textarea id={`${p}-o`} rows={4} value={options} onChange={(e) => setOptions(e.target.value)} className={inputCls} /></Field>
          <fieldset><legend className="mb-1 text-sm font-semibold text-fg-soft">Correct option(s)</legend>
            {opts.map((o) => <label key={o} className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={correct.includes(o)} onChange={(e) => setCorrect(e.target.checked ? [...correct, o] : correct.filter((x) => x !== o))} className="h-4 w-4 accent-[var(--color-accent)]" />{o}</label>)}
          </fieldset>
        </>
      ) : s.type === 'numeric' ? (
        <div className="grid grid-cols-2 gap-3">
          <Field id={`${p}-v`} label="Correct value"><input id={`${p}-v`} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} className={`${inputCls} font-mono`} /></Field>
          <Field id={`${p}-t`} label="Tolerance (±)"><input id={`${p}-t`} inputMode="decimal" value={tolerance} onChange={(e) => setTolerance(e.target.value)} className={`${inputCls} font-mono`} /></Field>
        </div>
      ) : s.type === 'short' || s.type === 'descriptive' ? (
        <Field id={`${p}-m`} label="Model answer (the rubric is kept as generated)"><textarea id={`${p}-m`} rows={4} value={value} onChange={(e) => setValue(e.target.value)} className={inputCls} /></Field>
      ) : (
        <Field id={`${p}-x`} label="Correct expression"><input id={`${p}-x`} value={value} spellCheck={false} onChange={(e) => setValue(e.target.value)} className={`${inputCls} font-mono`} /></Field>
      )}
      <Field id={`${p}-e`} label="Explanation shown after answering"><textarea id={`${p}-e`} rows={2} value={explanation} onChange={(e) => setExplanation(e.target.value)} className={inputCls} /></Field>
      <Field id={`${p}-d`} label={`Difficulty: ${difficulty.toFixed(1)}`}><input id={`${p}-d`} type="range" min={0} max={1} step={0.1} value={difficulty} onChange={(e) => setDifficulty(Number(e.target.value))} className="w-full accent-[var(--color-accent)]" /></Field>
      {a.error ? <ErrorNote error={a.error} /> : null}
      <div className="flex gap-2"><Button type="submit" variant="primary" busy={a.busy} disabled={!stem.trim()}>Save</Button><Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  )
}
