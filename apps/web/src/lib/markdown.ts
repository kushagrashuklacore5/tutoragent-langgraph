/**
 * Small, safe Markdown subset → AST. Rendering happens in React (text nodes only, never innerHTML), so
 * model or student text cannot inject markup. Supported: paragraphs, #–###### headings, - / 1. lists,
 * > quotes, ``` code fences, $$…$$ / \[…\] display maths, **bold**, *em* / _em_, `code`, $…$ / \(…\)
 * inline maths and [links](https://…) (http/https only).
 *
 * KaTeX is not installed: maths is shown as monospace text with a light LaTeX→Unicode pass (see prettyMath).
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'math'; v: string }
  | { t: 'link'; href: string; c: Inline[] }

export type Block =
  | { type: 'p'; c: Inline[] }
  | { type: 'h'; level: number; c: Inline[] }
  | { type: 'ul' | 'ol'; items: Inline[][]; start?: number }
  | { type: 'quote'; c: Inline[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'math'; text: string }

export function safeHref(href: string): string | null {
  try {
    const u = new URL(href)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null
  } catch {
    return null
  }
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = []
  let text = ''
  const flush = () => { if (text) { out.push({ t: 'text', v: text }); text = '' } }
  let i = 0
  while (i < src.length) {
    const ch = src[i]!
    const rest = src.slice(i)
    if (ch === '\\' && (src[i + 1] === '(')) {
      const end = src.indexOf('\\)', i + 2)
      if (end > 0) { flush(); out.push({ t: 'math', v: src.slice(i + 2, end).trim() }); i = end + 2; continue }
    }
    if (ch === '\\' && i + 1 < src.length && /[\\`*_$[\]()#>-]/.test(src[i + 1]!)) { text += src[i + 1]; i += 2; continue }
    if (ch === '`') {
      const end = src.indexOf('`', i + 1)
      if (end > i + 1) { flush(); out.push({ t: 'code', v: src.slice(i + 1, end) }); i = end + 1; continue }
    }
    if (ch === '$' && src[i + 1] !== '$' && src[i + 1] !== ' ') {
      const end = src.indexOf('$', i + 1)
      // `$5 and $10` is money, not maths: require no space before the closing $ and a non-digit after it
      if (end > i + 1 && src[end - 1] !== ' ' && !/\d/.test(src[end + 1] ?? '')) { flush(); out.push({ t: 'math', v: src.slice(i + 1, end) }); i = end + 1; continue }
    }
    if (rest.startsWith('**') || rest.startsWith('__')) {
      const mark = rest.slice(0, 2)
      const end = src.indexOf(mark, i + 2)
      if (end > i + 2) { flush(); out.push({ t: 'strong', c: parseInline(src.slice(i + 2, end)) }); i = end + 2; continue }
    }
    if ((ch === '*' || ch === '_') && src[i + 1] !== ' ' && src[i + 1] !== ch) {
      const end = src.indexOf(ch, i + 1)
      const wordInside = ch === '_' && /\w/.test(src[i - 1] ?? '')
      if (end > i + 1 && src[end - 1] !== ' ' && !wordInside) { flush(); out.push({ t: 'em', c: parseInline(src.slice(i + 1, end)) }); i = end + 1; continue }
    }
    if (ch === '[') {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest)
      if (m) {
        const href = safeHref(m[2]!)
        flush()
        if (href) out.push({ t: 'link', href, c: parseInline(m[1]!) })
        else out.push(...parseInline(m[1]!))
        i += m[0].length
        continue
      }
    }
    text += ch
    i++
  }
  flush()
  return out
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let para: string[] = []
  const flushPara = () => { if (para.length) { blocks.push({ type: 'p', c: parseInline(para.join(' ').trim()) }); para = [] } }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const trimmed = line.trim()
    const fence = /^```\s*([\w+-]*)\s*$/.exec(trimmed)
    if (fence) {
      flushPara()
      const body: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i]!.trim())) body.push(lines[i++]!)
      i++ // closing fence (or EOF)
      blocks.push({ type: 'code', lang: fence[1] ?? '', text: body.join('\n') })
      continue
    }
    if (trimmed.startsWith('$$') || trimmed.startsWith('\\[')) {
      const close = trimmed.startsWith('$$') ? '$$' : '\\]'
      flushPara()
      let body = trimmed.slice(2)
      if (body.trimEnd().endsWith(close) && body.length >= close.length) {
        blocks.push({ type: 'math', text: body.trimEnd().slice(0, -close.length).trim() })
        i++
        continue
      }
      const acc = [body]
      i++
      while (i < lines.length && !lines[i]!.trimEnd().endsWith(close)) acc.push(lines[i++]!)
      if (i < lines.length) { body = lines[i]!.trimEnd(); acc.push(body.slice(0, -close.length)); i++ }
      blocks.push({ type: 'math', text: acc.join('\n').trim() })
      continue
    }
    if (!trimmed) { flushPara(); i++; continue }
    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (h) { flushPara(); blocks.push({ type: 'h', level: h[1]!.length, c: parseInline(h[2]!) }); i++; continue }
    if (/^>\s?/.test(trimmed)) {
      flushPara()
      const acc: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i]!.trim())) acc.push(lines[i++]!.trim().replace(/^>\s?/, ''))
      blocks.push({ type: 'quote', c: parseInline(acc.join(' ')) })
      continue
    }
    const ul = /^[-*+]\s+(.*)$/.exec(trimmed)
    const ol = /^(\d{1,4})[.)]\s+(.*)$/.exec(trimmed)
    if (ul || ol) {
      flushPara()
      const ordered = !!ol
      const items: string[] = []
      while (i < lines.length) {
        const t = lines[i]!.trim()
        const m = ordered ? /^\d{1,4}[.)]\s+(.*)$/.exec(t) : /^[-*+]\s+(.*)$/.exec(t)
        if (m) { items.push(m[1]!); i++; continue }
        // continuation line of the previous item
        if (t && items.length && /^\s{2,}/.test(lines[i]!)) { items[items.length - 1] += ' ' + t; i++; continue }
        break
      }
      blocks.push(ordered ? { type: 'ol', items: items.map(parseInline), start: Number(ol![1]) } : { type: 'ul', items: items.map(parseInline) })
      continue
    }
    para.push(trimmed)
    i++
  }
  flushPara()
  return blocks
}

const SYMBOLS: Record<string, string> = {
  to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', implies: '⇒', iff: '⇔', infty: '∞', pm: '±', mp: '∓', times: '×', cdot: '·', div: '÷',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', equiv: '≡', sim: '∼', propto: '∝',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', omega: 'ω',
  Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω', Pi: 'Π', Gamma: 'Γ', Theta: 'Θ', Lambda: 'Λ', Phi: 'Φ',
  sum: '∑', prod: '∏', int: '∫', oint: '∮', partial: '∂', nabla: '∇', in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', cup: '∪', cap: '∩', forall: '∀', exists: '∃', emptyset: '∅',
  lim: 'lim', sin: 'sin', cos: 'cos', tan: 'tan', log: 'log', ln: 'ln', exp: 'exp', max: 'max', min: 'min', quad: ' ', qquad: '  ', ldots: '…', cdots: '⋯', dots: '…',
  left: '', right: '', displaystyle: '',
}
const SUP: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', n: 'ⁿ', i: 'ⁱ' }

/** Best-effort readable form of simple LaTeX (no layout engine): `\frac{a}{b}` → `(a)/(b)`, `x^2` → `x²`, `\to` → `→`. */
export function prettyMath(tex: string): string {
  let s = tex
  for (let k = 0; k < 4; k++) s = s.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, (_, a: string, b: string) => `${wrap(a)}/${wrap(b)}`)
  s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, (_, a: string) => `√${wrap(a)}`)
  s = s.replace(/\\(?:text|mathrm|mathbf|operatorname)\s*\{([^{}]*)\}/g, '$1')
  s = s.replace(/\\([A-Za-z]+)/g, (m, name: string) => SYMBOLS[name] ?? m)
  s = s.replace(/\^\{([^{}]*)\}|\^(\w)/g, (m, a: string | undefined, b: string | undefined) => {
    const v = a ?? b ?? ''
    return [...v].every((c) => SUP[c]) ? [...v].map((c) => SUP[c]).join('') : `^(${v})`
  })
  s = s.replace(/_\{([^{}]*)\}/g, '_($1)')
  s = s.replace(/\\[,;!:]/g, ' ').replace(/\\\\/g, '; ')
  return s.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim()
}
const wrap = (x: string) => (/^[\w.]+$/.test(x.trim()) ? x.trim() : `(${x.trim()})`)
