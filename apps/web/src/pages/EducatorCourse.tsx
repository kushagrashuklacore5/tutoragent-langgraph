import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { TUTOR, api } from '../lib/api.ts'
import type { ConceptGraph } from '../lib/tutor.ts'
import { useSession } from '../session.tsx'
import { Icon } from '../ui/icons.tsx'
import { Button, Card, EmptyState, ErrorNote, Field, Notice, PageHeader, Skeleton, inputCls, useAction, useLoad } from '../ui/kit.tsx'

interface Member { user_id: string; email: string; roles: string[]; status: string }

export default function EducatorCourse() {
  const { courseId = '' } = useParams()
  const s = useSession()
  const course = s.courses.find((c) => c.id === courseId)
  const graph = useLoad(`eg:${courseId}`, (sig) => api.get<ConceptGraph>(`${TUTOR}/courses/${courseId}/concepts`, sig))
  const approve = useAction()
  if (!course) return <EmptyState title="Course not found"><Link to="/educator" className="text-accent underline">Back to your courses</Link></EmptyState>
  const concepts = graph.data?.concepts ?? []

  return (
    <>
      <PageHeader title={course.title} eyebrow={`${course.code} · Manage`}>
        <Link to={`/app/education/tutor/courses/${course.id}/materials`} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line-strong bg-surface px-4 font-semibold"><Icon name="file" size={18} />Course materials</Link>
        <Link to={`/educator/courses/${course.id}/progress`} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line-strong bg-surface px-4 font-semibold"><Icon name="chart" size={18} />Learner progress</Link>
        <Link to={`/educator/courses/${course.id}/questions`} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line-strong bg-surface px-4 font-semibold"><Icon name="question" size={18} />Questions</Link>
        <Link to={`/educator/courses/${course.id}/assessments`} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line-strong bg-surface px-4 font-semibold"><Icon name="target" size={18} />Assessments</Link>
      </PageHeader>
      <div className="grid gap-6 xl:grid-cols-2">
        <Card aria-labelledby="cg-h">
          <h2 id="cg-h" className="mb-3 text-lg font-semibold">Concepts</h2>
          {graph.loading ? <Skeleton /> : graph.error ? <ErrorNote error={graph.error} retry={graph.reload} /> : !concepts.length ? <p className="text-muted">No concepts yet. Add the first one below.</p> : (
            <ul className="divide-y divide-line">
              {concepts.map((c) => {
                const pre = graph.data!.prerequisites.filter((p) => p.concept === c.id).map((p) => concepts.find((x) => x.id === p.prerequisite)?.name)
                return (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <p className="font-semibold">{c.name}</p>
                      <p className="text-xs text-muted">{c.est_minutes} min · weight {Number(c.exam_weight)}{pre.length ? ` · after ${pre.join(', ')}` : ''}</p>
                    </div>
                    {c.status === 'approved' ? <span className="inline-flex items-center gap-1 rounded-full bg-ok-bg px-2 py-0.5 text-xs font-semibold text-ok"><Icon name="check" size={12} />Published</span> : (
                      <Button variant="secondary" busy={approve.busy} onClick={() => void approve.run(async () => { await api.post(`${TUTOR}/courses/${course.id}/concepts/${c.id}/approve`); graph.reload() })}>Approve</Button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {approve.error ? <ErrorNote error={approve.error} /> : null}
          <AddConcept courseId={course.id} graph={graph.data} onAdded={graph.reload} />
        </Card>
        <div className="grid h-fit gap-6">
          <AddItem courseId={course.id} graph={graph.data} />
          <Enrol courseId={course.id} />
        </div>
      </div>
    </>
  )
}

function AddConcept({ courseId, graph, onAdded }: { courseId: string; graph?: ConceptGraph; onAdded: () => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [est, setEst] = useState(60)
  const [weight, setWeight] = useState(1)
  const [pre, setPre] = useState<string[]>([])
  const a = useAction()
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const r = await a.run(() => api.post(`${TUTOR}/courses/${courseId}/concepts`, { name: name.trim(), description, estMinutes: est, examWeight: weight, prerequisites: pre }))
    if (r) { setName(''); setDescription(''); setPre([]); onAdded() }
  }
  return (
    <form onSubmit={submit} className="mt-4 grid gap-3 border-t border-line pt-4">
      <h3 className="font-semibold">Add a concept</h3>
      <Field id="cn" label="Name"><input id="cn" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} maxLength={200} /></Field>
      <Field id="cd" label="Description (optional)"><textarea id="cd" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field id="ce" label="Study minutes"><input id="ce" type="number" min={5} max={600} value={est} onChange={(e) => setEst(Number(e.target.value))} className={inputCls} /></Field>
        <Field id="cw" label="Exam weight"><input id="cw" type="number" min={0.1} max={10} step={0.1} value={weight} onChange={(e) => setWeight(Number(e.target.value))} className={inputCls} /></Field>
      </div>
      {graph?.concepts.length ? (
        <fieldset>
          <legend className="mb-1 text-sm font-semibold text-fg-soft">Prerequisites</legend>
          <div className="flex flex-wrap gap-2">
            {graph.concepts.map((c) => (
              <label key={c.id} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line px-3 text-sm">
                <input type="checkbox" checked={pre.includes(c.id)} onChange={(e) => setPre(e.target.checked ? [...pre, c.id] : pre.filter((x) => x !== c.id))} className="h-4 w-4 accent-[var(--color-accent)]" />{c.name}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      {a.error ? <ErrorNote error={a.error} /> : null}
      <Button type="submit" busy={a.busy} disabled={!name.trim()} className="justify-self-start" icon="plus">Add concept (draft)</Button>
      <p className="text-xs text-muted">New concepts stay drafts until you approve them; students only see approved concepts.</p>
    </form>
  )
}

function AddItem({ courseId, graph }: { courseId: string; graph?: ConceptGraph }) {
  const [conceptId, setConceptId] = useState('')
  const [type, setType] = useState<'mcq' | 'numeric' | 'expression'>('mcq')
  const [stem, setStem] = useState('')
  const [options, setOptions] = useState('')
  const [correct, setCorrect] = useState<string[]>([])
  const [value, setValue] = useState('')
  const [tolerance, setTolerance] = useState('0')
  const [explanation, setExplanation] = useState('')
  const [difficulty, setDifficulty] = useState(0.5)
  const [ok, setOk] = useState(false)
  const a = useAction()
  const opts = options.split('\n').map((o) => o.trim()).filter(Boolean)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const answerSpec = type === 'mcq' ? { type, options: opts, correct: correct.filter((c) => opts.includes(c)) } : type === 'expression' ? { type, value: value.trim() } : { type, value: Number(value), tolerance: Number(tolerance) }
    const r = await a.run(() => api.post(`${TUTOR}/courses/${courseId}/items`, { conceptId, stem: stem.trim(), answerSpec, explanation, difficulty }))
    if (r) { setStem(''); setOptions(''); setCorrect([]); setValue(''); setExplanation(''); setOk(true) }
  }
  return (
    <Card>
      <form onSubmit={submit} className="grid gap-3">
        <h2 className="text-lg font-semibold">Add a practice question</h2>
        <Field id="ic" label="Concept">
          <select id="ic" value={conceptId} onChange={(e) => setConceptId(e.target.value)} className={inputCls}>
            <option value="">Choose…</option>
            {graph?.concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <fieldset className="flex flex-wrap gap-2">
          <legend className="mb-1 text-sm font-semibold text-fg-soft">Type</legend>
          {(['mcq', 'numeric', 'expression'] as const).map((t) => (
            <label key={t} className={`inline-flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm ${type === t ? 'border-accent' : 'border-line'}`}>
              <input type="radio" name="itype" checked={type === t} onChange={() => setType(t)} className="h-4 w-4 accent-[var(--color-accent)]" />{t === 'mcq' ? 'Multiple choice' : t === 'numeric' ? 'Numerical' : 'Expression'}
            </label>
          ))}
        </fieldset>
        <Field id="is" label="Question" hint="Markdown; inline maths with $…$."><textarea id="is" rows={3} value={stem} onChange={(e) => { setStem(e.target.value); setOk(false) }} className={inputCls} aria-describedby="is-hint" /></Field>
        {type === 'mcq' ? (
          <>
            <Field id="io" label="Options (one per line)"><textarea id="io" rows={4} value={options} onChange={(e) => setOptions(e.target.value)} className={inputCls} /></Field>
            {opts.length ? (
              <fieldset>
                <legend className="mb-1 text-sm font-semibold text-fg-soft">Correct option(s)</legend>
                <div className="grid gap-1">{opts.map((o) => (
                  <label key={o} className="inline-flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={correct.includes(o)} onChange={(e) => setCorrect(e.target.checked ? [...correct, o] : correct.filter((x) => x !== o))} className="h-4 w-4 accent-[var(--color-accent)]" />{o}</label>
                ))}</div>
              </fieldset>
            ) : null}
          </>
        ) : type === 'expression' ? (
          <Field id="ix" label="Correct expression" hint="Checked for mathematical equivalence, so students may write any equivalent form (2*(x+1) matches 2*x + 2). Use * and ^.">
            <input id="ix" autoComplete="off" spellCheck={false} maxLength={500} value={value} onChange={(e) => setValue(e.target.value)} className={`${inputCls} font-mono`} aria-describedby="ix-hint" placeholder="2*x + 2" />
          </Field>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Field id="iv" label="Correct value"><input id="iv" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} className={`${inputCls} font-mono`} /></Field>
            <Field id="it" label="Tolerance (±)"><input id="it" inputMode="decimal" value={tolerance} onChange={(e) => setTolerance(e.target.value)} className={`${inputCls} font-mono`} /></Field>
          </div>
        )}
        <Field id="ie" label="Explanation shown after answering"><textarea id="ie" rows={2} value={explanation} onChange={(e) => setExplanation(e.target.value)} className={inputCls} /></Field>
        <Field id="id" label={`Difficulty: ${difficulty.toFixed(1)}`}><input id="id" type="range" min={0} max={1} step={0.1} value={difficulty} onChange={(e) => setDifficulty(Number(e.target.value))} className="w-full accent-[var(--color-accent)]" /></Field>
        {a.error ? <ErrorNote error={a.error} /> : null}
        {ok ? <Notice tone="ok">Question added.</Notice> : null}
        <Button type="submit" busy={a.busy} disabled={!conceptId || !stem.trim() || (type === 'mcq' ? opts.length < 2 || !correct.length : value.trim() === '')} className="justify-self-start" icon="plus">Add question</Button>
      </form>
    </Card>
  )
}

function Enrol({ courseId }: { courseId: string }) {
  const members = useLoad(`members`, (sig) => api.get<Member[]>('/api/members', sig))
  const [userId, setUserId] = useState('')
  const [role, setRole] = useState<'student' | 'educator'>('student')
  const [done, setDone] = useState<string | null>(null)
  const a = useAction()
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const r = await a.run(async () => { await api.post(`${TUTOR}/courses/${courseId}/enrolments`, { userId, role }); return true })
    if (r) setDone(members.data?.find((m) => m.user_id === userId)?.email ?? 'Member')
  }
  return (
    <Card>
      <form onSubmit={submit} className="grid gap-3">
        <h2 className="text-lg font-semibold">Enrol members</h2>
        {members.loading ? <Skeleton lines={1} /> : members.error ? <ErrorNote error={members.error} retry={members.reload} /> : (
          <>
            <Field id="em" label="Member">
              <select id="em" value={userId} onChange={(e) => { setUserId(e.target.value); setDone(null) }} className={inputCls}>
                <option value="">Choose…</option>
                {members.data!.filter((m) => m.status === 'active').map((m) => <option key={m.user_id} value={m.user_id}>{m.email} ({m.roles.join(', ')})</option>)}
              </select>
            </Field>
            <Field id="er" label="Role in this course">
              <select id="er" value={role} onChange={(e) => setRole(e.target.value as 'student' | 'educator')} className={inputCls}><option value="student">Student</option><option value="educator">Educator</option></select>
            </Field>
          </>
        )}
        {a.error ? <ErrorNote error={a.error} /> : null}
        {done ? <Notice tone="ok">{done} is enrolled.</Notice> : null}
        <Button type="submit" busy={a.busy} disabled={!userId} className="justify-self-start">Enrol</Button>
        <p className="text-xs text-muted">Only active members of your institution can be enrolled. Ask your institution admin to add new members.</p>
      </form>
    </Card>
  )
}
