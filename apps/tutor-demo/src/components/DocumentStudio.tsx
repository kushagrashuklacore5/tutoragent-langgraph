import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { Material } from '../../../web/src/lib/tutor.ts'
import { checkUpload, formatBytes } from '../../../web/src/lib/tutor.ts'
import { DemoError, friendly, get, TUTOR, uploadFile } from '../lib/client.ts'
import type { Tutor } from '../lib/useTutor.ts'
import { PlanCard } from './ChatPanel.tsx'
import { Icon } from './Icon.tsx'
import { RichText } from './RichText.tsx'

type Phase = 'idle' | 'uploading' | 'reading' | 'analysing' | 'done' | 'failed'
const SAMPLE = { url: '/samples/photosynthesis-sample-notes.txt', name: 'photosynthesis-sample-notes.txt' }
const STAGES: { id: Phase; label: string }[] = [{ id: 'uploading', label: 'Upload' }, { id: 'reading', label: 'Parse and index' }, { id: 'analysing', label: 'Find topics' }, { id: 'done', label: 'Ready' }]

export function DocumentStudio({ tutor, askTutor }: { tutor: Tutor; askTutor: () => void }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [name, setName] = useState('')
  const [progress, setProgress] = useState(0)
  const [problem, setProblem] = useState<string | null>(null)
  const [drag, setDrag] = useState(false)
  const [replyId, setReplyId] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const working = phase === 'uploading' || phase === 'reading' || phase === 'analysing'

  const process = async (file: File) => {
    if (working || tutor.busy) return
    setProblem(null); setReplyId(null); setName(`${file.name} · ${formatBytes(file.size)}`)
    const check = checkUpload(file.name, file.size, file.type)
    if ('error' in check) { setProblem(check.error); setPhase('failed'); return }
    try {
      setPhase('uploading'); setProgress(0)
      // while setting up, the file starts its own course; with an active plan it joins the current course
      const active = tutor.view?.state.phase === 'active'
      const current = active ? (tutor.view?.profile.courseId ?? null) : null
      const up = await uploadFile(current, file, check.mime, setProgress)
      const courseId = up.courseId ?? current
      if (!courseId) throw new DemoError('upload_failed', 'The upload did not return a course.')
      setPhase('reading')
      let status: Material['status'] = 'processing'
      for (let i = 0; i < 90 && status === 'processing' && alive.current; i++) {
        await new Promise((r) => window.setTimeout(r, 1500))
        status = (await get<Material[]>(`${TUTOR}/courses/${courseId}/materials`)).find((m) => m.documentId === up.documentId)?.status ?? 'processing'
      }
      if (!alive.current) return
      if (status === 'processing') throw new DemoError('timeout', 'Reading this file is taking too long. Please try again later.')
      // ready or failed: the Tutor reports on the real status in the conversation
      setPhase('analysing')
      await tutor.refresh()
      const r = await tutor.send(`I have uploaded my notes: ${file.name}. Teach me from them.`, { documentId: up.documentId, documentTitle: file.name })
      if (!alive.current) return
      if (!r) throw new DemoError('analysis_failed', 'The Tutor could not analyse this file. Use Retry in the conversation or try again.')
      setReplyId(r.messages.at(-1)?.id ?? null)
      if (status === 'failed') { setProblem('This file could not be read. Nothing was taken from it.'); setPhase('failed') } else setPhase('done')
    } catch (e) { if (alive.current) { setProblem(friendly(e)); setPhase('failed') } }
  }
  const useSample = async () => {
    try {
      const res = await fetch(SAMPLE.url)
      if (!res.ok) throw new DemoError('sample_missing', 'The sample document could not be loaded.')
      await process(new File([await res.blob()], SAMPLE.name, { type: 'text/plain' }))
    } catch (e) { setProblem(friendly(e)); setPhase('failed') }
  }
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) void process(f) }

  // the reply about THIS upload, and what it offers next: all of it from the backend
  const msgs = tutor.messages
  const at = replyId ? msgs.findIndex((m) => m.id === replyId) : -1
  const reply = at >= 0 ? msgs[at] : undefined
  const topics = reply?.cards.find((c) => c.type === 'choices')?.choices ?? []
  const isLast = !!reply && msgs.at(-1)?.id === reply.id
  const pending = tutor.view?.pendingProposal
  const stageIndex = STAGES.findIndex((s) => s.id === phase)

  return (
    <div className="td-view">
      <header className="td-view-head"><p className="td-eyebrow">Document intelligence</p><h1>Learn from your own material</h1><p>The Tutor reads the real text, finds its topics and builds your roadmap from them. You approve it before anything starts.</p></header>
      <div className={`td-drop${drag ? ' is-drag' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
        <span className="td-drop-icon"><Icon name="file" /></span>
        <strong>Drop a file here</strong>
        <p>PDF, DOCX, PPTX or TXT, up to 50 MB. Please do not upload personal information: this is a shared demo account.</p>
        <div className="td-row">
          <button type="button" className="td-primary" onClick={() => input.current?.click()} disabled={working || tutor.busy}>Choose a file</button>
          <button type="button" className="td-ghost" onClick={() => void useSample()} disabled={working || tutor.busy}>Use sample notes</button>
        </div>
        <small>Sample: “Photosynthesis”, a short example document written for this demo.</small>
        <input ref={input} type="file" hidden accept=".pdf,.docx,.pptx,.txt" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void process(f) }} />
      </div>
      {phase !== 'idle' ? (
        <section className="td-card" aria-live="polite">
          <p className="td-file">{name}</p>
          {phase !== 'failed' ? <ol className="td-pipeline">{STAGES.map((s, i) => <li key={s.id} className={i < stageIndex || phase === 'done' ? 'is-done' : i === stageIndex ? 'is-now' : ''}><span aria-hidden>{i < stageIndex || phase === 'done' ? <Icon name="check" /> : i === stageIndex ? <b className="td-spin" /> : i + 1}</span>{s.label}{s.id === 'uploading' && phase === 'uploading' ? ` ${Math.round(progress * 100)}%` : ''}</li>)}</ol> : null}
          {problem ? <p role="alert" className="td-alert">{problem}</p> : null}
        </section>
      ) : null}
      {reply ? (
        <section className="td-card">
          <p className="td-eyebrow">What the Tutor found</p>
          <RichText text={reply.content} />
          {topics.length && isLast ? <div className="td-choices">{topics.map((t) => <button key={t} type="button" disabled={tutor.busy} onClick={() => { void tutor.send(t) }}>{t}</button>)}</div> : null}
        </section>
      ) : null}
      {reply && !isLast && !pending && tutor.view?.state.phase !== 'active' ? <button type="button" className="td-text-btn" onClick={askTutor}>The Tutor has a question for you. Open the conversation</button> : null}
      {pending ? <PlanCard p={pending} tutor={tutor} /> : null}
    </div>
  )
}
