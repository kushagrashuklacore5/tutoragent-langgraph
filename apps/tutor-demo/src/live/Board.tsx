import { memo } from 'react'
import type { Block } from '../../../web/src/lib/studio.ts'
import { MathText } from '../components/RichText.tsx'
import { exampleSteps, formulaTerms } from './choreography.ts'

/** The Smart Board: shows only real blocks of the lesson. Steps and terms are parts of their own text. */
function Steps({ parts, kind }: { parts: string[]; kind: 'term' | 'step' }) {
  return <>{parts.map((x, i) => <span key={i} data-step={i} className={`td-b-${kind}`}><MathText text={x} /></span>)}</>
}
function formulaBody(text: string) {
  const terms = formulaTerms(text)
  if (terms.length < 2) return <span data-step={0} className="td-b-term"><MathText text={text} /></span>
  // keep the formula exactly as written, wrapping each real term where it occurs
  const out: React.ReactNode[] = []
  let at = 0
  terms.forEach((t, i) => {
    const k = text.indexOf(t, at)
    if (k < 0) return
    if (k > at) out.push(<MathText key={`g${i}`} text={text.slice(at, k)} />)
    out.push(<span key={i} data-step={i} className="td-b-term"><MathText text={t} /></span>)
    at = k + t.length
  })
  if (at < text.length) out.push(<MathText key="rest" text={text.slice(at)} />)
  return out
}
function BoardBlock({ b }: { b: Block }) {
  switch (b.type) {
    case 'heading': return <h2 data-point><MathText text={b.text} /></h2>
    case 'formula': return <p className="td-b-formula" data-point>{formulaBody(b.text)}</p>
    case 'definition': return <p data-point><strong className="td-b-key">{b.term}</strong> <MathText text={b.text} /></p>
    case 'example': return <><p className="td-b-label">Worked example</p><div className="td-b-steps" data-point><Steps parts={exampleSteps(b.text)} kind="step" /></div></>
    case 'list': return <>{b.text ? <p><MathText text={b.text} /></p> : null}<ul data-point>{(b.items ?? []).map((x, i) => <li key={i} data-step={i} className="td-b-step"><MathText text={x} /></li>)}</ul></>
    case 'figure': return b.figure?.thumb ? <figure data-point><img src={b.figure.thumb} alt={b.figure.alt} /><figcaption>{b.figure.caption}<small>{b.figure.credit}</small></figcaption></figure> : <p data-point>{b.figure?.caption}</p>
    case 'tip': return <><p className="td-b-label">Remember</p><p data-point><MathText text={b.text} /></p></>
    case 'exam': return <><p className="td-b-label">Exam point</p><p data-point><MathText text={b.text} /></p></>
    case 'summary': return <><p className="td-b-label">In short</p><p data-point><MathText text={b.text} /></p></>
    case 'excerpt': return <blockquote data-point><MathText text={b.text} /></blockquote>
    default: return <p data-point><MathText text={b.text} /></p>
  }
}

export const Board = memo(function Board({ title, blocks, shown, active }: { title: string; blocks: Block[]; shown: Set<string>; active: string | null }) {
  return (
    <div className="td-board-body">
      <p className="td-board-title">{title}</p>
      {blocks.filter((b) => shown.has(b.id)).map((b) => <section key={b.id} data-board={b.id} className={`td-b is-${b.type}${active === b.id ? ' is-active' : ''}`}><BoardBlock b={b} /></section>)}
    </div>
  )
})
