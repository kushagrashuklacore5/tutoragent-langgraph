import { Link, Navigate } from 'react-router'
import { TUTOR, api } from '../lib/api.ts'
import { prefs } from '../lib/storage.ts'
import { TASK_KIND_LABEL, countdownText, daysUntil, todaysTasks, ymd, type Card as Flashcard, type PlanTask } from '../lib/tutor.ts'
import { useSession } from '../session.tsx'
import { Icon } from '../ui/icons.tsx'
import { Card, EmptyState, ErrorNote, PageHeader, Skeleton, useLoad } from '../ui/kit.tsx'

const base = (id: string) => `/app/education/tutor/courses/${id}`
const taskLink = (courseId: string, t: PlanTask) => t.kind === 'review' ? `${base(courseId)}/revision` : t.kind === 'practice' ? `${base(courseId)}/practice?conceptId=${t.conceptId}` : `${base(courseId)}/tutor?conceptId=${t.conceptId}`

export default function Home() {
  const s = useSession()
  const me = s.me!
  const studyCourses = s.courses.filter((c) => c.role === 'student' || s.canStudy)
  const due = useLoad(s.tutorEnabled && s.canStudy ? 'due' : null, (sig) => api.get<Flashcard[]>(`${TUTOR}/cards/due`, sig))

  if (s.tutorEnabled && s.canStudy && s.courses.length && !prefs.onboarded(me.userId)) return <Navigate to="/onboarding" replace />

  const greeting = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 17 ? 'Good afternoon' : 'Good evening'
  if (!s.tutorEnabled) {
    return (
      <>
        <PageHeader title={greeting} eyebrow="Today" />
        <EmptyState title="No study tools are switched on yet">Your institution has not enabled any learning modules for your account. When they do, your courses and today's tasks will appear here.</EmptyState>
      </>
    )
  }
  const today = ymd(new Date())
  const rows = studyCourses.map((c) => ({ course: c, plan: prefs.plan(me.userId, c.id), goal: prefs.goal(me.userId, c.id) }))
  const tasks = rows.flatMap((r) => todaysTasks(r.plan, today).map((t) => ({ t, course: r.course }))).slice(0, 3)
  const exams = rows.filter((r) => r.goal?.examAt).map((r) => ({ course: r.course, days: daysUntil(r.goal!.examAt!) })).filter((x) => x.days >= 0).sort((a, b) => a.days - b.days)
  const anyPlan = rows.some((r) => r.plan)

  return (
    <>
      <PageHeader title={greeting} eyebrow={new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })} />
      {s.coursesError ? <ErrorNote error={s.coursesError} retry={() => void s.refreshCourses()} /> : null}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" aria-labelledby="today-h">
          <h2 id="today-h" className="mb-3 text-lg font-semibold">Today</h2>
          {!s.courses.length ? (
            <EmptyState icon="book" title="You are not enrolled in a course yet">Courses appear here once your educator enrols you.</EmptyState>
          ) : tasks.length ? (
            <ol className="divide-y divide-line">
              {tasks.map(({ t, course }, i) => (
                <li key={i}>
                  <Link to={taskLink(course.id, t)} className="anim -mx-2 flex min-h-14 items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface-2">
                    <span className="grid h-9 w-9 place-items-center rounded-full border border-line-strong font-mono text-sm" aria-hidden>{i + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold">{TASK_KIND_LABEL[t.kind]} · {t.kind === 'review' ? 'Spaced revision' : t.conceptName}</span>
                      <span className="block text-sm text-muted">{course.code} · {t.minutes} min</span>
                    </span>
                    <Icon name="right" className="text-muted" />
                  </Link>
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState icon="calendar" title={anyPlan ? 'Nothing planned for today' : 'No plan yet'}
              action={<Link to={`${base(studyCourses[0]?.id ?? s.courses[0]!.id)}/plan`} className="font-semibold text-accent underline underline-offset-2">{anyPlan ? 'Open your plan' : 'Make a study plan'}</Link>}>
              {anyPlan ? 'Enjoy the breather, or get ahead with some practice.' : 'Tell us your exam date and daily time; we will plan what to do each day.'}
            </EmptyState>
          )}
        </Card>

        <div className="grid gap-4">
          <Card aria-labelledby="due-h">
            <h2 id="due-h" className="mb-1 text-lg font-semibold">Revision</h2>
            {due.loading ? <Skeleton lines={1} /> : due.error ? <ErrorNote error={due.error} retry={due.reload} feature="Revision" /> : (
              <>
                <p className="text-fg-soft"><span className="font-serif text-3xl text-fg">{due.data!.length}</span> card{due.data!.length === 1 ? '' : 's'} due now</p>
                {due.data!.length ? <Link to="/revise" className="mt-2 inline-flex min-h-11 items-center gap-1 font-semibold text-accent underline underline-offset-2">Start revision <Icon name="right" size={16} /></Link> : <p className="text-sm text-muted">Nothing due. Well kept.</p>}
              </>
            )}
          </Card>
          <Card aria-labelledby="exam-h">
            <h2 id="exam-h" className="mb-1 text-lg font-semibold">Next exam</h2>
            {exams[0] ? (
              <p className="text-fg-soft"><span className="font-serif text-3xl text-fg">{exams[0].days}</span> {exams[0].days === 1 ? 'day' : 'days'} · {exams[0].course.code}<span className="sr-only"> ({countdownText(exams[0].days)})</span></p>
            ) : <p className="text-sm text-muted">No exam date set. Add one in a course's Plan tab.</p>}
          </Card>
        </div>
      </div>

      {s.courses.length ? (
        <section className="mt-6" aria-labelledby="courses-h">
          <h2 id="courses-h" className="mb-3 text-lg font-semibold">Your courses</h2>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {s.courses.map((c) => (
              <li key={c.id}>
                <Link to={base(c.id)} className="anim block rounded-xl border border-line bg-surface p-4 hover:border-line-strong">
                  <span className="font-mono text-sm text-muted">{c.code}</span>
                  <span className="block font-semibold">{c.title}</span>
                  <span className="text-sm text-muted">{c.role === 'educator' ? 'You teach this course' : c.term ?? 'Enrolled'}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  )
}
