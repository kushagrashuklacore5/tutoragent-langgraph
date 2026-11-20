import { useEffect, useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router'
import { TUTOR, api } from '../lib/api.ts'
import { S } from '../lib/studio.ts'
import type { ConceptGraph } from '../lib/tutor.ts'
import { prefs } from '../lib/storage.ts'
import { ErrorNote, Loading } from '../ui/kit.tsx'
import { useCourse } from './CourseLayout.tsx'

/**
 * There is ONE tutor: lessons happen in the book, with the universal chat beside it.
 * Old "guided lesson" links land here and open (or reuse) the book for that topic.
 */
export default function OpenLesson() {
  const course = useCourse()
  const [q] = useSearchParams()
  const conceptId = q.get('conceptId')
  const navigate = useNavigate()
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    if (!conceptId) return
    const ac = new AbortController()
    void (async () => {
      try {
        const g = await api.get<ConceptGraph>(`${TUTOR}/courses/${course.id}/concepts`, ac.signal)
        const name = g.concepts.find((c) => c.id === conceptId)?.name
        if (!name) { navigate('/', { replace: true }); return }
        const books = await api.get<{ id: string; title: string; courseId: string }[]>(`${S}/books`, ac.signal)
        const have = books.find((b) => b.courseId === course.id && b.title.trim().toLowerCase() === name.trim().toLowerCase())
        const id = have?.id ?? (await api.post<{ id: string }>(`${S}/books`, { courseId: course.id, title: name, language: prefs.language() })).id
        navigate(`/studio/${id}`, { replace: true })
      } catch (e) { if (!ac.signal.aborted) setError(e) }
    })()
    return () => ac.abort()
  }, [conceptId, course.id, navigate])
  if (!conceptId) return <Navigate to="/" replace />
  if (error) return <ErrorNote error={error} feature="lesson" />
  return <Loading label="Opening the lesson in your book" />
}
