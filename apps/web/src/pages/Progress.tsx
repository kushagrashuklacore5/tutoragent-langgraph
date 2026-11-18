import { Link } from 'react-router'
import { TUTOR, api } from '../lib/api.ts'
import type { ConceptMastery, Course } from '../lib/tutor.ts'
import { useSession } from '../session.tsx'
import { Card, EmptyState, ErrorNote, PageHeader, Skeleton, useLoad } from '../ui/kit.tsx'
import { MasteryChip } from '../ui/Mastery.tsx'

/** Learning profile: every estimate with the evidence behind it, and a way to contest it by re-testing. */
export default function Progress() {
  const s = useSession()
  return (
    <>
      <PageHeader title="Progress" eyebrow="Learning profile" />
      <p className="mb-6 max-w-prose text-fg-soft">Each estimate is computed only from your answers — never typed in by anyone. If one looks wrong, re-test it: new answers update it straight away.</p>
      {!s.courses.length ? <EmptyState title="No courses yet">Your profile fills in as you practise in a course.</EmptyState> : (
        <div className="grid gap-6">{s.courses.map((c) => <CourseProfile key={c.id} course={c} />)}</div>
      )}
    </>
  )
}

function CourseProfile({ course }: { course: Course }) {
  const m = useLoad(`m:${course.id}`, (sig) => api.get<ConceptMastery[]>(`${TUTOR}/courses/${course.id}/mastery`, sig))
  const base = `/app/education/tutor/courses/${course.id}`
  return (
    <Card aria-labelledby={`p-${course.id}`}>
      <h2 id={`p-${course.id}`} className="mb-3 text-lg font-semibold"><span className="font-mono text-sm text-muted">{course.code}</span> {course.title}</h2>
      {m.loading ? <Skeleton lines={3} /> : m.error ? <ErrorNote error={m.error} retry={m.reload} /> : !m.data!.length ? <p className="text-muted">No concepts published yet.</p> : (
        <ul className="divide-y divide-line">
          {m.data!.map((x) => (
            <li key={x.conceptId} className="flex flex-col gap-2 py-3 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0">
                <p className="font-semibold">{x.name}</p>
                <p className="text-sm text-muted">{x.explanation}</p>
                <p className="text-xs text-faint">{x.evidenceCount} answers · {x.distinctDays} day{x.distinctDays === 1 ? '' : 's'} · {x.unassistedCorrect} correct without hints · model {x.modelVersion}</p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-3">
                <MasteryChip m={x} />
                <Link to={`${base}/practice?conceptId=${x.conceptId}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline-offset-2 hover:underline">{x.evidenceCount ? 'Re-test' : 'Start'}</Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
