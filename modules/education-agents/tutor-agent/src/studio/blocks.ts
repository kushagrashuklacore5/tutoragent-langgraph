/**
 * Learning Studio content model (pure, unit-tested). A book is a sequence of pages; a page holds structured
 * BLOCKS (never HTML). Model output is parsed line by line (NDJSON) so blocks stream into the book as they are
 * generated; every block is validated, length-capped and source-labelled honestly:
 *   source    supported by the student's/course material retrieved for THIS request (cited, vocabulary overlap)
 *   ai        explanation written by the model (no source claim)
 *   uncertain the model said it is unsure
 * Activity answer keys and explanations are kept server-side until the student answers.
 */
import { groundingOverlap, MIN_GROUNDING } from '../materials.ts'

export const BLOCK_TYPES = ['heading', 'text', 'definition', 'example', 'formula', 'list', 'tip', 'exam', 'summary', 'figure', 'excerpt', 'activity'] as const
export type BlockType = (typeof BLOCK_TYPES)[number]
export type Label = 'source' | 'ai' | 'uncertain'
export interface Cite { ref: string; documentId: string; filename: string; page: number }
export interface Figure { query: string; caption: string; alt: string; url?: string; thumb?: string; width?: number; height?: number; pageUrl?: string; license?: string; licenseUrl?: string; credit?: string; status: 'pending' | 'found' | 'none' }
export interface ActivityKey { correct?: number[]; value?: number; tolerance?: number; accept?: string[]; modelAnswer?: string; /** numeric: expression the maths service must confirm */ expr?: string }
export interface Activity { kind: 'mcq' | 'numeric' | 'short' | 'explain'; prompt: string; options?: string[]; unit?: string; key?: ActivityKey; hint?: string; explanation?: string; refBlockId?: string }
export interface Block { id: string; type: BlockType; text: string; term?: string; items?: string[]; label: Label; cites: Cite[]; figure?: Figure; activity?: Activity }
export interface SourceRef { ref: string; documentId: string; filename: string; page: number; text: string }

const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/\s+\n/g, '\n').trim().slice(0, n) : '')
/** Readable maths for the book and for speech: common LaTeX turned into plain notation (no renderer needed). */
export function plainMath(t: string): string {
  let s = t.replace(/\$\$?|\\\(|\\\)|\\\[|\\\]/g, '').replace(/\\Delta\s*/g, 'Δ')
  const wrap = (x: string) => (/^[\wΔ.]+$/.test(x) ? x : `(${x})`)
  for (let i = 0; i < 3; i++) s = s.replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, (_m, a: string, b: string) => `${wrap(a)}/${wrap(b)}`)
  return s
    .replace(/\\sqrt\{([^{}]*)\}/g, '√($1)').replace(/\\(text|mathrm)\{([^{}]*)\}/g, '$2')
    .replace(/\^\{([^{}]*)\}/g, '^$1').replace(/_\{([^{}]*)\}/g, '_$1')
    .replace(/\\Delta/g, 'Δ').replace(/\\theta/g, 'θ').replace(/\\alpha/g, 'α').replace(/\\omega/g, 'ω').replace(/\\mu/g, 'μ').replace(/\\pi/g, 'π')
    .replace(/\\times/g, '×').replace(/\\cdot/g, '·').replace(/\\approx/g, '≈').replace(/\\leq?/g, '≤').replace(/\\geq?/g, '≥').replace(/\\neq/g, '≠').replace(/\\rightarrow|\\to\b/g, '→')
    .replace(/\\[,;!]|\\q?quad/g, ' ').replace(/\\left|\\right/g, '').replace(/[ \t]{2,}/g, ' ').trim()
}

/** Blocks are plain text: strip markdown emphasis the model sometimes adds. */
export const noMarkdown = (t: string) => t.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/(^|\s)\*(\S.*?\S|\S)\*(?=\s|$|[.,;:!?])/g, '$1$2').replace(/^#{1,6}\s+/gm, '')

/** ~5–7 lines of book text */
export const MAX_TEXT = 700

/**
 * Validate one model-proposed block. Returns null for anything unusable. `sources` = material retrieved for
 * this request; a "source" label survives only with valid citations AND enough shared vocabulary.
 */
export function toBlock(raw: unknown, id: string, sources: SourceRef[]): Block | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const type = r.type as BlockType
  if (!BLOCK_TYPES.includes(type)) return null
  let text = noMarkdown(plainMath(clip(r.text, type === 'heading' ? 120 : MAX_TEXT)))
  if (type === 'tip') text = text.replace(/^(remember|yaad rakho|याद रखें)\s*[:：-]\s*/i, '')
  const items = Array.isArray(r.items) ? r.items.map((x) => plainMath(clip(x, 240))).filter(Boolean).slice(0, 8) : undefined
  const b: Block = { id, type, text, label: 'ai', cites: [] }
  if (type === 'definition') { b.term = clip(r.term, 80); if (!b.term) return null }
  if (items?.length) b.items = items
  if (type === 'figure') {
    const query = clip(r.query, 80)
    if (!query) return null
    b.figure = { query, caption: clip(r.caption ?? r.text, 200), alt: clip(r.alt ?? r.caption ?? query, 200), status: 'pending' }
    b.text = b.figure.caption
  } else if (type === 'activity') {
    const a = toActivity(r)
    if (!a) return null
    b.activity = a
    b.text = a.prompt
  } else if (!text && !items?.length) return null

  // honest labelling
  const wanted = Array.isArray(r.cites) ? r.cites.filter((x): x is string => typeof x === 'string').slice(0, 4) : []
  const cited = wanted.map((ref) => sources.find((s) => s.ref === ref)).filter((s): s is SourceRef => !!s)
  const claim = r.label === 'source' || type === 'excerpt'
  const body = [b.text, ...(b.items ?? []), b.term ?? ''].join(' ')
  if (claim && cited.length && groundingOverlap(body, cited.map((s) => s.text)) >= MIN_GROUNDING) {
    b.label = 'source'
    b.cites = cited.map(({ text: _t, ...c }) => c)
  } else if (type === 'excerpt') {
    return null // an excerpt must come from the material, verbatim enough to ground
  } else {
    b.label = r.label === 'uncertain' ? 'uncertain' : 'ai'
  }
  return b
}

function toActivity(r: Record<string, unknown>): Activity | null {
  const kind = r.kind as Activity['kind']
  const prompt = clip(r.prompt ?? r.text, 400)
  if (!['mcq', 'numeric', 'short', 'explain'].includes(kind) || !prompt) return null
  const a: Activity = { kind, prompt, hint: clip(r.hint, 300) || undefined, explanation: clip(r.explanation, 600) || undefined }
  if (kind === 'mcq') {
    const options = Array.isArray(r.options) ? r.options.map((x) => clip(x, 160)).filter(Boolean).slice(0, 5) : []
    const correct = Array.isArray(r.correct) ? r.correct.filter((x): x is number => Number.isInteger(x) && x >= 0 && x < options.length) : []
    if (options.length < 2 || correct.length !== 1) return null
    a.options = options
    a.key = { correct, ...(clip(r.answerExpr, 120) ? { expr: clip(r.answerExpr, 120) } : {}) }
  } else if (kind === 'numeric') {
    const value = Number(r.value)
    if (!Number.isFinite(value)) return null
    const expr = clip(r.answerExpr, 120)
    if (!expr) return null // numeric keys must be verifiable
    a.key = { value, expr, tolerance: Math.max(0, Math.min(Math.abs(value) * 0.05, Number(r.tolerance) || Math.abs(value) * 0.01)) }
    a.unit = clip(r.unit, 20) || undefined
  } else if (kind === 'short') {
    const accept = Array.isArray(r.accept) ? r.accept.map((x) => clip(x, 120)).filter(Boolean).slice(0, 6) : []
    if (!accept.length) return null
    a.key = { accept }
  } else {
    a.key = { modelAnswer: clip(r.modelAnswer, 600) }
  }
  return a
}

/** What the browser may see: no answer keys, hints or explanations before the student answers. */
export function publicBlock(b: Block): Block {
  if (!b.activity) return b
  const { key: _k, hint: _h, explanation: _e, ...rest } = b.activity
  return { ...b, activity: rest }
}

/** Incremental NDJSON reader for streamed model output: returns complete JSON lines; ignores code fences. */
export class LineReader {
  private buf = ''
  push(delta: string): unknown[] {
    this.buf += delta
    const out: unknown[] = []
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim()
      this.buf = this.buf.slice(i + 1)
      const v = parseLine(line)
      if (v !== undefined) out.push(v)
    }
    return out
  }
  end(): unknown[] { const v = parseLine(this.buf.trim()); this.buf = ''; return v === undefined ? [] : [v] }
}
function parseLine(line: string): unknown {
  const l = line.replace(/^```(json)?/, '').replace(/```$/, '').replace(/,$/, '').trim()
  if (!l.startsWith('{')) return undefined
  try { return JSON.parse(l) } catch { return undefined }
}

/** Page capacity in characters of block text (a book page ≈ 3–4 short blocks). */
export const PAGE_CAPACITY = 1600
const weight = (b: Block) => (b.type === 'figure' ? 600 : b.type === 'activity' ? 450 : b.type === 'heading' ? 80 : b.text.length + (b.items ?? []).join(' ').length + 60)

/** Place blocks on pages: a section starts on a fresh page; a page never exceeds its capacity (except one oversized block). */
export function paginate(blocks: Block[], firstPage: number): { pageNo: number; blocks: Block[] }[] {
  const pages: { pageNo: number; blocks: Block[] }[] = []
  let cur: Block[] = []
  let used = 0
  for (const b of blocks) {
    const w = weight(b)
    if (cur.length && used + w > PAGE_CAPACITY) { pages.push({ pageNo: firstPage + pages.length, blocks: cur }); cur = []; used = 0 }
    cur.push(b)
    used += w
  }
  if (cur.length) pages.push({ pageNo: firstPage + pages.length, blocks: cur })
  return pages
}

/** Plain text of a page (for context, search and speech). */
export const pageText = (blocks: Block[]) => blocks.map((b) => [b.term ? `${b.term}: ` : '', b.text, ...(b.items ?? []).map((x) => `- ${x}`)].join(' ')).join('\n')

// ── notebook ──────────────────────────────────────────────────────────────
export interface NoteTopic {
  id: string; title: string
  definitions: { term: string; text: string }[]
  keyPoints: string[]; formulae: string[]; examples: string[]; memoryTricks: string[]; examPoints: string[]
  doubts: { q: string; a: string }[]; practice: string[]; summary: string
  /** student-written additions (never overwritten by the AI) */
  myNotes: string
}
export interface Notebook { title: string; topics: NoteTopic[]; summary: string }
export const emptyTopic = (id: string, title: string): NoteTopic => ({ id, title, definitions: [], keyPoints: [], formulae: [], examples: [], memoryTricks: [], examPoints: [], doubts: [], practice: [], summary: '', myNotes: '' })

const short = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)
const addU = (list: string[], v: string) => { if (v && !list.some((x) => x.toLowerCase() === v.toLowerCase())) list.push(v) }

/**
 * Concise notes derived deterministically from a section's blocks (no extra model call): definitions, formulae,
 * examples, memory tips, exam points, practice prompts and the summary. Plain explanation text is NOT copied;
 * only its first sentence becomes a key point. Student-written notes are preserved.
 */
export function mergeSectionNotes(nb: Notebook, sectionId: string, title: string, blocks: Block[]): Notebook {
  const topics = nb.topics.map((t) => ({ ...t }))
  let t = topics.find((x) => x.id === sectionId)
  if (!t) { t = emptyTopic(sectionId, title); topics.push(t) }
  for (const b of blocks) {
    if (b.type === 'definition' && b.term && !t.definitions.some((d) => d.term.toLowerCase() === b.term!.toLowerCase())) t.definitions.push({ term: b.term, text: short(b.text) })
    else if (b.type === 'formula') addU(t.formulae, short(b.text, 160))
    else if (b.type === 'example') addU(t.examples, short(b.text))
    else if (b.type === 'tip') addU(t.memoryTricks, short(b.text))
    else if (b.type === 'exam') addU(t.examPoints, short(b.text))
    else if (b.type === 'summary') t.summary = short(b.text, 500)
    else if (b.type === 'activity' && b.activity) addU(t.practice, short(b.activity.prompt))
    else if (b.type === 'text' || b.type === 'list') {
      const first = (b.items?.[0] ?? b.text.split(/(?<=[.!?।])\s/)[0] ?? '').trim()
      if (first.length > 20) addU(t.keyPoints, short(first, 180))
    }
  }
  t.keyPoints = t.keyPoints.slice(-12)
  return { ...nb, topics }
}

export function addDoubt(nb: Notebook, sectionId: string | null, title: string, q: string, a: string): Notebook {
  const topics = nb.topics.map((t) => ({ ...t, doubts: [...t.doubts] }))
  const id = sectionId ?? 'doubts'
  let t = topics.find((x) => x.id === id)
  if (!t) { t = emptyTopic(id, sectionId ? title : 'My questions'); topics.push(t) }
  if (!t.doubts.some((d) => d.q.toLowerCase() === q.toLowerCase())) t.doubts.push({ q: short(q, 300), a: short(a, 400) })
  t.doubts = t.doubts.slice(-15)
  return { ...nb, topics }
}

/** Validate a student-edited notebook (shape, sizes). */
export function cleanNotebook(v: unknown, fallbackTitle: string): Notebook | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (!Array.isArray(o.topics) || o.topics.length > 60) return null
  const strs = (x: unknown, n = 40, len = 600) => (Array.isArray(x) ? x.map((s) => clip(s, len)).filter(Boolean).slice(0, n) : [])
  const topics: NoteTopic[] = []
  for (const raw of o.topics) {
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>
    topics.push({
      id: clip(r.id, 60) || `t${topics.length + 1}`, title: clip(r.title, 200) || 'Untitled',
      definitions: Array.isArray(r.definitions) ? r.definitions.slice(0, 40).map((d) => ({ term: clip((d as { term?: unknown }).term, 120), text: clip((d as { text?: unknown }).text, 600) })).filter((d) => d.term) : [],
      keyPoints: strs(r.keyPoints), formulae: strs(r.formulae), examples: strs(r.examples), memoryTricks: strs(r.memoryTricks), examPoints: strs(r.examPoints), practice: strs(r.practice),
      doubts: Array.isArray(r.doubts) ? r.doubts.slice(0, 40).map((d) => ({ q: clip((d as { q?: unknown }).q, 300), a: clip((d as { a?: unknown }).a, 600) })).filter((d) => d.q) : [],
      summary: clip(r.summary, 2000), myNotes: clip(r.myNotes, 8000),
    })
  }
  return { title: clip(o.title, 200) || fallbackTitle, topics, summary: clip(o.summary, 4000) }
}

/** Markdown export of the notebook. */
export function notebookMarkdown(nb: Notebook): string {
  const out = [`# ${nb.title}`, '']
  const list = (h: string, xs: string[]) => { if (xs.length) out.push(`**${h}**`, ...xs.map((x) => `- ${x}`), '') }
  for (const t of nb.topics) {
    out.push(`## ${t.title}`, '')
    if (t.definitions.length) out.push('**Definitions**', ...t.definitions.map((d) => `- **${d.term}**: ${d.text}`), '')
    list('Key points', t.keyPoints); list('Formulae', t.formulae); list('Examples', t.examples)
    list('Memory tricks', t.memoryTricks); list('Exam points', t.examPoints); list('Practice', t.practice)
    if (t.doubts.length) out.push('**My doubts**', ...t.doubts.map((d) => `- Q: ${d.q}\n  A: ${d.a}`), '')
    if (t.myNotes) out.push('**My notes**', t.myNotes, '')
    if (t.summary) out.push(`> ${t.summary}`, '')
  }
  if (nb.summary) out.push('## Chapter summary', nb.summary, '')
  return out.join('\n')
}
