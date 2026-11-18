import { useEffect, useState, type FormEvent } from 'react'
import { useOutletContext } from 'react-router'
import { TUTOR, api } from '../lib/api.ts'
import type { Card as Flashcard, Course } from '../lib/tutor.ts'
import { useSession } from '../session.tsx'
import { Button, Card, EmptyState, ErrorNote, Field, Notice, PageHeader, Skeleton, inputCls, useAction, useLoad } from '../ui/kit.tsx'
import { Markdown } from '../ui/Markdown.tsx'

const GRADES = [
  { g: 1, label: 'Again', hint: 'Forgot' },
  { g: 2, label: 'Hard', hint: 'Recalled with effort' },
  { g: 3, label: 'Good', hint: 'Recalled' },
  { g: 4, label: 'Easy', hint: 'Instant' },
] as const

/** Due queue (all courses at /revise, one course inside a course workspace). Keys: Space shows the answer, 1–4 grade. */
export default function Revision() {
  const course = useOutletContext<{ course?: Course } | undefined>()?.course
  const s = useSession()
  const due = useLoad(`due:${course?.id ?? '*'}`, (sig) => api.get<Flashcard[]>(`${TUTOR}/cards/due`, sig))
  const queue = (due.data ?? []).filter((c) => !course || c.course_id === course.id)
  const [index, setIndex] = useState(0)
  const [shown, setShown] = useState(false)
  const [reviewed, setReviewed] = useState(0)
  const a = useAction()
  const card = queue[index]

  const grade = async (g: number) => {
    if (!card || !shown || a.busy) return
    const r = await a.run(() => api.post(`${TUTOR}/cards/${card.id}/review`, { grade: g }))
    if (r === undefined) return // error shown below the card
    setShown(false)
    setReviewed((x) => x + 1)
    setIndex((i) => i + 1)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, select, dialog')) return
      if (e.key === ' ' && card && !shown) { e.preventDefault(); setShown(true) }
      else if (['1', '2', '3', '4'].includes(e.key) && shown) { e.preventDefault(); void grade(Number(e.key)) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <>
      <PageHeader title="Revision" eyebrow={course ? course.code : 'All courses'} />
      <div className="mx-auto grid max-w-2xl gap-6">
        {due.loading ? <Card><Skeleton lines={3} /></Card> : due.error ? <ErrorNote error={due.error} retry={due.reload} /> : !card ? (
          <EmptyState icon="cards" title={reviewed ? `Done — ${reviewed} card${reviewed === 1 ? '' : 's'} reviewed` : 'Nothing due right now'}>
            {reviewed ? 'Each card will come back just before you are likely to forget it.' : 'Cards come back when they are due. Add your own below.'}
          </EmptyState>
        ) : (
          <section aria-labelledby="card-h">
            <p className="mb-2 text-sm text-muted" aria-live="polite">Card {index + 1} of {queue.length}</p>
            <Card className="min-h-48">
              <h2 id="card-h" className="sr-only">Flashcard</h2>
              <div className="text-[1.15rem]"><Markdown text={card.front} /></div>
              {shown ? <div className="mt-4 border-t border-line pt-4"><p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Answer</p><Markdown text={card.back} /></div> : null}
            </Card>
            {a.error ? <div className="mt-3"><ErrorNote error={a.error} /></div> : null}
            {!shown ? (
              <Button variant="primary" className="mt-4 w-full" onClick={() => setShown(true)} aria-keyshortcuts="Space">Show answer <kbd className="ml-1 hidden font-mono text-xs opacity-80 sm:inline">Space</kbd></Button>
            ) : (
              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label="How well did you recall it?">
                {GRADES.map((g) => (
                  <Button key={g.g} variant={g.g === 3 ? 'primary' : 'secondary'} onClick={() => void grade(g.g)} disabled={a.busy} aria-keyshortcuts={String(g.g)} className="flex-col !gap-0 py-2">
                    <span>{g.label} <kbd className="font-mono text-xs opacity-75">{g.g}</kbd></span><span className="text-xs font-normal opacity-80">{g.hint}</span>
                  </Button>
                ))}
              </div>
            )}
          </section>
        )}
        {s.canStudy ? <AddCard courses={course ? [course] : s.courses} onAdded={due.reload} /> : null}
      </div>
    </>
  )
}

function AddCard({ courses, onAdded }: { courses: Course[]; onAdded: () => void }) {
  const [courseId, setCourseId] = useState(courses[0]?.id ?? '')
  const [front, setFront] = useState('')
  const [back, setBack] = useState('')
  const [ok, setOk] = useState(false)
  const a = useAction()
  if (!courses.length) return null
  const add = async (e: FormEvent) => {
    e.preventDefault()
    const r = await a.run(() => api.post(`${TUTOR}/cards`, { courseId, front: front.trim(), back: back.trim() }))
    if (r !== undefined) { setFront(''); setBack(''); setOk(true); onAdded() }
  }
  return (
    <details className="rounded-xl border border-line bg-surface p-4">
      <summary className="cursor-pointer font-semibold">Add a flashcard</summary>
      <form onSubmit={add} className="mt-3 grid gap-3">
        {courses.length > 1 ? (
          <Field id="card-course" label="Course"><select id="card-course" value={courseId} onChange={(e) => setCourseId(e.target.value)} className={inputCls}>{courses.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.title}</option>)}</select></Field>
        ) : null}
        <Field id="front" label="Front (question)"><textarea id="front" rows={2} value={front} onChange={(e) => { setFront(e.target.value); setOk(false) }} className={inputCls} maxLength={1000} /></Field>
        <Field id="back" label="Back (answer)"><textarea id="back" rows={2} value={back} onChange={(e) => setBack(e.target.value)} className={inputCls} maxLength={2000} /></Field>
        {a.error ? <ErrorNote error={a.error} /> : null}
        {ok ? <Notice tone="ok">Card added. It is due now.</Notice> : null}
        <Button type="submit" busy={a.busy} disabled={!front.trim() || !back.trim()} className="justify-self-start">Add card</Button>
      </form>
    </details>
  )
}
