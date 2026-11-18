import { Link } from 'react-router'
import { useSession } from '../session.tsx'
import { EmptyState, ErrorNote, PageHeader } from '../ui/kit.tsx'

const MODE: Record<string, string> = { open: 'Full solutions allowed', guided: 'Guided: solutions after genuine attempts', hint_only: 'Hints only' }

export default function Courses() {
  const s = useSession()
  return (
    <>
      <PageHeader title="Courses" />
      {s.coursesError ? <ErrorNote error={s.coursesError} retry={() => void s.refreshCourses()} feature="Courses" /> : !s.courses.length ? (
        <EmptyState icon="book" title="No courses yet" action={s.isEducator ? <Link to="/educator" className="font-semibold text-accent underline">Create a course</Link> : undefined}>
          {s.isEducator ? 'Create your first course in the educator area.' : 'You will see your courses here once your educator enrols you.'}
        </EmptyState>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {s.courses.map((c) => (
            <li key={c.id}>
              <Link to={`/app/education/tutor/courses/${c.id}`} className="anim flex h-full flex-col gap-1 rounded-xl border border-line bg-surface p-5 hover:border-line-strong">
                <span className="font-mono text-sm text-muted">{c.code}{c.term ? ` · ${c.term}` : ''}</span>
                <span className="font-serif text-2xl leading-tight">{c.title}</span>
                <span className="mt-auto pt-2 text-sm text-muted">{c.role === 'educator' ? 'Educator' : 'Student'} · {MODE[c.integrity_mode] ?? c.integrity_mode}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
