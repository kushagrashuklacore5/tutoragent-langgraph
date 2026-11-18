import { memo, type ReactNode } from 'react'
import { parseMarkdown, prettyMath, type Inline } from '../lib/markdown.ts'

/** Safe renderer: every string becomes a React text node. Maths is shown as readable monospace (no KaTeX). */
function inline(nodes: Inline[], key = ''): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`
    switch (n.t) {
      case 'text': return n.v
      case 'strong': return <strong key={k}>{inline(n.c, k)}</strong>
      case 'em': return <em key={k}>{inline(n.c, k)}</em>
      case 'code': return <code key={k} className="math-inline">{n.v}</code>
      case 'math': return <span key={k} className="math-inline" role="math" aria-label={n.v} title={n.v}>{prettyMath(n.v)}</span>
      case 'link': return <a key={k} href={n.href} target="_blank" rel="noopener noreferrer nofollow">{inline(n.c, k)}</a>
    }
  })
}

export const Markdown = memo(function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const blocks = parseMarkdown(text)
  return (
    <div className={`prose-desk ${className}`}>
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'p': return <p key={i}>{inline(b.c)}</p>
          case 'h': return b.level <= 2 ? <h3 key={i}>{inline(b.c)}</h3> : <h4 key={i}>{inline(b.c)}</h4>
          case 'ul': return <ul key={i}>{b.items.map((it, j) => <li key={j}>{inline(it)}</li>)}</ul>
          case 'ol': return <ol key={i} start={b.start}>{b.items.map((it, j) => <li key={j}>{inline(it)}</li>)}</ol>
          case 'quote': return <blockquote key={i}>{inline(b.c)}</blockquote>
          case 'code': return (
            <figure key={i} className="my-2">
              {b.lang ? <figcaption className="text-xs font-semibold text-muted">{b.lang}</figcaption> : null}
              <pre className="code-block" tabIndex={0}><code>{b.text}</code></pre>
            </figure>
          )
          case 'math': return <div key={i} className="math-block" role="math" aria-label={b.text} title={b.text} tabIndex={0}>{prettyMath(b.text)}</div>
        }
      })}
    </div>
  )
})
