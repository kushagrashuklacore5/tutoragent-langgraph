import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { TUTOR, api } from '../lib/api.ts'
import { citationLabel, type Citation, type MaterialPage } from '../lib/tutor.ts'
import { Dialog, ErrorNote, Skeleton, useLoad } from './kit.tsx'

function useMedia(q: string): boolean {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches)
  useEffect(() => {
    const mq = window.matchMedia(q)
    const on = () => setM(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [q])
  return m
}
export { useMedia }

export function PagePreview({ c, courseId }: { c: Citation; courseId: string }) {
  const page = useLoad(`${c.documentId}:${c.pageStart}`, (sig) => api.get<MaterialPage>(`${TUTOR}/materials/${c.documentId}/pages/${c.pageStart}`, sig))
  return (
    <div>
      <p className="mb-2 font-mono text-sm text-src-course">[{citationLabel(c)}]</p>
      {page.loading ? <Skeleton lines={6} /> : page.error ? <ErrorNote error={page.error} retry={page.reload} feature="The page viewer" /> : (
        <div className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap rounded-lg border border-line bg-[#fdfdfb] p-4 font-serif text-[1.05rem] leading-relaxed text-[#1d2a33]">{page.data!.text}</div>
      )}
      <Link to={`/app/education/tutor/courses/${courseId}/materials/${c.documentId}/${c.pageStart}`} className="mt-3 inline-flex min-h-11 items-center font-semibold text-accent underline underline-offset-2">Open in reader</Link>
    </div>
  )
}

/**
 * Cited material: a right panel from 1280 px (rendered by the page in its grid), a slide-over at
 * 768–1279 px, and a bottom sheet on phones.
 */
export function SourceOverlay({ citation, onClose, courseId }: { citation: Citation | null; onClose: () => void; courseId: string }) {
  const wide = useMedia('(min-width: 1280px)')
  const tablet = useMedia('(min-width: 768px)')
  if (wide) return null
  return (
    <Dialog open={!!citation} onClose={onClose} title="Source" variant={tablet ? 'side' : 'sheet'}>
      {citation ? <PagePreview c={citation} courseId={courseId} /> : null}
    </Dialog>
  )
}
