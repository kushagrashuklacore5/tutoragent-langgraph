import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { TUTOR, api, request } from '../lib/api.ts'
import { S } from '../lib/studio.ts'
import { prefs } from '../lib/storage.ts'
import { useSession } from '../session.tsx'
import { Button, Card, EmptyState, ErrorNote, Field, PageHeader, inputCls, useAction, useLoad } from '../ui/kit.tsx'

interface BookRow { id: string; title: string; mode: 'source' | 'generated'; courseId: string; updatedAt: string; sections: number; ready: number }
type Source = 'file' | 'photo' | 'none'

/** Learning Studio library: open a book or start one from your own material (or from the course topics). */
export default function Studio() {
  const s = useSession()
  const nav = useNavigate()
  const books = useLoad<BookRow[]>('studio-books', (sig) => api.get(`${S}/books`, sig))
  const studentCourses = s.courses.filter((c) => c.role === 'student')
  const [courseId, setCourseId] = useState(studentCourses[0]?.id ?? s.courses[0]?.id ?? '')
  const [title, setTitle] = useState('')
  const [source, setSource] = useState<Source>('file')
  const [file, setFile] = useState<File | null>(null)
  const [stage, setStage] = useState('')
  const a = useAction()

  const waitReady = async (documentId: string) => {
    for (let i = 0; i < 90; i++) {
      const docs = await api.get<{ documentId: string; status: string; error?: string | null }[]>(`${TUTOR}/courses/${courseId}/materials`)
      const d = docs.find((x) => x.documentId === documentId)
      if (d?.status === 'ready') return
      if (d?.status === 'failed') throw new Error(d.error ?? 'The document could not be processed')
      await new Promise((r) => setTimeout(r, 2000))
    }
    throw new Error('Processing is taking longer than usual. Try again in a minute.')
  }

  const create = async () => {
    const r = await a.run(async () => {
      let documentId: string | undefined
      if (source !== 'none') {
        if (!file) throw new Error('Choose a file first')
        setStage(source === 'photo' ? 'Reading your photo…' : 'Uploading…')
        const up = await request<{ documentId: string }>('POST', `${source === 'photo' ? `${TUTOR}/courses/${courseId}/studio/ocr` : `${TUTOR}/courses/${courseId}/materials`}?filename=${encodeURIComponent(file.name)}`, undefined, { raw: file, contentType: file.type || 'application/octet-stream' })
        documentId = up.documentId
        setStage('Reading and indexing your material (headings, pages, search)…')
        await waitReady(documentId)
      }
      setStage('Planning the chapter…')
      return api.post<{ id: string }>(`${S}/books`, { courseId, title: title.trim() || file?.name.replace(/\.[a-z0-9]+$/i, '') || 'My chapter', documentId, language: prefs.language() })
    })
    setStage('')
    if (r) nav(`/studio/${r.id}`)
  }

  return (
    <div className="mx-auto grid max-w-5xl gap-6">
      <PageHeader title="Learning Studio" eyebrow="Read, listen, ask — your book teaches back" />
      <Card className="grid gap-4 p-5">
        <h2 className="text-lg font-semibold">Start a chapter</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <Field id="st-course" label="Course">
            <select id="st-course" value={courseId} onChange={(e) => setCourseId(e.target.value)} className={inputCls}>
              {s.courses.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.title}</option>)}
            </select>
          </Field>
          <Field id="st-title" label="Chapter or topic">
            <input id="st-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} placeholder="e.g. Momentum and impulse" className={inputCls} />
          </Field>
        </div>
        <fieldset className="grid gap-2">
          <legend className="text-sm font-semibold">Learn from</legend>
          <div className="flex flex-wrap gap-2">
            {([['file', 'My PDF or notes'], ['photo', 'Photo of my notes'], ['none', 'No material — build it for me']] as const).map(([v, l]) => (
              <label key={v} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${source === v ? 'border-accent bg-accent/10' : 'border-line'}`}>
                <input type="radio" name="st-src" value={v} checked={source === v} onChange={() => { setSource(v); setFile(null) }} className="accent-[var(--color-accent)]" /> {l}
              </label>
            ))}
          </div>
          {source !== 'none' ? (
            <input aria-label={source === 'photo' ? 'Photo of notes' : 'PDF or notes file'} type="file" accept={source === 'photo' ? 'image/png,image/jpeg,image/webp' : '.pdf,.docx,.pptx,.txt,.md'} onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm" />
          ) : <p className="text-sm text-muted">The chapter is planned from your course topics and written as clearly labelled AI explanations, with your course's approved material cited where it is found.</p>}
        </fieldset>
        {a.error ? <ErrorNote error={a.error} /> : null}
        {stage ? <p role="status" className="text-sm text-muted">{stage}</p> : null}
        <Button variant="primary" busy={a.busy} disabled={!courseId || (source !== 'none' && !file)} onClick={() => void create()} className="justify-self-start">Create book</Button>
      </Card>

      <section aria-labelledby="st-books" className="grid gap-3">
        <h2 id="st-books" className="text-lg font-semibold">Your books</h2>
        {books.error ? <ErrorNote error={books.error} retry={books.reload} /> : null}
        {books.data && !books.data.length ? <EmptyState title="No books yet">Start a chapter above — upload a PDF or your notes, or let the tutor build one.</EmptyState> : null}
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(books.data ?? []).map((b) => (
            <li key={b.id}>
              <Link to={`/studio/${b.id}`} className="studio-cover block rounded-xl p-4">
                <p className="text-xs uppercase tracking-wide opacity-75">{b.mode === 'source' ? 'From your material' : 'Built for you'}</p>
                <p className="mt-2 font-serif text-xl leading-snug">{b.title}</p>
                <p className="mt-3 text-xs opacity-80">{b.ready}/{b.sections} sections written</p>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
