import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { Link } from 'react-router'
import { TUTOR, api, describeError, isEndpointMissing, toApiError } from '../lib/api.ts'
import { prefs } from '../lib/storage.ts'
import { LANGUAGES, checkUpload, formatBytes, normalizeSegments, type AskResponse, type Citation, type Language, type Material } from '../lib/tutor.ts'
import { Icon } from '../ui/icons.tsx'
import { Button, Card, EmptyState, ErrorNote, Notice, PageHeader, Skeleton, inputCls, useLoad } from '../ui/kit.tsx'
import { SegmentList } from '../ui/Segments.tsx'
import { PagePreview, SourceOverlay, useMedia } from '../ui/SourcePanel.tsx'
import { useCourse } from './CourseLayout.tsx'

interface Upload { id: string; name: string; size: number; progress: number; error?: string; done?: boolean }

/** XHR (not fetch) so upload progress can be shown on slow connections. */
function uploadFile(courseId: string, file: File, mime: string, onProgress: (p: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${TUTOR}/courses/${courseId}/materials?filename=${encodeURIComponent(file.name)}`)
    xhr.setRequestHeader('content-type', mime)
    xhr.withCredentials = true
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total) }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve()
      let body: unknown = null
      try { body = JSON.parse(xhr.responseText) } catch { /* ignore */ }
      reject(toApiError(xhr.status, body))
    }
    xhr.onerror = () => reject(toApiError(0, null))
    xhr.send(file)
  })
}

const STATUS = {
  processing: { label: 'Processing', icon: 'clock', cls: 'text-warn bg-warn-bg' },
  ready: { label: 'Ready', icon: 'check', cls: 'text-ok bg-ok-bg' },
  failed: { label: 'Failed', icon: 'alert', cls: 'text-danger bg-danger-bg' },
} as const

export default function Materials() {
  const course = useCourse()
  const list = useLoad(`mat:${course.id}`, (sig) => api.get<Material[]>(`${TUTOR}/courses/${course.id}/materials`, sig))
  const [uploads, setUploads] = useState<Upload[]>([])
  const [drag, setDrag] = useState(false)
  const [actionError, setActionError] = useState<unknown>(null)
  const [citation, setCitation] = useState<Citation | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const wide = useMedia('(min-width: 1280px)')
  const missing = isEndpointMissing(list.error)

  // poll while anything is processing
  const processing = list.data?.some((m) => m.status === 'processing')
  useEffect(() => {
    if (!processing) return
    const t = window.setInterval(() => {
      api.get<Material[]>(`${TUTOR}/courses/${course.id}/materials`).then(list.setData, () => undefined)
    }, 3000)
    return () => window.clearInterval(t)
  }, [processing, course.id, list.setData])

  const addFiles = (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const id = `${file.name}-${Date.now()}-${Math.random()}`
      const check = checkUpload(file.name, file.size, file.type)
      if ('error' in check) { setUploads((u) => [...u, { id, name: file.name, size: file.size, progress: 0, error: check.error }]); continue }
      setUploads((u) => [...u, { id, name: file.name, size: file.size, progress: 0 }])
      const patch = (p: Partial<Upload>) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, ...p } : x)))
      uploadFile(course.id, file, check.mime, (progress) => patch({ progress })).then(
        () => { patch({ progress: 1, done: true }); list.reload(); window.setTimeout(() => setUploads((u) => u.filter((x) => x.id !== id)), 4000) },
        (e: unknown) => patch({ error: describeError(e) }),
      )
    }
  }
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files) }

  const act = async (fn: () => Promise<unknown>) => {
    setActionError(null)
    try { await fn(); list.reload() } catch (e) { setActionError(e) }
  }

  return (
    <div className={wide && citation ? 'grid grid-cols-[minmax(0,1fr)_24rem] gap-6' : ''}>
      <div className="min-w-0">
        <PageHeader title="Materials" eyebrow={course.code} />
        {missing ? <ErrorNote error={list.error} feature="Course materials" /> : (
          <div className="grid gap-6 lg:grid-cols-2">
            <AskNotes courseId={course.id} onCitation={setCitation} />
            <section aria-labelledby="lib-h" className="min-w-0">
              <h2 id="lib-h" className="mb-3 text-lg font-semibold">Library</h2>
              <div onDragOver={(e) => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
                className={`anim mb-4 flex flex-col items-center gap-2 rounded-xl border-2 border-dashed p-6 text-center ${drag ? 'border-accent bg-src-course-bg' : 'border-line-strong bg-surface'}`}>
                <Icon name="upload" className="text-muted" />
                <p className="text-fg-soft">Drop PDF, DOCX, PPTX or TXT files here</p>
                <p className="text-xs text-muted">Up to 50 MB each. {course.role === 'educator' ? 'Your uploads are marked as verified course material.' : 'Your uploads are private to you.'}</p>
                <Button icon="file" onClick={() => fileInput.current?.click()}>Choose files</Button>
                <input ref={fileInput} type="file" multiple hidden accept=".pdf,.docx,.pptx,.txt,application/pdf,text/plain" onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }} />
              </div>
              {uploads.length ? (
                <ul className="mb-4 space-y-2" aria-label="Uploads in progress" aria-live="polite">
                  {uploads.map((u) => (
                    <li key={u.id} className="rounded-lg border border-line bg-surface p-3">
                      <div className="flex justify-between gap-2 text-sm"><span className="truncate font-semibold">{u.name}</span><span className="shrink-0 text-muted">{formatBytes(u.size)}</span></div>
                      {u.error ? <p className="mt-1 text-sm text-danger" role="alert">{u.error}</p> : (
                        <>
                          <progress className="mt-2 h-2 w-full accent-[var(--color-accent)]" max={1} value={u.progress} aria-label={`Uploading ${u.name}`} />
                          <p className="text-xs text-muted">{u.done ? 'Uploaded — processing starts now' : `${Math.round(u.progress * 100)}%`}</p>
                        </>
                      )}
                      {u.error ? <button type="button" className="mt-1 min-h-11 text-sm underline" onClick={() => setUploads((x) => x.filter((y) => y.id !== u.id))}>Dismiss</button> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {actionError ? <div className="mb-3"><ErrorNote error={actionError} /></div> : null}
              {list.loading ? <Skeleton lines={4} /> : list.error ? <ErrorNote error={list.error} retry={list.reload} /> : !list.data!.length ? (
                <EmptyState icon="file" title="No materials yet">Add your notes, slides or textbook chapters. Answers from them come with page citations.</EmptyState>
              ) : (
                <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
                  {list.data!.map((m) => {
                    const st = STATUS[m.status] ?? STATUS.processing
                    return (
                      <li key={m.documentId} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-semibold" title={m.filename}>{m.filename}</p>
                          <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
                            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold ${st.cls}`}><Icon name={st.icon} size={12} />{st.label}</span>
                            <span>{m.trust === 'verified_course' ? 'Verified course material' : 'Your upload'}</span>
                            {m.pages ? <span>{m.pages} pages</span> : null}
                            <span>v{m.version}</span>
                          </p>
                          {m.status === 'failed' && m.error ? <p className="mt-1 text-sm text-danger">{m.error}</p> : null}
                        </div>
                        <div className="flex gap-1">
                          {m.status === 'ready' ? <Link to={`/app/education/tutor/courses/${course.id}/materials/${m.documentId}/1`} className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-semibold text-accent hover:bg-surface-2">Read</Link> : null}
                          {m.status === 'failed' && m.mine !== false ? <Button variant="ghost" icon="refresh" onClick={() => void act(() => api.post(`${TUTOR}/materials/${m.documentId}/reprocess`))}>Retry</Button> : null}
                          {m.mine === false ? null : <Button variant="ghost" icon="trash" aria-label={`Delete ${m.filename}`} onClick={() => { if (window.confirm(`Delete ${m.filename}? Answers will no longer cite it.`)) void act(() => api.del(`${TUTOR}/materials/${m.documentId}`)) }} />}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
      {wide && citation ? (
        <aside aria-label="Source" className="sticky top-4 h-fit rounded-xl border border-line bg-surface p-4">
          <div className="mb-2 flex items-center justify-between"><h2 className="font-semibold">Source</h2>
            <button type="button" onClick={() => setCitation(null)} aria-label="Close source" className="inline-flex h-11 w-11 items-center justify-center rounded-lg hover:bg-surface-2"><Icon name="x" /></button></div>
          <PagePreview c={citation} courseId={course.id} />
        </aside>
      ) : null}
      <SourceOverlay citation={citation} onClose={() => setCitation(null)} courseId={course.id} />
    </div>
  )
}

function AskNotes({ courseId, onCitation }: { courseId: string; onCitation: (c: Citation) => void }) {
  const [q, setQ] = useState('')
  const [language, setLanguage] = useState<Language>(prefs.language())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [answer, setAnswer] = useState<{ question: string; r: AskResponse } | null>(null)

  const ask = async (e: FormEvent) => {
    e.preventDefault()
    if (!q.trim()) return
    setBusy(true); setError(null)
    try {
      const r = await api.post<AskResponse>(`${TUTOR}/courses/${courseId}/ask`, { question: q.trim(), language })
      setAnswer({ question: q.trim(), r: { answerable: !!r.answerable, segments: normalizeSegments(r.segments) } })
    } catch (err) { setError(err) } finally { setBusy(false) }
  }
  return (
    <Card aria-labelledby="ask-h" className="h-fit">
      <h2 id="ask-h" className="mb-1 text-lg font-semibold">Ask my notes</h2>
      <p className="mb-3 text-sm text-muted">Answers are drawn from this course's materials, with page citations.</p>
      <form onSubmit={ask} className="flex flex-col gap-2">
        <label htmlFor="ask-q" className="sr-only">Your question</label>
        <textarea id="ask-q" rows={3} value={q} onChange={(e) => setQ(e.target.value)} className={inputCls} placeholder="e.g. What is the ε–δ definition of a limit?" maxLength={2000} />
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="ask-lang" className="sr-only">Language</label>
          <select id="ask-lang" value={language} onChange={(e) => setLanguage(e.target.value as Language)} className="min-h-11 rounded-lg border border-line-strong bg-surface px-2 text-sm">
            {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
          <Button type="submit" variant="primary" busy={busy} disabled={!q.trim()}>Ask</Button>
        </div>
      </form>
      <div aria-live="polite" className="mt-4">
        {error ? <ErrorNote error={error} feature="Ask my notes" /> : null}
        {answer ? (
          <div className="space-y-3">
            <p className="text-sm text-muted">Q: {answer.question}</p>
            {!answer.r.answerable ? <Notice tone="warn" title="Not found in your material">I couldn't find this in your uploaded material. Below is a general explanation — it is not from your course.</Notice> : null}
            <SegmentList segments={answer.r.segments} onOpenCitation={onCitation} />
          </div>
        ) : null}
      </div>
    </Card>
  )
}
