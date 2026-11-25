/** Pure demo logic (no browser or network): unit-tested in test/logic.test.ts. */
export const DEMO = { tenant: 'demo-univ', email: 'demo.visitor@demo.test', sessionMinutes: 60 } as const

export type View = 'home' | 'document' | 'notebook' | 'practice' | 'progress'
export type Destination =
  | { view: 'notebook'; bookId?: string; courseId?: string; conceptId?: string; teach?: boolean }
  | { view: 'practice'; courseId: string; conceptId?: string }
  | { view: 'progress'; courseId?: string }
  | { view: 'document' }

/** Where a link produced by the Tutor opens inside the demo. Null = that workspace is not part of the demo. */
export function destinationFor(href: string): Destination | null {
  const url = new URL(href, 'http://demo.local')
  const p = url.pathname
  const conceptId = url.searchParams.get('conceptId') ?? undefined
  const book = /^\/studio\/([0-9a-f-]{36})$/i.exec(p)
  // ?teach=1: the journey was just prepared, so Vidya starts teaching as soon as the book opens
  if (book) return url.searchParams.get('teach') === '1' ? { view: 'notebook', bookId: book[1]!, teach: true } : { view: 'notebook', bookId: book[1]! }
  if (p === '/studio') return { view: 'notebook' }
  const practice = /^\/practice\/([0-9a-f-]{36})$/i.exec(p)
  if (practice) return { view: 'practice', courseId: practice[1]!, conceptId }
  if (p === '/revise' || p === '/growth' || p === '/progress' || p === '/today') return { view: 'progress' }
  const c = /^\/app\/education\/tutor\/courses\/([0-9a-f-]{36})(?:\/([a-z]+))?/i.exec(p)
  if (!c) return null
  const courseId = c[1]!
  switch (c[2]) {
    case 'practice': return { view: 'practice', courseId, conceptId }
    case 'materials': return { view: 'document' }
    case 'tutor': return { view: 'notebook', courseId, conceptId }
    case undefined: case 'revision': case 'plan': return { view: 'progress', courseId }
    default: return null
  }
}

export type MathPart = { kind: 'text' | 'sup' | 'sub'; value: string }
/** Plain-notation maths from the Tutor (x^2, x_1, sqrt(), *) as display parts. Never evaluates anything. */
export function mathParts(input: string): MathPart[] {
  const text = input.replace(/sqrt\(/g, '√(').replace(/(\S) \* (\S)/g, '$1 × $2').replace(/->/g, '→')
  const re = /(?<=[\p{L}\p{N})])(\^|_)(\{[^{}]{1,12}\}|-?\d{1,3}|[a-zA-Z](?![a-zA-Z]))/gu
  const out: MathPart[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push({ kind: 'text', value: text.slice(last, m.index) })
    out.push({ kind: m[1] === '^' ? 'sup' : 'sub', value: m[2]!.replace(/[{}]/g, '') })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ kind: 'text', value: text.slice(last) })
  return out
}

export interface StoredSession { token: string; expiresAt: number }
export const sessionUsable = (s: StoredSession | null, now: number): s is StoredSession => !!s && !!s.token && s.expiresAt > now + 5_000
export const sessionExpiry = (serverExpiresAt: string | undefined, now: number) =>
  Math.min(serverExpiresAt ? Date.parse(serverExpiresAt) || Infinity : Infinity, now + DEMO.sessionMinutes * 60_000)
/** Destructive demo actions run only for the dedicated demo identity. */
export const isDemoIdentity = (email: unknown) => typeof email === 'string' && email.toLowerCase() === DEMO.email

export type StageState = 'done' | 'current' | 'upcoming'
export interface Stage { id: 'goal' | 'material' | 'plan' | 'lesson' | 'practice' | 'revision'; label: string; detail: string; state: StageState }
export interface JourneyFacts {
  objective?: string; topic?: string; material?: string; courseTitle?: string; sourceTitle?: string
  phase: string; hasPlan: boolean; hasBook: boolean; evidence: number; dueCards: number
}
/** The learner's real position, derived only from backend state. */
export function journey(f: JourneyFacts): Stage[] {
  const done = [!!f.objective, !!f.material, f.hasPlan, f.hasBook, f.evidence > 0, f.evidence > 0 && f.dueCards === 0 && f.hasPlan]
  const first = done.findIndex((x) => !x)
  const state = (i: number): StageState => (done[i] ? 'done' : i === first ? 'current' : 'upcoming')
  const material = f.sourceTitle ?? (f.material === 'curriculum' ? 'Course syllabus' : f.material === 'ai' ? 'Tutor-prepared notes' : f.material === 'own' ? 'Your document' : 'Not chosen yet')
  return [
    { id: 'goal', label: 'Goal', detail: f.topic && f.topic !== 'the complete material' ? f.topic : f.courseTitle ?? 'Tell the Tutor what you want', state: state(0) },
    { id: 'material', label: 'Material', detail: material, state: state(1) },
    { id: 'plan', label: 'Roadmap', detail: f.hasPlan ? 'Approved by you' : f.phase === 'awaiting_approval' ? 'Waiting for your approval' : 'Built after goal and material', state: state(2) },
    { id: 'lesson', label: 'Lesson', detail: f.hasBook ? 'Notebook ready' : 'Starts after approval', state: state(3) },
    { id: 'practice', label: 'Practice', detail: f.evidence ? `${f.evidence} recorded answer${f.evidence === 1 ? '' : 's'}` : 'Only when you ask', state: state(4) },
    { id: 'revision', label: 'Revision', detail: f.dueCards ? `${f.dueCards} card${f.dueCards === 1 ? '' : 's'} due` : 'Nothing due', state: state(5) },
  ]
}

export { CUSTOM, intakePayload, visibleQuestions } from '../../../web/src/lib/intake.ts'
