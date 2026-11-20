import { useEffect, useRef } from 'react'
import { Link, NavLink, Outlet, useOutletContext, useParams } from 'react-router'
import { prefs } from '../lib/storage.ts'
import type { Course } from '../lib/tutor.ts'
import { useSession } from '../session.tsx'
import { EmptyState, Loading } from '../ui/kit.tsx'

export function useCourse(): Course { return useOutletContext<{ course: Course }>().course }

export default function CourseLayout() {
  const { courseId } = useParams()
  const s = useSession()
  const course = s.courses.find((c) => c.id === courseId)
  useEffect(() => { if (course) prefs.setLastCourse(course.id) }, [course])
  // a course created a moment ago in the chat is not in the list loaded at sign-in: refresh once before giving up
  const tried = useRef<string | null>(null)
  useEffect(() => { if (!course && courseId && tried.current !== courseId && s.courses.length) { tried.current = courseId; void s.refreshCourses() } }, [course, courseId, s])

  if (!course) {
    if ((!s.courses.length && !s.coursesError) || tried.current !== courseId) return <Loading />
    return <EmptyState title="Course not found" action={<Link to="/app/education/tutor" className="font-semibold text-accent underline">All courses</Link>}>You may not be enrolled in this course, or it no longer exists.</EmptyState>
  }
  const base = `/app/education/tutor/courses/${course.id}`
  const tabs = [
    { to: base, label: 'Overview', end: true },
    { to: `${base}/materials`, label: 'Materials' },
    { to: `${base}/practice`, label: 'Practice' },
    { to: `${base}/assessments`, label: 'Assessments' },
    { to: `${base}/revision`, label: 'Revision' },
    { to: `${base}/plan`, label: 'Plan' },
    { to: `${base}/exam`, label: 'Exam insights' },
  ]
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 text-sm text-muted">
        <Link to="/app/education/tutor" className="underline-offset-2 hover:underline">Courses</Link><span aria-hidden>/</span>
        <span className="font-mono">{course.code}</span><span className="truncate">{course.title}</span>
      </div>
      <nav aria-label="Course sections" className="-mx-4 mb-5 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
        <ul className="flex min-w-max gap-1">
          {tabs.map((t) => (
            <li key={t.to}>
              <NavLink to={t.to} end={t.end} className={({ isActive }) => `anim inline-flex min-h-11 items-center border-b-2 px-3 text-[0.94rem] ${isActive ? 'border-accent font-semibold text-fg' : 'border-transparent text-muted hover:text-fg'}`}>{t.label}</NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <Outlet context={{ course }} />
    </div>
  )
}
