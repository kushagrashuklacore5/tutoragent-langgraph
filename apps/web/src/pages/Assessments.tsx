import { useNavigate } from 'react-router'
import { TUTOR, api } from '../lib/api.ts'
import { Button, Card, EmptyState, ErrorNote, PageHeader, Skeleton, useAction, useLoad } from '../ui/kit.tsx'
import { useCourse } from './CourseLayout.tsx'

export interface AssessmentSummary {
  id: string; title: string; description: string; mode: 'practice' | 'exam' | 'diagnostic'; timeLimitMinutes: number | null; status: string; maxAttempts: number | null
  questionCount: number; sections: { title: string; count: number }[]
  attempts: { id: string; status: string; score: number | null; maxScore: number | null; startedAt: string }[]
}

const MODE: Record<AssessmentSummary['mode'], string> = { practice: 'Practice test', exam: 'Exam simulation', diagnostic: 'Diagnostic' }
const STATUS: Record<string, string> = { in_progress: 'In progress', grading: 'Marking…', graded: 'Marked', needs_review: 'Awaiting educator review' }

export default function Assessments() {
  const course = useCourse()
  const nav = useNavigate()
  const base = `/app/education/tutor/courses/${course.id}`
  const list = useLoad(`assess:${course.id}`, (sig) => api.get<AssessmentSummary[]>(`${TUTOR}/courses/${course.id}/assessments`, sig))
  const start = useAction()
  const begin = async (a: AssessmentSummary) => {
    const r = await start.run(() => api.post<{ id: string }>(`${TUTOR}/assessments/${a.id}/attempts`))
    if (r) nav(`${base}/assessments/${r.id}`)
  }
  return (
    <>
      <PageHeader title="Assessments" eyebrow={course.code} />
      <p className="mb-4 max-w-2xl text-sm text-muted">Questions are chosen for you from your educator's approved question bank, based on what you already know. Written answers are marked against a rubric; anything uncertain is checked by your educator before it counts.</p>
      {start.error ? <div className="mb-3"><ErrorNote error={start.error} /></div> : null}
      {list.loading ? <Skeleton lines={4} /> : list.error ? <ErrorNote error={list.error} retry={list.reload} /> : !list.data!.length ? (
        <EmptyState title="No assessments yet">Your educator hasn't published an assessment for this course.</EmptyState>
      ) : (
        <ul className="grid gap-3">
          {list.data!.map((a) => {
            const open = a.attempts.find((x) => x.status === 'in_progress')
            const used = a.attempts.length
            const exhausted = a.maxAttempts !== null && used >= a.maxAttempts && !open
            return (
              <li key={a.id}>
                <Card>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="text-lg font-semibold">{a.title}</h2>
                      <p className="text-sm text-muted">{MODE[a.mode]} · {a.questionCount} question{a.questionCount === 1 ? '' : 's'}{a.timeLimitMinutes ? ` · ${a.timeLimitMinutes} min` : ' · untimed'}{a.maxAttempts ? ` · ${used}/${a.maxAttempts} attempts used` : ''}</p>
                      {a.description ? <p className="mt-1 text-sm text-fg-soft">{a.description}</p> : null}
                    </div>
                    <Button variant="primary" busy={start.busy} disabled={exhausted} onClick={() => void begin(a)}>{open ? 'Resume' : used ? 'Try again' : 'Start'}</Button>
                  </div>
                  {a.attempts.filter((x) => x.status !== 'in_progress').length ? (
                    <ul className="mt-3 divide-y divide-line border-t border-line text-sm">
                      {a.attempts.filter((x) => x.status !== 'in_progress').map((x) => (
                        <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                          <span>{new Date(x.startedAt).toLocaleDateString()} · {STATUS[x.status] ?? x.status}{x.score !== null && x.maxScore ? ` · ${x.score}/${x.maxScore}` : ''}</span>
                          <a href={`${base}/assessments/${x.id}`} onClick={(e) => { e.preventDefault(); nav(`${base}/assessments/${x.id}`) }} className="font-semibold text-accent hover:underline">View results</a>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </Card>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}
