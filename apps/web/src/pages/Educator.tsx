import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { TUTOR, api } from '../lib/api.ts'
import { useSession } from '../session.tsx'
import { Button, Card, EmptyState, ErrorNote, Field, PageHeader, inputCls, useAction } from '../ui/kit.tsx'

export default function Educator() {
  const s = useSession()
  const navigate = useNavigate()
  const [code, setCode] = useState('')
  const [title, setTitle] = useState('')
  const [term, setTerm] = useState('')
  const [mode, setMode] = useState('guided')
  const a = useAction()
  if (!s.isEducator) return <EmptyState title="Educators only">This area is for course educators.</EmptyState>
  const teaching = s.courses.filter((c) => c.role === 'educator')

  const create = async (e: FormEvent) => {
    e.preventDefault()
    const r = await a.run(() => api.post<{ id: string }>(`${TUTOR}/courses`, { code: code.trim(), title: title.trim(), term: term.trim() || undefined, integrityMode: mode }))
    if (r) { await s.refreshCourses(); navigate(`/educator/courses/${r.id}`) }
  }
  return (
    <>
      <PageHeader title="Educator" eyebrow="Your courses" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <section aria-labelledby="teach-h">
          <h2 id="teach-h" className="mb-3 text-lg font-semibold">Courses you teach</h2>
          {!teaching.length ? <EmptyState icon="school" title="No courses yet">Create a course to add concepts, practice questions and students.</EmptyState> : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {teaching.map((c) => (
                <li key={c.id}><Link to={`/educator/courses/${c.id}`} className="anim block rounded-xl border border-line bg-surface p-4 hover:border-line-strong">
                  <span className="font-mono text-sm text-muted">{c.code}</span><span className="block font-semibold">{c.title}</span>
                  <span className="text-sm text-muted">Manage concepts, items and students</span></Link></li>
              ))}
            </ul>
          )}
        </section>
        <Card className="h-fit">
          <form onSubmit={create} className="grid gap-3">
            <h2 className="text-lg font-semibold">New course</h2>
            <Field id="c-code" label="Code"><input id="c-code" value={code} onChange={(e) => setCode(e.target.value)} className={inputCls} maxLength={40} placeholder="MA101" /></Field>
            <Field id="c-title" label="Title"><input id="c-title" value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} maxLength={200} /></Field>
            <Field id="c-term" label="Term (optional)"><input id="c-term" value={term} onChange={(e) => setTerm(e.target.value)} className={inputCls} /></Field>
            <Field id="c-mode" label="Tutor policy" hint="How much the tutor may reveal.">
              <select id="c-mode" value={mode} onChange={(e) => setMode(e.target.value)} className={inputCls} aria-describedby="c-mode-hint">
                <option value="guided">Guided — full solution only after genuine attempts</option>
                <option value="hint_only">Hints only — never full solutions</option>
                <option value="open">Open — full solutions on request</option>
              </select>
            </Field>
            {a.error ? <ErrorNote error={a.error} /> : null}
            <Button type="submit" variant="primary" busy={a.busy} disabled={!code.trim() || !title.trim()}>Create course</Button>
          </form>
        </Card>
      </div>
    </>
  )
}
