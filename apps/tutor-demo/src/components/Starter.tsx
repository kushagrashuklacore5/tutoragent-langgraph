import { useState } from 'react'
import type { View } from '../lib/logic.ts'
import type { Tutor } from '../lib/useTutor.ts'

export type GoalId = 'learn' | 'concept' | 'chapter' | 'exam' | 'notes' | 'practice' | 'revise'
export const GOALS: { id: GoalId; title: string; hint: string }[] = [
  { id: 'learn', title: 'Learn a new subject', hint: 'From the very beginning' },
  { id: 'concept', title: 'Understand a difficult concept', hint: 'Explained until it clicks' },
  { id: 'chapter', title: 'Study an entire chapter', hint: 'Step by step' },
  { id: 'exam', title: 'Prepare for an exam', hint: 'Focused on what matters' },
  { id: 'notes', title: 'Explain my uploaded notes', hint: 'Taught from your file' },
  { id: 'practice', title: 'Practise questions', hint: 'With guided hints' },
  { id: 'revise', title: 'Revise what I have learned', hint: 'Bring it back to memory' },
]
const SUBJECTS = ['Mathematics', 'Physics', 'Chemistry', 'Biology', 'Machine Learning', 'Python', 'History', 'English']
const TIMES = [{ m: 30, l: '30 min' }, { m: 45, l: '45 min' }, { m: 60, l: '1 hour' }, { m: 120, l: '2 hours' }]
const SOURCES = [{ id: 'ai', l: 'Vidya prepares it', say: 'Use AI-prepared lessons.' }, { id: 'ncert', l: 'NCERT / syllabus', say: 'Follow the NCERT textbook.' }] as const
const ASKS_DETAIL: Partial<Record<GoalId, string>> = { concept: 'Which concept?', chapter: 'Which chapter?', exam: 'Which exam, and when?' }

/** One natural sentence for the real Tutor, so everything chosen here counts as already answered. */
export function composeRequest(c: { goal: GoalId; subject: string; detail?: string; minutes: number; source: 'ai' | 'ncert' }) {
  const s = c.subject.trim(), d = c.detail?.trim()
  const about = d ? `${s}: ${d}` : s
  const ask = c.goal === 'concept' ? `I want to understand a difficult concept in ${about}.`
    : c.goal === 'chapter' ? `I want to study an entire chapter of ${about}.`
      : c.goal === 'exam' ? `I want to prepare for an exam in ${about}.`
        : c.goal === 'practice' ? `I want to practise questions in ${about}.`
          : c.goal === 'revise' ? `I want to revise what I have learned in ${about}.`
            : `I want to learn ${about} from the beginning.`
  return `${ask} I can study ${c.minutes} minutes a day. ${SOURCES.find((x) => x.id === c.source)!.say}`
}

export function Starter({ tutor, go, askTutor }: { tutor: Tutor; go: (v: View) => void; askTutor: () => void }) {
  const [goal, setGoal] = useState<GoalId | null>(null)
  const [subject, setSubject] = useState('')
  const [other, setOther] = useState(false)
  const [detail, setDetail] = useState('')
  const [minutes, setMinutes] = useState(45)
  const [source, setSource] = useState<'ai' | 'ncert'>('ai')
  const [editing, setEditing] = useState(false)
  const pick = (g: GoalId) => { if (g === 'notes') { go('document'); return } setGoal(g) }
  const begin = () => {
    if (!goal || !subject.trim() || tutor.busy) return
    askTutor()
    void tutor.send(composeRequest({ goal, subject, detail, minutes, source }))
  }
  const label = ASKS_DETAIL[goal as GoalId]
  return (
    <section className="td-start" aria-labelledby="td-start-title">
      <h2 id="td-start-title">{goal ? 'What would you like to study?' : 'What shall we do today?'}</h2>
      {!goal ? (
        <ul className="td-goals">{GOALS.map((g) => <li key={g.id}><button type="button" onClick={() => pick(g.id)}><strong>{g.title}</strong><small>{g.hint}</small></button></li>)}</ul>
      ) : (
        <div className="td-start-form">
          <div className="td-chips" role="group" aria-label="Subject or skill">
            {SUBJECTS.map((s) => <button key={s} type="button" aria-pressed={!other && subject === s} onClick={() => { setOther(false); setSubject(s) }}>{s}</button>)}
            <button type="button" aria-pressed={other} onClick={() => { setOther(true); setSubject('') }}>Other</button>
          </div>
          {other ? <label className="td-field">Subject or skill<input autoFocus value={subject} maxLength={80} onChange={(e) => setSubject(e.target.value)} placeholder="For example, Organic Chemistry" /></label> : null}
          {label ? <label className="td-field">{label} <span>(optional)</span><input value={detail} maxLength={120} onChange={(e) => setDetail(e.target.value)} /></label> : null}
          {editing ? (
            <div className="td-prefs">
              <div className="td-chips" role="group" aria-label="Study time per day">{TIMES.map((t) => <button key={t.m} type="button" aria-pressed={minutes === t.m} onClick={() => setMinutes(t.m)}>{t.l}</button>)}</div>
              <div className="td-chips" role="group" aria-label="Material">{SOURCES.map((x) => <button key={x.id} type="button" aria-pressed={source === x.id} onClick={() => setSource(x.id)}>{x.l}</button>)}<button type="button" onClick={() => go('document')}>Upload my notes</button></div>
            </div>
          ) : <p className="td-defaults">{TIMES.find((t) => t.m === minutes)?.l} a day · {SOURCES.find((x) => x.id === source)!.l} <button type="button" className="td-text-btn" onClick={() => setEditing(true)}>Change</button></p>}
          <div className="td-row">
            <button type="button" className="td-primary" disabled={!subject.trim() || tutor.busy} onClick={begin}>Begin with Vidya</button>
            <button type="button" className="td-ghost" onClick={() => setGoal(null)}>Back</button>
          </div>
        </div>
      )}
      <button type="button" className="td-text-btn" onClick={askTutor}>Or just tell Vidya in your own words</button>
    </section>
  )
}
