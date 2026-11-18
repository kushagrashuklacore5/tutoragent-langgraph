import { Link, useNavigate, useParams } from 'react-router'
import { TUTOR, api } from '../lib/api.ts'
import type { MaterialPage } from '../lib/tutor.ts'
import { ErrorNote, PageHeader, Skeleton, useLoad } from '../ui/kit.tsx'
import { useCourse } from './CourseLayout.tsx'

/** Text page view of an uploaded document (paper-white in both themes). */
export default function Reader() {
  const course = useCourse()
  const { documentId = '', page = '1' } = useParams()
  const n = Math.max(1, Number(page) || 1)
  const navigate = useNavigate()
  const base = `/app/education/tutor/courses/${course.id}/materials`
  const p = useLoad(`${documentId}:${n}`, (sig) => api.get<MaterialPage>(`${TUTOR}/materials/${encodeURIComponent(documentId)}/pages/${n}`, sig))
  const go = (k: number) => navigate(`${base}/${documentId}/${k}`)

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={p.data?.filename ?? 'Reader'} eyebrow={`Page ${n}`} serif={false}>
        <Link to={base} className="inline-flex min-h-11 items-center font-semibold text-accent underline underline-offset-2">Back to materials</Link>
      </PageHeader>
      {p.loading ? <Skeleton lines={10} /> : p.error ? <ErrorNote error={p.error} retry={p.reload} feature="The reader" /> : (
        <article className="whitespace-pre-wrap break-words rounded-xl border border-line bg-[#fdfdfb] p-5 font-serif text-[1.12rem] leading-relaxed text-[#1d2a33] shadow-sm sm:p-8">{p.data!.text || 'This page has no extractable text.'}</article>
      )}
      <nav aria-label="Pages" className="mt-4 flex justify-between">
        <button type="button" disabled={n <= 1} onClick={() => go(n - 1)} className="min-h-11 rounded-lg border border-line-strong bg-surface px-4 font-semibold disabled:opacity-50">← Previous page</button>
        <button type="button" onClick={() => go(n + 1)} disabled={!!p.error} className="min-h-11 rounded-lg border border-line-strong bg-surface px-4 font-semibold disabled:opacity-50">Next page →</button>
      </nav>
    </div>
  )
}
