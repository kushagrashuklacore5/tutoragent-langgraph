import { HeroVidya } from '../live/HeroVidya.tsx'

const STEPS = [
  ['Understands your goal', 'Asks only what it still needs to know.'],
  ['Reads your material', 'Topics come from your document, not a template.'],
  ['Teaches, then checks', 'A notebook, guided hints and checked answers.'],
]

export function Launch({ opening, error, notice, onEnter }: { opening: boolean; error: string | null; notice: string | null; onEnter: () => void }) {
  return (
    <main className={`td-launch${opening ? ' is-opening' : ''}`}>
      <header className="td-launch-bar"><span className="td-brand"><i aria-hidden>ए</i>Ek Bharat<b>.AI</b></span><span className="td-tag">Tutor preview</span></header>
      <section className="td-launch-copy">
        <p className="td-eyebrow">Your personal AI tutor</p>
        <h1>Meet Vidya.<br /><em>A tutor that teaches from what you study.</em></h1>
        <p className="td-lede">Share your goal or upload your notes. This is the real Ek Bharat.AI Tutor, running live in a demo session.</p>
        <button type="button" className="td-cta" onClick={onEnter} disabled={opening}>{opening ? 'Opening your workspace…' : 'Start learning with Vidya'}<span aria-hidden>→</span></button>
        {error ? <p role="alert" className="td-alert">{error}</p> : null}
        {notice ? <p role="status" className="td-note">{notice}</p> : null}
        <ol className="td-launch-steps">{STEPS.map(([t, d], i) => <li key={t}><span>0{i + 1}</span><div><strong>{t}</strong><p>{d}</p></div></li>)}</ol>
      </section>
      <button type="button" className="td-portrait-btn" onClick={onEnter} disabled={opening} aria-label="Open the demo workspace with Vidya">
        <HeroVidya opening={opening} />
        <span className="td-portrait-hint" aria-hidden>{opening ? 'Preparing your desk' : 'Begin with Vidya'}</span>
      </button>
    </main>
  )
}
