import { useEffect, useRef } from 'react'
import { Link, Outlet, useParams } from 'react-router'
import { useSession } from '../session.tsx'
import { EmptyState, Loading } from '../ui/kit.tsx'

/**
 * The practice agent's own space: one focused screen (no course tabs), the same practice engine underneath.
 * Opened by the chat ("practise"), the book ("Practise this topic") and the plan.
 */
export default function PracticeDesk() {
  const { courseId } = useParams()
  const s = useSession()
  const course = s.courses.find((c) => c.id === courseId)
  // a course created a moment ago in the chat may not be in the list loaded at sign-in yet
  const tried = useRef(false)
  useEffect(() => { if (!course && !tried.current && s.courses.length) { tried.current = true; void s.refreshCourses() } }, [course, s])
  if (!course) {
    if (!tried.current || (!s.courses.length && !s.coursesError)) return <Loading label="Opening practice" />
    return <EmptyState title="Course not found" action={<Link to="/" className="font-semibold text-accent underline">Back to the chat</Link>}>You may not be enrolled in this course.</EmptyState>
  }
  return (
    <div className="mx-auto max-w-3xl">
      <header className="pd-head mb-5">
        <span aria-hidden className="uc-avatar uc-av-coach">🎯</span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted">Practice coach</p>
          <p className="truncate font-serif text-xl">{course.title}</p>
        </div>
        <Link to="/" className="uc-pill">Back to chat</Link>
      </header>
      <Outlet context={{ course }} />
    </div>
  )
}
