import { useState } from 'react'
import { Link } from 'react-router'
import { TUTOR, api, request } from '../lib/api.ts'
import { useCourse } from './CourseLayout.tsx'
import { Button, Card, EmptyState, ErrorNote, Field, Loading, Notice, PageHeader, inputCls, useAction, useLoad } from '../ui/kit.tsx'

interface Topic { conceptId: string; name: string; papersWith: number; papersTotal: number; avgMarks: number | null; trend: string; verified: string; priority: number; confidence: 'high' | 'medium' | 'low'; reasons: string[]; types: Record<string, number>; features: string[] }
interface Insights {
  papers: { id: string; title: string; kind: string; year: number | null; school: string | null; status: string; questions: number; mine: boolean }[]
  topics: Topic[]; note: string; unmatchedQuestions: number
  examples: Record<string, { text: string; source: string; marks: number | null }[]>
  schoolVsBoard: { conceptId: string; name: string; schoolShare: number; boardShare: number; note: string }[]
}
const KINDS = [['board_past_paper', 'Board past paper'], ['board_sample_paper', 'Board sample paper'], ['school_paper', 'School paper'], ['textbook_exercise', 'Textbook exercises'], ['other', 'Other']] as const
const PURPOSES = [['diagnostic', 'Starting-point check'], ['pattern_practice', 'Practice paper (patterns)'], ['mock', 'Full mock test'], ['post', 'After-learning check']] as const

/** Exam intelligence: verified past-paper counts kept apart from estimated priorities. */
export default function ExamInsights() {
  const course = useCourse()
  const [scope, setScope] = useState<'all' | 'board' | 'school'>('all')
  const v = useLoad<Insights>(`exam:${course.id}:${scope}`, (sig) => api.get(`${TUTOR}/courses/${course.id}/exam/insights?scope=${scope}`, sig))
  const [file, setFile] = useState<File | null>(null)
  const [kind, setKind] = useState<string>('board_past_paper')
  const [title, setTitle] = useState('')
  const [year, setYear] = useState('')
  const [school, setSchool] = useState('')
  const [made, setMade] = useState<{ title: string; questions: number } | null>(null)
  const up = useAction()
  const mk = useAction()

  const add = async () => {
    const r = await up.run(async () => {
      if (!file) throw new Error('Choose the paper first')
      const doc = await request<{ documentId: string }>('POST', `${TUTOR}/courses/${course.id}/materials?filename=${encodeURIComponent(file.name)}`, undefined, { raw: file, contentType: file.type || 'application/octet-stream' })
      for (let i = 0; i < 90; i++) {
        const docs = await api.get<{ documentId: string; status: string; error?: string | null }[]>(`${TUTOR}/courses/${course.id}/materials`)
        const d = docs.find((x) => x.documentId === doc.documentId)
        if (d?.status === 'ready') break
        if (d?.status === 'failed') throw new Error(d.error ?? 'The paper could not be read')
        await new Promise((res) => setTimeout(res, 2000))
      }
      return api.post(`${TUTOR}/courses/${course.id}/exam/papers`, { documentId: doc.documentId, sourceKind: kind, title: title.trim() || file.name, year: year || null, school: school || null })
    })
    if (r) { setFile(null); setTitle(''); setYear(''); window.setTimeout(v.reload, 4000) }
  }
  const create = async (purpose: string) => {
    const r = await mk.run(() => api.post<{ title: string; questions: number }>(`${TUTOR}/courses/${course.id}/self-tests`, { purpose }))
    if (r) setMade(r)
  }

  return (
    <>
      <PageHeader title="Exam insights" eyebrow={course.code}>
        <label className="sr-only" htmlFor="ex-scope">Papers to use</label>
        <select id="ex-scope" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} className={`${inputCls} w-auto`}>
          <option value="all">All papers</option><option value="board">Board papers</option><option value="school">School papers</option>
        </select>
      </PageHeader>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="grid min-w-0 gap-5">
          {v.loading && !v.data ? <Loading /> : v.error ? <ErrorNote error={v.error} retry={v.reload} /> : v.data ? (
            <>
              <Notice tone={v.data.papers.some((p) => p.status === 'ready') ? 'info' : 'warn'} title="How to read this">{v.data.note}</Notice>
              <Card className="overflow-x-auto p-0">
                <table className="w-full text-sm">
                  <caption className="sr-only">Topic priorities</caption>
                  <thead><tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted"><th className="p-3">Topic</th><th className="p-3">Verified in papers</th><th className="p-3">Priority (estimate)</th><th className="p-3">Confidence</th></tr></thead>
                  <tbody>
                    {v.data.topics.map((t) => (
                      <tr key={t.conceptId} className="border-b border-line align-top">
                        <td className="p-3 font-semibold">{t.name}{t.features.length ? <span className="block text-xs font-normal text-muted">{t.features.join(', ')}</span> : null}</td>
                        <td className="p-3">{t.papersTotal ? `${t.papersWith} of ${t.papersTotal}` : '—'}{t.avgMarks !== null ? <span className="block text-xs text-muted">~{t.avgMarks} marks each</span> : null}{t.trend === 'rising' || t.trend === 'new' ? <span className="block text-xs text-warn">more frequent recently</span> : null}</td>
                        <td className="p-3"><div className="h-2 w-24 rounded-full bg-line" aria-hidden><div className="h-2 rounded-full bg-accent" style={{ width: `${Math.round(t.priority * 100)}%` }} /></div><span className="text-xs text-muted">{t.reasons.join('; ')}</span></td>
                        <td className="p-3 capitalize">{t.confidence}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
              {Object.entries(v.data.examples).some(([, xs]) => xs.length) ? (
                <Card>
                  <h2 className="mb-2 font-semibold">Past questions (with sources)</h2>
                  <ul className="grid gap-3 text-sm">
                    {v.data.topics.filter((t) => v.data!.examples[t.conceptId]?.length).map((t) => (
                      <li key={t.conceptId}><p className="font-semibold">{t.name}</p><ul className="mt-1 grid gap-1">{v.data!.examples[t.conceptId]!.map((q, i) => <li key={i}>{q.text} <span className="text-xs text-muted">— {q.source}{q.marks !== null ? `, ${q.marks} marks` : ''}</span></li>)}</ul></li>
                    ))}
                  </ul>
                </Card>
              ) : null}
              {v.data.schoolVsBoard.length ? (
                <Card><h2 className="mb-2 font-semibold">Your school vs the board</h2><ul className="grid gap-1 text-sm">{v.data.schoolVsBoard.map((x) => <li key={x.conceptId}><b>{x.name}</b>: {x.note} ({Math.round(x.schoolShare * 100)}% vs {Math.round(x.boardShare * 100)}% of questions)</li>)}</ul></Card>
              ) : null}
            </>
          ) : null}
        </div>

        <div className="grid content-start gap-5">
          <Card className="grid gap-3">
            <h2 className="font-semibold">Practise from these patterns</h2>
            <p className="text-sm text-muted">Tests are built from your educator's approved questions, weighted by the priorities on the left. Your own tests are private to you.</p>
            <div className="grid gap-2">{PURPOSES.map(([p, l]) => <Button key={p} busy={mk.busy} onClick={() => void create(p)}>{l}</Button>)}</div>
            {mk.error ? <ErrorNote error={mk.error} /> : null}
            {made ? <Notice tone="ok" title={`${made.title} is ready`}>{made.questions} questions. <Link to={`/app/education/tutor/courses/${course.id}/assessments`} className="font-semibold underline">Open Assessments to start</Link></Notice> : null}
          </Card>
          <Card className="grid gap-3">
            <h2 className="font-semibold">Add a question paper</h2>
            <p className="text-sm text-muted">Upload papers you have a copy of (PDF or notes). We count what they ask; we never search behind logins or copy restricted material.</p>
            <input aria-label="Question paper file" type="file" accept=".pdf,.docx,.txt,.md" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm" />
            <Field id="ex-kind" label="What is it?"><select id="ex-kind" value={kind} onChange={(e) => setKind(e.target.value)} className={inputCls}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field id="ex-title" label="Title"><input id="ex-title" value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} placeholder="e.g. CBSE 2024 Science" /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field id="ex-year" label="Year"><input id="ex-year" inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))} className={inputCls} /></Field>
              {kind === 'school_paper' ? <Field id="ex-school" label="School"><input id="ex-school" value={school} onChange={(e) => setSchool(e.target.value)} className={inputCls} /></Field> : null}
            </div>
            {up.error ? <ErrorNote error={up.error} /> : null}
            <Button variant="primary" busy={up.busy} disabled={!file} onClick={() => void add()}>Add and analyse</Button>
          </Card>
          {v.data?.papers.length ? (
            <Card><h2 className="mb-2 font-semibold">Papers used</h2><ul className="grid gap-1 text-sm">{v.data.papers.map((p) => <li key={p.id}>{p.title}{p.year ? ` (${p.year})` : ''} · {p.kind.replace(/_/g, ' ')} · {p.status === 'ready' ? `${p.questions} questions` : p.status}{p.mine ? ' · private to you' : ' · shared by your educator'}</li>)}</ul></Card>
          ) : !v.loading ? <EmptyState title="No papers yet">Add a past, sample or school paper to see verified patterns.</EmptyState> : null}
        </div>
      </div>
    </>
  )
}
