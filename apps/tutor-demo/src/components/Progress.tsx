import { useCallback, useEffect, useRef, useState } from 'react'
import type { Card, ConceptMastery } from '../../../web/src/lib/tutor.ts'
import { friendly, get, post, TUTOR } from '../lib/client.ts'
import type { View } from '../lib/logic.ts'
import type { Tutor } from '../lib/useTutor.ts'
import { Icon } from './Icon.tsx'
import { MathText } from './RichText.tsx'

const GRADES = [{ g: 1, label: 'Again' }, { g: 2, label: 'Hard' }, { g: 3, label: 'Good' }, { g: 4, label: 'Easy' }]

export function Progress({ tutor, initialCourse, go }: { tutor: Tutor; initialCourse?: string; go: (v: View) => void }) {
  const courses = tutor.view?.courses ?? []
  const [courseId, setCourseId] = useState(initialCourse ?? tutor.view?.profile.courseId ?? courses[0]?.id ?? '')
  const [mastery, setMastery] = useState<ConceptMastery[] | null>(null)
  const [due, setDue] = useState<Card[] | null>(null)
  const [shown, setShown] = useState(false)
  const [busy, setBusy] = useState(false)
  const grading = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const { fail } = tutor
  const load = useCallback(async (signal?: AbortSignal) => {
    const [d, m] = await Promise.all([get<Card[]>(`${TUTOR}/cards/due`, signal), courseId ? get<ConceptMastery[]>(`${TUTOR}/courses/${courseId}/mastery`, signal) : Promise.resolve([] as ConceptMastery[])])
    setDue(d); setMastery(m)
  }, [courseId])
  useEffect(() => {
    const ctl = new AbortController()
    load(ctl.signal).catch((e) => { if (!ctl.signal.aborted) { fail(e); setError(friendly(e)) } })
    return () => ctl.abort()
  }, [load, fail])
  const grade = async (card: Card, g: number) => {
    if (grading.current) return
    grading.current = true
    setBusy(true); setError(null)
    try { await post(`${TUTOR}/cards/${card.id}/review`, { grade: g }); setShown(false); await load() }
    catch (e) { fail(e); setError(friendly(e)) } finally { grading.current = false; setBusy(false) }
  }
  const measured = (mastery ?? []).filter((m) => m.evidenceCount > 0)
  const notYet = (mastery ?? []).filter((m) => m.evidenceCount === 0)
  const weakest = measured.length > 1 ? [...measured].sort((a, b) => a.pMastery - b.pMastery)[0] : undefined // "weakest" of one topic says nothing
  const card = due?.[0]
  const nextSession = tutor.view?.state.nextSession
  return (
    <div className="td-view">
      <header className="td-view-head"><p className="td-eyebrow">Revision and mastery</p><h1>What this learner has really done</h1><p>Live data for the demo learner. Nothing here is sample or estimated without evidence.</p></header>
      {courses.length > 1 ? <label className="td-inline-select">Course<select value={courseId} onChange={(e) => setCourseId(e.target.value)}>{courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label> : null}
      {error ? <p role="alert" className="td-alert">{error}</p> : null}
      <div className="td-progress-grid">
        <section className="td-card">
          <h2>Mastery by topic</h2>
          {!mastery ? <div className="td-skeleton" aria-label="Loading mastery"><i /><i /></div> : null}
          {mastery && !courses.length ? <p className="td-muted-note">No course yet.</p> : null}
          {mastery && courses.length && !measured.length ? <div className="td-mini-empty"><p>No evidence yet. Mastery appears after real practice answers.</p><button type="button" className="td-ghost" onClick={() => go('practice')}>Go to practice</button></div> : null}
          <ul className="td-mastery">{measured.map((m) => <li key={m.conceptId}><div><strong><MathText text={m.name} /></strong><span>{Math.round(m.pMastery * 100)}%</span></div><span className="td-bar" role="img" aria-label={`Estimated mastery ${Math.round(m.pMastery * 100)} percent, range ${Math.round(m.low * 100)} to ${Math.round(m.high * 100)}`}><b style={{ left: `${m.low * 100}%`, width: `${(m.high - m.low) * 100}%` }} /><i style={{ width: `${m.pMastery * 100}%` }} /></span><small>{m.evidenceCount} answer{m.evidenceCount === 1 ? '' : 's'} · likely {Math.round(m.low * 100)}–{Math.round(m.high * 100)}%</small></li>)}</ul>
          {notYet.length && measured.length ? <p className="td-muted-note">{notYet.length} topic{notYet.length === 1 ? '' : 's'} not practised yet.</p> : null}
          {weakest ? <p className="td-callout">Needs most attention: <strong><MathText text={weakest.name} /></strong></p> : null}
        </section>
        <section className="td-card">
          <h2>Revision due</h2>
          {!due ? <div className="td-skeleton" aria-label="Loading revision"><i /><i /></div> : null}
          {due && !card ? <div className="td-mini-empty"><Icon name="check" /><p>Nothing due right now. Cards appear after practice and lessons.</p></div> : null}
          {card ? (
            <div className="td-flash">
              <small>{due!.length} card{due!.length === 1 ? '' : 's'} due</small>
              <p><MathText text={card.front} /></p>
              {shown ? <><hr /><p><MathText text={card.back} /></p><div className="td-grades">{GRADES.map((x) => <button key={x.g} type="button" className="td-ghost" disabled={busy} onClick={() => void grade(card, x.g)}>{x.label}</button>)}</div></> : <button type="button" className="td-primary" onClick={() => setShown(true)}>Show answer</button>}
            </div>
          ) : null}
        </section>
        {nextSession?.items.length ? <section className="td-card td-span"><h2>Recommended next</h2><ul className="td-next">{nextSession.items.map((x) => <li key={x.label}><span><MathText text={x.label} /></span><small>{x.minutes} min</small></li>)}</ul></section> : null}
      </div>
    </div>
  )
}
