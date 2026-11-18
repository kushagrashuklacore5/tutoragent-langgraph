import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { TUTOR, api } from '../lib/api.ts'
import { useSession } from '../session.tsx'
import { Icon } from '../ui/icons.tsx'
import { Card, EmptyState, ErrorNote, Notice, PageHeader, Skeleton, inputCls, useLoad } from '../ui/kit.tsx'

type State = 'insufficient_evidence' | 'learning' | 'mastered' | 'stale'
interface StudentProgress {
  userId: string; name: string; email: string
  mastered: number; learning: number; stale: number; insufficient: number; avgMastery: number | null
  concepts: Record<string, { state: State; pMastery: number }>
  practice: { attempts: number; correctRate: number | null; last7Days: number; confidentWrong: number }
  revision: { cards: number; due: number; overdue: number }
  lastActiveAt: string | null; flags: string[]
}
interface ConceptInsight {
  conceptId: string; name: string
  students: { mastered: number; learning: number; stale: number; insufficient: number }
  avgMastery: number | null; practice: { attempts: number; correctRate: number | null; confidentWrong: number }
  errorTypes?: Record<string, number>; misconceptions?: { text: string; students: number; occurrences: number }[]
}
export interface ProgressReport { title: string; generatedAt: string; truncated: boolean; students: StudentProgress[]; concepts: ConceptInsight[] }

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`)
const ago = (iso: string | null) => {
  if (!iso) return 'Never'
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  return d <= 0 ? 'Today' : d === 1 ? 'Yesterday' : `${d} days ago`
}
const STATE: Record<State, { label: string; cls: string }> = {
  mastered: { label: 'Mastered', cls: 'bg-ok-bg text-ok' },
  learning: { label: 'Learning', cls: 'bg-src-course-bg text-src-course' },
  stale: { label: 'Fading', cls: 'bg-warn-bg text-warn' },
  insufficient_evidence: { label: 'Not enough evidence', cls: 'bg-surface-2 text-muted' },
}

/** Stacked bar of how many students are in each mastery state for one concept (text alternative included). */
function StateBar({ s }: { s: ConceptInsight['students'] }) {
  const total = s.mastered + s.learning + s.stale + s.insufficient || 1
  const parts: [number, string, string][] = [[s.mastered, 'bg-ok', 'mastered'], [s.learning, 'bg-accent', 'learning'], [s.stale, 'bg-warn', 'fading'], [s.insufficient, 'bg-line-strong', 'not enough evidence']]
  return (
    <div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-2" aria-hidden>
        {parts.map(([n, cls, k]) => (n ? <span key={k} className={cls} style={{ width: `${(n / total) * 100}%` }} /> : null))}
      </div>
      <p className="mt-1 text-xs text-muted">{parts.filter(([n]) => n).map(([n, , k]) => `${n} ${k}`).join(' · ')}</p>
    </div>
  )
}

export default function EducatorProgress() {
  const { courseId = '' } = useParams()
  const s = useSession()
  const course = s.courses.find((c) => c.id === courseId)
  const r = useLoad(`progress:${courseId}`, (sig) => api.get<ProgressReport>(`${TUTOR}/courses/${courseId}/progress`, sig))
  const [q, setQ] = useState('')
  const [attentionOnly, setAttentionOnly] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const students = useMemo(() => {
    const list = (r.data?.students ?? []).filter((x) => (!attentionOnly || x.flags.length) && `${x.name} ${x.email}`.toLowerCase().includes(q.trim().toLowerCase()))
    return [...list].sort((a, b) => b.flags.length - a.flags.length || (a.avgMastery ?? -1) - (b.avgMastery ?? -1))
  }, [r.data, q, attentionOnly])

  if (!course) return <EmptyState title="Course not found"><Link to="/educator" className="text-accent underline">Back to your courses</Link></EmptyState>
  const conceptName = new Map((r.data?.concepts ?? []).map((c) => [c.conceptId, c.name]))
  const weakest = [...(r.data?.concepts ?? [])].filter((c) => c.avgMastery !== null).sort((a, b) => (a.avgMastery ?? 0) - (b.avgMastery ?? 0)).slice(0, 3)

  return (
    <>
      <PageHeader title="Learner progress" eyebrow={<Link to={`/educator/courses/${courseId}`} className="hover:underline">{course.code} · {course.title}</Link>}>
        <button type="button" onClick={r.reload} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-line-strong bg-surface px-4 font-semibold"><Icon name="refresh" size={18} />Refresh</button>
      </PageHeader>
      {r.loading && !r.data ? <Skeleton lines={6} /> : r.error ? <ErrorNote error={r.error} retry={r.reload} /> : !r.data!.students.length ? (
        <EmptyState title="No students enrolled yet">Enrol students from the course page to see their progress here.</EmptyState>
      ) : (
        <div className="grid gap-6">
          <p className="text-sm text-muted">Mastery uses the same evidence model students see. Tutor conversations stay private to each student and are not shown here.{r.data!.truncated ? ' Showing the first 500 students.' : ''}</p>
          {weakest.length ? (
            <Notice tone="info" icon="target" title="Where the class is weakest">
              {weakest.map((c) => `${c.name} (avg ${pct(c.avgMastery)}${c.practice.confidentWrong ? `, ${c.practice.confidentWrong} confident wrong answers` : ''})`).join(' · ')}
            </Notice>
          ) : null}

          <Card aria-labelledby="ci-h">
            <h2 id="ci-h" className="mb-3 text-lg font-semibold">Concepts</h2>
            <ul className="grid gap-4 md:grid-cols-2">
              {r.data!.concepts.map((c) => (
                <li key={c.conceptId} className="rounded-lg border border-line p-3">
                  <div className="mb-2 flex items-baseline justify-between gap-2"><p className="font-semibold">{c.name}</p><p className="text-sm text-muted">avg {pct(c.avgMastery)}</p></div>
                  <StateBar s={c.students} />
                  <p className="mt-1 text-xs text-muted">{c.practice.attempts} practice attempt{c.practice.attempts === 1 ? '' : 's'} · {pct(c.practice.correctRate)} correct{c.practice.confidentWrong ? ` · ${c.practice.confidentWrong} confident wrong` : ''}</p>
                  {c.misconceptions?.length ? (
                    <div className="mt-2">
                      <p className="text-xs font-semibold text-fg-soft">Common misconceptions (from diagnosed wrong answers)</p>
                      <ul className="mt-1 space-y-1">{c.misconceptions.map((m) => <li key={m.text} className="text-xs"><span className="font-semibold">{m.students} student{m.students === 1 ? '' : 's'}</span> · {m.text}{m.occurrences > m.students ? ` (${m.occurrences}×)` : ''}</li>)}</ul>
                    </div>
                  ) : null}
                  {c.errorTypes && Object.keys(c.errorTypes).length ? <p className="mt-1 text-xs text-muted">Error types: {Object.entries(c.errorTypes).map(([k, v]) => `${k} ${v}`).join(' · ')}</p> : null}
                </li>
              ))}
            </ul>
          </Card>

          <Card aria-labelledby="st-h">
            <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
              <h2 id="st-h" className="text-lg font-semibold">Students ({students.length})</h2>
              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={attentionOnly} onChange={(e) => setAttentionOnly(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />Needs attention only</label>
                <label htmlFor="sq" className="sr-only">Search students</label>
                <input id="sq" type="search" placeholder="Search name or email" value={q} onChange={(e) => setQ(e.target.value)} className={`${inputCls} w-56`} />
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-left text-sm">
                <caption className="sr-only">Student progress, students needing attention first</caption>
                <thead className="border-b border-line text-xs uppercase tracking-wide text-muted">
                  <tr><th scope="col" className="py-2 pr-3">Student</th><th scope="col" className="pr-3">Mastered</th><th scope="col" className="pr-3">Avg mastery</th><th scope="col" className="pr-3">Practice</th><th scope="col" className="pr-3">Revision</th><th scope="col" className="pr-3">Last active</th><th scope="col"><span className="sr-only">Details</span></th></tr>
                </thead>
                <tbody>
                  {students.map((st) => (
                    <StudentRow key={st.userId} st={st} total={r.data!.concepts.length} open={open === st.userId} onToggle={() => setOpen(open === st.userId ? null : st.userId)} conceptName={conceptName} />
                  ))}
                </tbody>
              </table>
            </div>
            {!students.length ? <p className="py-4 text-muted">No students match.</p> : null}
          </Card>
        </div>
      )}
    </>
  )
}

function StudentRow({ st, total, open, onToggle, conceptName }: { st: StudentProgress; total: number; open: boolean; onToggle: () => void; conceptName: Map<string, string> }) {
  const id = `sd-${st.userId}`
  return (
    <>
      <tr className="border-b border-line align-top">
        <th scope="row" className="py-2 pr-3 font-normal">
          <span className="block font-semibold">{st.name || st.email}</span>
          {st.name ? <span className="block text-xs text-muted">{st.email}</span> : null}
          {st.flags.length ? <ul className="mt-1 flex flex-wrap gap-1">{st.flags.map((f) => <li key={f} className="rounded bg-warn-bg px-1.5 py-0.5 text-xs text-warn">{f}</li>)}</ul> : null}
        </th>
        <td className="py-2 pr-3">{st.mastered} / {total}</td>
        <td className="py-2 pr-3">{pct(st.avgMastery)}</td>
        <td className="py-2 pr-3">{st.practice.attempts} · {pct(st.practice.correctRate)}<span className="block text-xs text-muted">{st.practice.last7Days} this week</span></td>
        <td className="py-2 pr-3">{st.revision.due} due<span className="block text-xs text-muted">{st.revision.overdue} overdue · {st.revision.cards} cards</span></td>
        <td className="py-2 pr-3">{ago(st.lastActiveAt)}</td>
        <td className="py-2"><button type="button" onClick={onToggle} aria-expanded={open} aria-controls={id} className="inline-flex min-h-11 items-center rounded-lg px-2 text-accent hover:underline">{open ? 'Hide' : 'Concepts'}</button></td>
      </tr>
      {open ? (
        <tr id={id} className="border-b border-line bg-surface-2/50">
          <td colSpan={7} className="px-2 py-3">
            {Object.keys(st.concepts).length ? (
              <ul className="flex flex-wrap gap-2">
                {Object.entries(st.concepts).map(([cid, c]) => (
                  <li key={cid} className={`rounded-md px-2 py-1 text-xs font-semibold ${STATE[c.state].cls}`}>{conceptName.get(cid) ?? 'Concept'}: {STATE[c.state].label} ({pct(c.pMastery)})</li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted">No evidence on any concept yet.</p>}
          </td>
        </tr>
      ) : null}
    </>
  )
}

