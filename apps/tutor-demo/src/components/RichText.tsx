import { Fragment, type ReactNode } from 'react'
import { mathParts } from '../lib/logic.ts'

/** Inline text with plain-notation maths (x^2, x_1, √) and **bold**. Rendered as text nodes only, never as HTML. */
export function MathText({ text }: { text: string }) {
  return <>{text.split(/(\*\*[^*]+\*\*)/g).map((seg, i) => {
    const bold = seg.startsWith('**') && seg.endsWith('**') && seg.length > 4
    const parts = mathParts(bold ? seg.slice(2, -2) : seg).map((p, j) =>
      p.kind === 'sup' ? <sup key={j}>{p.value}</sup> : p.kind === 'sub' ? <sub key={j}>{p.value}</sub> : <Fragment key={j}>{p.value}</Fragment>)
    return bold ? <strong key={i}>{parts}</strong> : <Fragment key={i}>{parts}</Fragment>
  })}</>
}

/** A Tutor reply: paragraphs, bullet and numbered lines. */
export function RichText({ text }: { text: string }) {
  const out: ReactNode[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  const flush = () => {
    if (!list) return
    const items = list.items.map((x, i) => <li key={i}><MathText text={x} /></li>)
    out.push(list.ordered ? <ol key={out.length}>{items}</ol> : <ul key={out.length}>{items}</ul>)
    list = null
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const bullet = /^[-•*]\s+(.*)/.exec(line)
    const num = /^\d+[.)]\s+(.*)/.exec(line)
    const m = bullet ?? num
    if (m) {
      const ordered = !bullet
      if (!list || list.ordered !== ordered) { flush(); list = { ordered, items: [] } }
      list.items.push(m[1]!)
      continue
    }
    flush()
    if (line) out.push(<p key={out.length}><MathText text={line.replace(/^#{1,4}\s+/, '')} /></p>)
  }
  flush()
  return <div className="td-rich">{out}</div>
}
