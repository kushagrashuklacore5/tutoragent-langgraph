import { useEffect, useState } from 'react'
import type { ConceptMastery } from '../../../web/src/lib/tutor.ts'
import { get, S, TUTOR } from '../lib/client.ts'
import { journey, type View } from '../lib/logic.ts'
import type { Tutor } from '../lib/useTutor.ts'
import { Icon } from './Icon.tsx'
import { Starter } from './Starter.tsx'

const TOUR_KEY = 'ebtd.tour'
const SCENARIOS: { title: string; body: string; action: 'ask' | View; prompt?: string; cta: string }[] = [
  { title: 'Understand a hard concept', body: 'Ask about quadratic equations and get a clear, worked explanation.', action: 'ask', prompt: 'What are quadratic equations? Explain step by step with one worked example, then ask me one question to check my understanding.', cta: 'Ask the Tutor' },
  { title: 'Learn from a document', body: 'Use the labelled sample notes. They run through the real document pipeline.', action: 'document', cta: 'Open documents' },
  { title: 'Ask inside the notebook', body: 'Select any line in a lesson and ask about exactly that.', action: 'notebook', cta: 'Open notebook' },
  { title: 'Try a practice set', body: 'Choose guided hints or the full solution on real, checked questions.', action: 'practice', cta: 'Open practice' },
  { title: 'See revision and progress', body: 'Only what this learner has actually done is shown.', action: 'progress', cta: 'Open progress' },
]

export function Home({ tutor, go, askTutor }: { tutor: Tutor; go: (v: View) => void; askTutor: () => void }) {
  const [facts, setFacts] = useState({ evidence: 0, dueCards: 0, books: 0 })
  const [tour, setTour] = useState(() => { try { return localStorage.getItem(TOUR_KEY) !== 'off' } catch { return true } })
  const v = tutor.view
  const profile = v?.profile as { courseId?: string; objective?: string; topic?: string; material?: string } | undefined
  const courseId = profile?.courseId
  const messages = tutor.messages.length
  useEffect(() => {
    const ctl = new AbortController()
    void Promise.all([
      get<unknown[]>(`${TUTOR}/cards/due`, ctl.signal),
      get<unknown[]>(`${S}/books`, ctl.signal),
      courseId ? get<ConceptMastery[]>(`${TUTOR}/courses/${courseId}/mastery`, ctl.signal) : Promise.resolve([] as ConceptMastery[]),
    ]).then(([due, books, mastery]) => setFacts({ dueCards: due.length, books: books.length, evidence: mastery.reduce((n, m) => n + m.evidenceCount, 0) }), () => undefined)
    return () => ctl.abort()
  }, [courseId, messages])
  const setTourOn = (on: boolean) => { setTour(on); try { localStorage.setItem(TOUR_KEY, on ? 'on' : 'off') } catch { /* private mode */ } }
  const stages = journey({
    objective: profile?.objective, topic: profile?.topic, material: profile?.material,
    courseTitle: v?.courses.find((c) => c.id === courseId)?.title, sourceTitle: v?.state.sourceDoc?.title,
    phase: v?.state.phase ?? 'onboarding', hasPlan: !!v?.state.appliedPlan, hasBook: facts.books > 0, evidence: facts.evidence, dueCards: facts.dueCards,
  })
  const next = stages.find((s) => s.state === 'current')
  const run = (s: (typeof SCENARIOS)[number]) => { if (s.action === 'ask') { askTutor(); void tutor.send(s.prompt!) } else go(s.action) }
  return (
    <div className="td-view">
      <header className="td-view-head"><p className="td-eyebrow">Your learning journey</p><h1>{next ? `Next: ${next.label.toLowerCase()}` : 'You are on track'}</h1><p>{next?.detail ?? 'Keep going with your plan, or ask the Tutor anything.'}</p></header>
      {!v?.state.appliedPlan && !tutor.messages.some((m) => m.role === 'student') ? <Starter tutor={tutor} go={go} askTutor={askTutor} /> : null}
      <ol className="td-journey">{stages.map((s, i) => <li key={s.id} className={`is-${s.state}`} style={{ '--i': i } as React.CSSProperties}><span aria-hidden>{s.state === 'done' ? <Icon name="check" /> : i + 1}</span><strong>{s.label}<em className="td-sr"> ({s.state})</em></strong><small>{s.detail}</small></li>)}</ol>
      {tour ? (
        <section aria-labelledby="td-tour">
          <div className="td-section-head"><h2 id="td-tour">Five things to try</h2><button type="button" className="td-text-btn" onClick={() => setTourOn(false)}>Skip the tour</button></div>
          <ol className="td-tour">{SCENARIOS.map((s, i) => <li key={s.title}><button type="button" onClick={() => run(s)} disabled={tutor.busy && s.action === 'ask'}><span>{i + 1}</span><div><strong>{s.title}</strong><p>{s.body}</p></div><em>{s.cta}<Icon name="send" /></em></button></li>)}</ol>
        </section>
      ) : <button type="button" className="td-text-btn" onClick={() => setTourOn(true)}>Show the guided tour</button>}
    </div>
  )
}
