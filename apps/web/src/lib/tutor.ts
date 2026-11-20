/** Tutor module types (mirroring modules/education-agents/tutor-agent routes) and pure view helpers. */

export type Role = 'student' | 'educator' | 'tenant_admin'
export interface Me { userId: string; tenantId: string; email: string; roles: string[]; isPlatformAdmin: boolean }
export interface PlatformModules {
  modules: string[]
  ui: { moduleId: string; path: string; title: string; permission: string }[]
  nav: { moduleId: string; label: string; path: string; permission: string }[]
}

export type IntegrityMode = 'open' | 'guided' | 'hint_only'
export interface Course { id: string; code: string; title: string; term: string | null; integrity_mode: IntegrityMode; role: 'student' | 'educator' }
export interface Concept { id: string; name: string; description: string; est_minutes: number; exam_weight: string | number; status: 'draft' | 'approved' | string }
export interface ConceptGraph { concepts: Concept[]; prerequisites: { prerequisite: string; concept: string }[] }

export type MasteryState = 'insufficient_evidence' | 'learning' | 'mastered' | 'stale'
export interface MasteryEstimate {
  pMastery: number; low: number; high: number; evidenceCount: number; distinctDays: number; unassistedCorrect: number
  state: MasteryState; explanation: string; modelVersion: string
}
export interface ConceptMastery extends MasteryEstimate { conceptId: string; name: string }

export interface PracticeItem { id: string; type: 'mcq' | 'numeric' | 'expression'; stem: string; options?: string[]; multiple?: boolean }
export interface PracticeNext { conceptId: string; item: PracticeItem | null; message?: string; source?: { kind?: 'lesson' | 'material'; filename: string; page: number | null; bookId?: string | null } | null }
export type Confidence = 'sure' | 'unsure' | 'guess'
export interface AttemptResult { attemptId?: string; correct: boolean; outcome: number; explanation: string; confidentAndWrong: boolean; mastery: MasteryEstimate }

export interface Card { id: string; course_id: string; concept_id: string | null; front: string; back: string; due_at: string }

export interface PlanTask { date: string; conceptId: string; conceptName: string; kind: 'learn' | 'practice' | 'review'; minutes: number }
export interface Plan { version: number; tasks: PlanTask[]; dropped: { conceptId: string; reason: string }[]; rationale: string[] }
export interface Goal { examAt: string | null; dailyMinutes: number }

export type SourceType = 'course' | 'general' | 'ai_example' | 'uncertain'
export interface Citation { chunkId: string; documentId: string; filename: string; pageStart: number; pageEnd: number; /** from the student's own uploaded notes (unverified) */ notes?: boolean }
export interface Segment { text: string; source: SourceType; citations: Citation[]; /** solver result for calculations in this segment */ math?: 'verified' | 'failed' }
export type Move = 'ask' | 'hint' | 'explain' | 'worked_solution' | 'rescue_probe' | 'check'
export interface TurnResponse {
  move: Move; hintLevel: number; policyNote: string | null; segments: Segment[]; relabelled: number
  checkQuestion: string | null; assessment: 'correct' | 'partial' | 'incorrect' | 'not_an_attempt'
  /** course material could not be searched for this reply (index unavailable) */
  retrievalDegraded?: boolean
}
export interface AskResponse { answerable: boolean; segments: Segment[] }

export type MaterialStatus = 'processing' | 'ready' | 'failed'
export interface Material { documentId: string; filename: string; status: MaterialStatus; pages: number | null; version: number; trust: 'verified_course' | 'student_upload'; createdAt: string; error?: string | null; mine?: boolean }
export interface MaterialPage { documentId: string; filename: string; page: number; text: string }

export type Language = 'en' | 'hi' | 'hinglish'
export const LANGUAGES: { value: Language; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'hi', label: 'हिन्दी (Hindi)' },
  { value: 'hinglish', label: 'Hinglish' },
]

// ── source labels: icon + text, never colour alone ──
export const SOURCE_META: Record<SourceType, { label: string; short: string; description: string }> = {
  course: { label: 'Course material', short: 'Course', description: 'Taken from your course material; see the page citation.' },
  general: { label: 'General knowledge', short: 'General', description: 'General subject knowledge, not from your course material.' },
  ai_example: { label: 'AI example', short: 'AI example', description: 'An example or numbers made up by the AI to illustrate the idea.' },
  uncertain: { label: 'Not certain', short: 'Not certain', description: 'The tutor is not sure about this part, or could not find it in your material. Check it against your course.' },
}
export function sourceOf(v: unknown): SourceType {
  return v === 'course' || v === 'general' || v === 'ai_example' || v === 'uncertain' ? v : 'uncertain'
}

/** Accept citation objects (current contract) and drop anything else (e.g. bare chunk-id strings). */
export function normalizeCitation(c: unknown): Citation | null {
  if (!c || typeof c !== 'object') return null
  const o = c as Record<string, unknown>
  if (typeof o.documentId !== 'string' || typeof o.filename !== 'string') return null
  const start = Number(o.pageStart)
  if (!Number.isFinite(start) || start < 1) return null
  const end = Number(o.pageEnd)
  return { chunkId: String(o.chunkId ?? ''), documentId: o.documentId, filename: o.filename, pageStart: start, pageEnd: Number.isFinite(end) && end >= start ? end : start, ...(o.trust === 'student_upload' ? { notes: true } : {}) }
}

/** Normalise a segment list from any tutor/ask response. A "course" segment without a usable citation is shown as uncertain. */
export function normalizeSegments(raw: unknown): Segment[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((s) => {
    if (!s || typeof s !== 'object') return []
    const o = s as Record<string, unknown>
    if (typeof o.text !== 'string' || !o.text.trim()) return []
    const citations = Array.isArray(o.citations) ? o.citations.map(normalizeCitation).filter((c): c is Citation => !!c) : []
    let source = sourceOf(o.source)
    if (source === 'course' && !citations.length) source = 'uncertain'
    const math = o.math === 'verified' || o.math === 'failed' ? { math: o.math as 'verified' | 'failed' } : {}
    return [{ text: o.text, source, citations, ...math }]
  })
}

/** `[notes.pdf · p. 12]` or `[notes.pdf · pp. 12–13]` */
export function citationLabel(c: Citation): string {
  const name = (c.notes ? 'Your notes: ' : '') + (c.filename.length > 28 ? c.filename.slice(0, 25) + '…' : c.filename)
  return c.pageEnd > c.pageStart ? `${name} · pp. ${c.pageStart}–${c.pageEnd}` : `${name} · p. ${c.pageStart}`
}

// ── hint ladder ──
export const HINT_STEPS = ['Nudge', 'Concept', 'Partial step', 'Worked step'] as const
export const MOVE_LABEL: Record<Move, string> = {
  ask: 'Asking what you know', hint: 'Hint', explain: 'Explaining', worked_solution: 'Full worked solution', rescue_probe: 'Checking a prerequisite', check: 'Checking understanding',
}

// ── mastery ──
export interface MasteryView { label: string; level: 0 | 1 | 2 | 3 | 4; percent: number | null; range: string | null }
export function masteryView(m: Pick<MasteryEstimate, 'state' | 'pMastery' | 'low' | 'high'>): MasteryView {
  if (m.state === 'insufficient_evidence') return { label: 'Not enough evidence', level: 0, percent: null, range: null }
  const percent = Math.round(m.pMastery * 100)
  const range = `${Math.round(m.low * 100)}–${Math.round(m.high * 100)}%`
  if (m.state === 'mastered') return { label: 'Mastered', level: 4, percent, range }
  if (m.state === 'stale') return { label: 'Needs a refresh', level: 1, percent, range }
  return { label: m.pMastery >= 0.7 ? 'Getting there' : m.pMastery >= 0.45 ? 'Learning' : 'Early', level: m.pMastery >= 0.7 ? 3 : m.pMastery >= 0.45 ? 2 : 1, percent, range }
}

// ── dates & plan ──
/** Local YYYY-MM-DD (plans are stored with UTC dates; for India-time students these coincide except near midnight). */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
export function daysUntil(dateYmd: string, now = new Date()): number {
  const [y, m, d] = dateYmd.slice(0, 10).split('-').map(Number)
  const target = Date.UTC(y!, (m ?? 1) - 1, d ?? 1)
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((target - today) / 86_400_000)
}
export function countdownText(days: number): string {
  if (days < 0) return 'Exam date has passed'
  if (days === 0) return 'Exam is today'
  if (days === 1) return 'Exam is tomorrow'
  return `${days} days to the exam`
}

/** Up to `max` tasks for the given day (revision first), from the latest plan. */
export function todaysTasks(plan: Pick<Plan, 'tasks'> | null, today: string, max = 3): PlanTask[] {
  if (!plan) return []
  return plan.tasks.filter((t) => t.date === today).slice(0, max)
}

export interface PlanDay { date: string; tasks: PlanTask[]; minutes: number }
export function groupByDay(tasks: PlanTask[]): PlanDay[] {
  const map = new Map<string, PlanTask[]>()
  for (const t of tasks) map.set(t.date, [...(map.get(t.date) ?? []), t])
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, ts]) => ({ date, tasks: ts, minutes: ts.reduce((s, t) => s + t.minutes, 0) }))
}
/** Seven consecutive days starting at `start` (YYYY-MM-DD), each with its tasks (possibly none). */
export function weekOf(tasks: PlanTask[], start: string): PlanDay[] {
  const byDay = new Map(groupByDay(tasks).map((d) => [d.date, d]))
  const [y, m, d] = start.split('-').map(Number)
  return Array.from({ length: 7 }, (_, i) => {
    const date = new Date(Date.UTC(y!, m! - 1, d! + i)).toISOString().slice(0, 10)
    return byDay.get(date) ?? { date, tasks: [], minutes: 0 }
  })
}
/** Minutes planned on days before today that the student has not marked done. */
export function missedMinutes(tasks: PlanTask[], today: string, done: Set<string>): number {
  return tasks.filter((t) => t.date < today && !done.has(taskKey(t))).reduce((s, t) => s + t.minutes, 0)
}
export const taskKey = (t: PlanTask) => `${t.date}|${t.conceptId}|${t.kind}`

export const TASK_KIND_LABEL: Record<PlanTask['kind'], string> = { learn: 'Learn', practice: 'Practise', review: 'Revise' }

export function formatDay(dateYmd: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }): string {
  const [y, m, d] = dateYmd.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString('en-IN', { ...opts, timeZone: 'UTC' })
}

// ── uploads ──
export const UPLOAD_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
}
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
/** Validate a file for upload; returns the MIME type to send, or an error message. */
export function checkUpload(name: string, size: number, type: string): { mime: string } | { error: string } {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  const mime = UPLOAD_TYPES[ext]
  if (!mime) return { error: `${name}: only PDF, DOCX, PPTX or TXT files can be added.` }
  if (size > MAX_UPLOAD_BYTES) return { error: `${name} is larger than 50 MB.` }
  if (size === 0) return { error: `${name} is empty.` }
  return { mime: type && Object.values(UPLOAD_TYPES).includes(type) ? type : mime }
}
export function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
}
