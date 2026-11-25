import { useCallback, useEffect, useState } from 'react'
import { endSession, friendly, resetDemo } from '../lib/client.ts'
import type { Destination, View } from '../lib/logic.ts'
import { useTutor } from '../lib/useTutor.ts'
import { ChatPanel } from './ChatPanel.tsx'
import { DocumentStudio } from './DocumentStudio.tsx'
import { Home } from './Home.tsx'
import { Icon, type IconName } from './Icon.tsx'
import { Notebook } from './Notebook.tsx'
import { PracticeStudio } from './PracticeStudio.tsx'
import { Portrait } from './Portrait.tsx'
import { Progress } from './Progress.tsx'

const NAV: { id: View; label: string; icon: IconName }[] = [
  { id: 'home', label: 'Journey', icon: 'route' },
  { id: 'document', label: 'Documents', icon: 'file' },
  { id: 'notebook', label: 'Notebook', icon: 'book' },
  { id: 'practice', label: 'Practice', icon: 'target' },
  { id: 'progress', label: 'Progress', icon: 'chart' },
]

export function Workspace({ onExit, onExpired }: { onExit: () => void; onExpired: () => void }) {
  const [view, setView] = useState<View>('home')
  const [target, setTarget] = useState<Destination | null>(null)
  const [chatOpen, setChatOpen] = useState(false) // phones and tablets: the Tutor is a full-height sheet
  const [resetting, setResetting] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)
  const [epoch, setEpoch] = useState(0)

  const open = useCallback((d: Destination) => { setTarget(d); setView(d.view); setChatOpen(false) }, [])
  const tutor = useTutor(open, onExpired)
  const go = useCallback((v: View) => { setTarget(null); setView(v); setChatOpen(false) }, [])
  const { setBookContext, refresh } = tutor
  useEffect(() => { if (view !== 'notebook') setBookContext(null) }, [view, setBookContext])
  useEffect(() => {
    if (!chatOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setChatOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [chatOpen])

  const reset = async () => {
    setResetting(true); setResetError(null)
    try {
      await resetDemo()
      setConfirmReset(false); setTarget(null); setView('home'); setBookContext(null)
      await refresh()
      setEpoch((n) => n + 1)
    } catch (e) { setResetError(friendly(e)) } finally { setResetting(false) }
  }
  const leave = async () => { await endSession(); onExit() }

  return (
    <div className="td-shell">
      <header className="td-top">
        <span className="td-brand"><i aria-hidden>ए</i>Ek Bharat<b>.AI</b></span>
        <span className="td-tag">Live demo · sample learner</span>
        <div className="td-top-actions">
          <button type="button" className="td-ghost" onClick={() => setConfirmReset(true)} disabled={tutor.busy}><Icon name="reset" />Reset</button>
          <button type="button" className="td-ghost" onClick={() => void leave()}><Icon name="exit" />Exit</button>
        </div>
      </header>
      <nav className="td-rail" aria-label="Workspace">
        {NAV.map((n) => <button key={n.id} type="button" className={view === n.id ? 'is-active' : ''} aria-current={view === n.id ? 'page' : undefined} onClick={() => go(n.id)}><Icon name={n.icon} /><span>{n.label}</span></button>)}
        <button type="button" className={`td-rail-chat${chatOpen ? ' is-active' : ''}`} onClick={() => setChatOpen((x) => !x)} aria-expanded={chatOpen}><Icon name="chat" /><span>Tutor</span></button>
      </nav>
      <main className="td-main" key={`${view}:${epoch}`}>
        {view === 'home' ? <Home tutor={tutor} go={go} askTutor={() => setChatOpen(true)} /> : null}
        {view === 'document' ? <DocumentStudio tutor={tutor} askTutor={() => setChatOpen(true)} /> : null}
        {view === 'notebook' ? <Notebook tutor={tutor} target={target?.view === 'notebook' ? target : null} open={open} askTutor={() => setChatOpen(true)} go={go} /> : null}
        {view === 'practice' ? <PracticeStudio tutor={tutor} target={target?.view === 'practice' ? target : null} go={go} /> : null}
        {view === 'progress' ? <Progress tutor={tutor} initialCourse={target?.view === 'progress' ? target.courseId : undefined} go={go} /> : null}
      </main>
      <aside className={`td-chat${chatOpen ? ' is-open' : ''}`} aria-label="Vidya, your Tutor">
        <div className="td-chat-head">
          <span className="td-chat-face" aria-hidden><Portrait compact /></span>
          <div><strong>Vidya</strong><small>{tutor.busy ? 'Working on it…' : 'Your Ek Bharat.AI Tutor'}</small></div>
          <label className="td-sr" htmlFor="td-lang">Reply language</label>
          <select id="td-lang" value={tutor.language} onChange={(e) => tutor.setLanguage(e.target.value as typeof tutor.language)} disabled={tutor.busy}>
            <option value="en">English</option><option value="hinglish">Hinglish</option><option value="hi">हिन्दी</option>
          </select>
          <button type="button" className="td-icon-btn td-chat-close" onClick={() => setChatOpen(false)} aria-label="Close Tutor"><Icon name="close" /></button>
        </div>
        <ChatPanel tutor={tutor} open={open} goDocument={() => go('document')} />
      </aside>
      {confirmReset ? (
        <div className="td-modal" role="dialog" aria-modal="true" aria-labelledby="td-reset-title">
          <div>
            <h2 id="td-reset-title">Start the demo again?</h2>
            <p>This clears the sample learner's conversation, goal and notebooks. Courses and practice results stay on the demo account. Nothing outside it is touched.</p>
            {resetError ? <p role="alert" className="td-alert">{resetError}</p> : null}
            <div className="td-row"><button type="button" className="td-primary" onClick={() => void reset()} disabled={resetting}>{resetting ? 'Clearing…' : 'Clear and restart'}</button><button type="button" className="td-ghost" onClick={() => setConfirmReset(false)} disabled={resetting}>Keep going</button></div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
