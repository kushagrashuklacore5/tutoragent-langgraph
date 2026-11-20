import { Link } from 'react-router'
import { TUTOR, api } from '../lib/api.ts'
import type { ConceptGraph, ConceptMastery } from '../lib/tutor.ts'
import { useSession } from '../session.tsx'
import { EmptyState, ErrorNote, PageHeader, Skeleton, useLoad } from '../ui/kit.tsx'
import { MasteryChip } from '../ui/Mastery.tsx'
import { NextStep } from '../ui/NextStep.tsx'
import { useCourse } from './CourseLayout.tsx'

export default function Overview() {
  const course = useCourse()
  const s = useSession()
  const base = `/app/education/tutor/courses/${course.id}`
  const graph = useLoad(`g:${course.id}`, (sig) => api.get<ConceptGraph>(`${TUTOR}/courses/${course.id}/concepts`, sig))
  const mastery = useLoad(s.canStudy ? `m:${course.id}` : null, (sig) => api.get<ConceptMastery[]>(`${TUTOR}/courses/${course.id}/mastery`, sig))

  const byId = new Map(graph.data?.concepts.map((c) => [c.id, c]) ?? [])
  const mOf = new Map(mastery.data?.map((m) => [m.conceptId, m]) ?? [])
  const approved = graph.data?.concepts.filter((c) => c.status === 'approved') ?? []

  return (
    <>
      <PageHeader title={course.title} eyebrow={`${course.code}${course.term ? ` · ${course.term}` : ''}`} />
      {s.canStudy ? <NextStep courseId={course.id} base={base} /> : null}
      <section aria-labelledby="concepts-h">
        <h2 id="concepts-h" className="mb-1 text-lg font-semibold">Concepts</h2>
        <p className="mb-4 text-sm text-muted">Estimates come only from your answers. “Not enough evidence” means we have not seen enough to say — not that you are weak.</p>
        {graph.loading ? <Skeleton lines={5} /> : graph.error ? <ErrorNote error={graph.error} retry={graph.reload} /> : !approved.length ? (
          <EmptyState title="No concepts published yet">Your educator has not published this course's concept list yet.</EmptyState>
        ) : (
          <ol className="divide-y divide-line rounded-xl border border-line bg-surface">
            {approved.map((c) => {
              const m = mOf.get(c.id)
              const pre = graph.data!.prerequisites.filter((p) => p.concept === c.id).map((p) => byId.get(p.prerequisite)?.name).filter(Boolean)
              return (
                <li key={c.id} className="flex flex-col gap-2 p-4 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0 md:max-w-[60%]">
                    <h3 className="font-semibold">{c.name}</h3>
                    {c.description ? <p className="text-sm text-fg-soft">{c.description}</p> : null}
                    {pre.length ? <p className="text-xs text-muted">Builds on: {pre.join(', ')}</p> : null}
                    {m ? <p className="mt-1 text-sm text-muted">{m.explanation}</p> : null}
                  </div>
                  <div className="flex flex-col items-start gap-2 md:items-end">
                    {m ? <MasteryChip m={m} /> : mastery.loading ? <Skeleton lines={1} /> : null}
                    <div className="flex gap-3 text-sm">
                      <Link to={`${base}/practice?conceptId=${c.id}`} className="inline-flex min-h-11 items-center font-semibold text-accent underline-offset-2 hover:underline">Practise</Link>
                      <Link to={`${base}/tutor?conceptId=${c.id}`} className="inline-flex min-h-11 items-center font-semibold text-accent underline-offset-2 hover:underline">Learn in the book</Link>
                    </div>
                  </div>
                </li>
              )
            })}
          </ol>
        )}
        {mastery.error ? <div className="mt-3"><ErrorNote error={mastery.error} retry={mastery.reload} /></div> : null}
      </section>
    </>
  )
}
