/**
 * Durable learner profile and conversational onboarding (pure, unit-tested).
 * The model only PROPOSES profile values extracted from what the student said; `mergeProfile` validates and
 * clamps every value, and `nextSlot` deterministically decides what (if anything) is still worth asking —
 * one question at a time, never re-asking a slot that is known, skipped or already asked.
 */
export const OBJECTIVES = ['conceptual_mastery', 'exam_prep', 'practical_skills', 'interview_prep', 'project', 'general', 'revision', 'class_prep', 'quick_explanation', 'homework', 'curiosity'] as const
export const LEVELS = ['school', 'undergraduate', 'postgraduate', 'professional'] as const
export const STYLES = ['examples_first', 'theory_first', 'practice_heavy', 'visual', 'mixed'] as const
export const LANGS = ['en', 'hi', 'hinglish'] as const
export type Objective = (typeof OBJECTIVES)[number]

export interface Doubt { id: string; text: string; conceptName?: string; status: 'open' | 'resolved'; at: string }

export interface LearnerProfile {
  courseId?: string
  objective?: Objective
  goalText?: string
  /** YYYY-MM-DD, or 'none' when there is no fixed date */
  examDate?: string
  dailyMinutes?: number
  studyDaysPerWeek?: number
  level?: (typeof LEVELS)[number]
  grade?: string
  curriculum?: string
  learningStyle?: (typeof STYLES)[number]
  /** self-rated 1 (new to it) .. 5 (very confident) */
  confidence?: number
  priorKnowledge?: string
  hasMaterials?: boolean
  /** chapter, topic or skill the journey is about */
  topic?: string
  /** how deep: a preview (e.g. before class), standard, or deep mastery */
  depth?: 'overview' | 'standard' | 'deep'
  /** which material to teach from: the student's upload, the course curriculum (NCERT/syllabus), or AI-prepared content */
  material?: 'own' | 'curriculum' | 'ai'
  /** the course the material choice was made for: a different course needs its own answer */
  materialFor?: string
  /** prefers hands-on practice over theory */
  handsOn?: boolean
  language?: (typeof LANGS)[number]
  /** slots the student chose not to answer */
  skipped?: string[]
  doubts?: Doubt[]
  explained?: string[]
}

export type Slot = 'courseId' | 'objective' | 'topic' | 'depth' | 'examDate' | 'dailyMinutes' | 'material' | 'confidence' | 'learningStyle' | 'hasMaterials' | 'level'
/** Every slot that can be required for some goal (see requiredSlots). */
export const REQUIRED: Slot[] = ['courseId', 'objective', 'topic', 'depth', 'examDate', 'dailyMinutes']
/** Useful but optional: at most MAX_OPTIONAL_QUESTIONS of these are asked before the first plan. */
export const OPTIONAL: Slot[] = ['confidence', 'level', 'learningStyle']
export const MAX_OPTIONAL_QUESTIONS = 2

const DATED: Objective[] = ['exam_prep', 'interview_prep', 'revision']
/** goals answered or acted on directly in the conversation: no study plan, no follow-up questions */
export const UNPLANNED: Objective[] = ['quick_explanation', 'homework', 'curiosity']
export const plannable = (p: LearnerProfile) => !!p.objective && !UNPLANNED.includes(p.objective)
const clip = (s: unknown, n: number) => (typeof s === 'string' && s.trim() ? s.trim().replace(/\s+/g, ' ').slice(0, n) : undefined)
const ymd = (d: Date) => d.toISOString().slice(0, 10)

export function validDate(v: unknown, now: Date): string | undefined {
  if (v === 'none') return 'none'
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined
  const d = new Date(`${v}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || ymd(d) !== v) return undefined
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  // tomorrow .. two years ahead
  if (d.getTime() <= today.getTime() || d.getTime() > today.getTime() + 731 * 86_400_000) return undefined
  return v
}

/** Merge model-proposed values into the profile: unknown keys and invalid values are dropped, numbers clamped. */
export function mergeProfile(cur: LearnerProfile, proposed: Record<string, unknown> | undefined, now: Date, allowedCourseIds: string[]): { profile: LearnerProfile; changed: (keyof LearnerProfile)[] } {
  const p: LearnerProfile = { ...cur }
  const changed: (keyof LearnerProfile)[] = []
  const set = <K extends keyof LearnerProfile>(k: K, v: LearnerProfile[K] | undefined) => {
    if (v === undefined || JSON.stringify(p[k]) === JSON.stringify(v)) return
    p[k] = v
    changed.push(k)
    if (p.skipped?.includes(k)) p.skipped = p.skipped.filter((s) => s !== k)
  }
  const x = proposed ?? {}
  if (typeof x.courseId === 'string' && allowedCourseIds.includes(x.courseId)) set('courseId', x.courseId)
  if (OBJECTIVES.includes(x.objective as Objective)) set('objective', x.objective as Objective)
  set('goalText', clip(x.goalText, 300))
  set('examDate', validDate(x.examDate, now))
  if (typeof x.dailyMinutes === 'number' && Number.isFinite(x.dailyMinutes)) set('dailyMinutes', Math.round(Math.min(600, Math.max(10, x.dailyMinutes))))
  if (typeof x.studyDaysPerWeek === 'number' && Number.isFinite(x.studyDaysPerWeek)) set('studyDaysPerWeek', Math.round(Math.min(7, Math.max(1, x.studyDaysPerWeek))))
  if (LEVELS.includes(x.level as never)) set('level', x.level as LearnerProfile['level'])
  set('grade', clip(x.grade, 60))
  set('curriculum', clip(x.curriculum, 80))
  if (STYLES.includes(x.learningStyle as never)) set('learningStyle', x.learningStyle as LearnerProfile['learningStyle'])
  if (typeof x.confidence === 'number' && Number.isFinite(x.confidence)) set('confidence', Math.round(Math.min(5, Math.max(1, x.confidence))))
  set('priorKnowledge', clip(x.priorKnowledge, 300))
  if (typeof x.hasMaterials === 'boolean') set('hasMaterials', x.hasMaterials)
  set('topic', clip(x.topic, 160))
  if (['overview', 'standard', 'deep'].includes(x.depth as string)) set('depth', x.depth as LearnerProfile['depth'])
  if (x.material === 'own' || x.material === 'curriculum' || x.material === 'ai') { set('material', x.material); if (p.courseId) set('materialFor', p.courseId) }
  if (typeof x.handsOn === 'boolean') set('handsOn', x.handsOn)
  if (LANGS.includes(x.language as never)) set('language', x.language as LearnerProfile['language'])
  if (Array.isArray(x.skip)) {
    const skips = x.skip.filter((s): s is Slot => [...REQUIRED, ...OPTIONAL].includes(s as Slot) && s !== 'courseId')
    if (skips.length) { p.skipped = [...new Set([...(p.skipped ?? []), ...skips])]; changed.push('skipped') }
  }
  return { profile: p, changed }
}

const known = (p: LearnerProfile, s: Slot): boolean => s === 'material'
  // the material source is never skippable and is answered per course
  ? p.material !== undefined && p.materialFor === p.courseId
  : p[s] !== undefined || (p.skipped ?? []).includes(s)
export const needsDate = (p: LearnerProfile) => !!p.objective && DATED.includes(p.objective)

/** Required slots still missing (examDate only matters for date-bound objectives). */
/** Only the questions that improve THIS goal's plan. */
export function requiredSlots(p: LearnerProfile): Slot[] {
  if (p.objective && !plannable(p)) return ['courseId']
  // before teaching: what, how deep / by when, and explicitly WHICH material to teach from
  if (p.objective === 'class_prep') return ['courseId', 'objective', 'topic', 'depth', 'material']
  return ['courseId', 'objective', ...(p.objective && p.objective !== 'general' ? ['topic' as Slot] : []), 'examDate', 'dailyMinutes', 'material']
}

export function missingRequired(p: LearnerProfile): Slot[] {
  if (p.objective && !plannable(p)) return p.courseId ? [] : ['courseId']
  return requiredSlots(p).filter((s) => {
    if (s === 'examDate') return needsDate(p) && !known(p, s)
    if (s === 'courseId') return !p.courseId
    return !known(p, s)
  })
}

/**
 * What to ask next: the first missing required slot, else up to MAX_OPTIONAL_QUESTIONS optional ones that were
 * never asked, else null (ready to plan). `asked` = slots already asked in this conversation.
 */
export function nextSlot(p: LearnerProfile, asked: string[]): Slot | null {
  const req = missingRequired(p)
  if (req.length) return req[0]!
  // optional slots count once asked OR already answered (volunteered information uses up the follow-up budget)
  const usedOptional = OPTIONAL.filter((s) => asked.includes(s) || known(p, s)).length
  if (usedOptional >= MAX_OPTIONAL_QUESTIONS) return null
  return OPTIONAL.find((s) => !known(p, s) && !asked.includes(s)) ?? null
}

/** Slots that may still be asked, in order (the model asks the first one the student's message does not answer). */
export function askOrder(p: LearnerProfile, asked: string[]): Slot[] {
  const optionalLeft = Math.max(0, MAX_OPTIONAL_QUESTIONS - OPTIONAL.filter((s) => asked.includes(s) || known(p, s)).length)
  return [...missingRequired(p), ...OPTIONAL.filter((s) => !known(p, s) && !asked.includes(s)).slice(0, optionalLeft)]
}

export const readyToPlan = (p: LearnerProfile, asked: string[]) => missingRequired(p).length === 0 && nextSlot(p, asked) === null

/**
 * Deterministic fallback for a short direct answer to the slot just asked (works even if the model misses it):
 * "45", "1 hour", "1.5 hrs" → minutes; "2026-12-15" / "15 Dec" / "Dec 15" → date; "skip"/"pata nahi" → skipped.
 */
export function parseSlotAnswer(slot: Slot, text: string, now: Date): Record<string, unknown> {
  const t = text.trim().toLowerCase()
  if (/^(skip|later|not sure|pata nahi|nahi pata|don'?t know|no idea)\b/.test(t)) return { skip: [slot] }
  if (slot === 'dailyMinutes') {
    const h = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|ghanta|ghante)\b/.exec(t)
    if (h) return { dailyMinutes: Number(h[1]) * 60 }
    const m = /^(\d{1,3})\s*(m|min|mins|minute|minutes)?\b/.exec(t)
    if (m) return { dailyMinutes: Number(m[1]) }
  }
  if (slot === 'examDate') {
    if (/^(no|none|nahi|no exam|koi nahi)\b/.test(t)) return { examDate: 'none' }
    const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(t)
    if (iso) return { examDate: iso[1] }
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
    const dm = /\b(\d{1,2})\s*([a-z]{3})[a-z]*\b/.exec(t) ?? null
    const md = /\b([a-z]{3})[a-z]*\s*(\d{1,2})\b/.exec(t) ?? null
    const pair = dm && months.includes(dm[2]!) ? { d: Number(dm[1]), m: months.indexOf(dm[2]!) } : md && months.includes(md[1]!) ? { d: Number(md[2]), m: months.indexOf(md[1]!) } : null
    if (pair) {
      let y = now.getUTCFullYear()
      const cand = (yy: number) => new Date(Date.UTC(yy, pair.m, pair.d))
      if (cand(y).getTime() <= now.getTime()) y++
      return { examDate: ymd(cand(y)) }
    }
  }
  if (slot === 'confidence') {
    const n = /^([1-5])\b/.exec(t)
    if (n) return { confidence: Number(n[1]) }
  }
  if (slot === 'material') {
    if (/(upload|my notes|my own|have (some |my )?notes|apne notes|mere notes|meri notes|mere paas|apna material|pdf|docx|photo|own notes|^own|^1\b)/.test(t)) return { material: 'own' }
    if (/(ncert|curriculum|syllabus|textbook|text book|course material|board|^2\b)/.test(t)) return { material: 'curriculum' }
    if (/(\bai\b|generate|prepare|curat|aap|tum|you|banao|bana do|koi bhi|^3\b)/.test(t)) return { material: 'ai' }
  }
  if (slot === 'depth') {
    if (/(overview|quick|short|basic|preview|jaldi|thoda)/.test(t)) return { depth: 'overview' }
    if (/(deep|detail|poora|pura|achhe se|thorough)/.test(t)) return { depth: 'deep' }
    if (/(standard|normal|medium|theek)/.test(t)) return { depth: 'standard' }
  }
  if (slot === 'hasMaterials') {
    if (/^(yes|haan|han|ha|yeah|yep)\b/.test(t)) return { hasMaterials: true }
    if (/^(no|nahi|nope|nah)\b/.test(t)) return { hasMaterials: false }
  }
  return {}
}

/** Plan-relevant fields: a change to any of these after a plan exists means the plan should be re-proposed. */
export const PLAN_FIELDS: (keyof LearnerProfile)[] = ['courseId', 'objective', 'topic', 'depth', 'examDate', 'dailyMinutes', 'studyDaysPerWeek']

/** Short, non-sensitive summary of what is known (for the model's context). */
export function profileSummary(p: LearnerProfile): Record<string, unknown> {
  const { doubts, explained, ...rest } = p
  return { ...rest, openDoubts: (doubts ?? []).filter((d) => d.status === 'open').map((d) => ({ id: d.id, text: d.text, concept: d.conceptName })), explainedRecently: (explained ?? []).slice(-8) }
}

/** Apply doubts proposed by the model: max 3 new per turn, max 20 stored, resolved ids must exist. */
export function applyDoubts(p: LearnerProfile, open: unknown, resolved: unknown, now: Date, topic?: string, newId: () => string = () => Math.random().toString(36).slice(2, 10)): LearnerProfile {
  let doubts = [...(p.doubts ?? [])]
  if (Array.isArray(resolved)) for (const id of resolved) doubts = doubts.map((d) => (d.id === id ? { ...d, status: 'resolved' as const } : d))
  if (Array.isArray(open)) {
    for (const t of open.slice(0, 3)) {
      const text = clip(t, 200)
      if (text && !doubts.some((d) => d.status === 'open' && d.text.toLowerCase() === text.toLowerCase())) doubts.push({ id: newId(), text, conceptName: topic, status: 'open', at: now.toISOString() })
    }
  }
  // keep all open doubts (bounded) and the most recent resolved ones
  const openD = doubts.filter((d) => d.status === 'open').slice(-12)
  const res = doubts.filter((d) => d.status === 'resolved').slice(-8)
  return { ...p, doubts: [...res, ...openD] }
}

/** A daily study time stated anywhere in a message ("I can only give 45 minutes a day", "1.5 ghante roz"). */
export function statedDailyMinutes(text: string): number | null {
  const t = text.toLowerCase()
  if (!/(a day|per day|daily|every day|each day|roz|rozana|din mein|din me|\/day)/.test(t)) return null
  const h = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|ghanta|ghante)\b/.exec(t)
  const m = /(\d{1,3})\s*(m|min|mins|minute|minutes)\b/.exec(t)
  const v = (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0)
  return v >= 5 && v <= 720 ? Math.round(v) : null
}

/** Subjects/skills a student may name; each with the words that identify a course of that subject. */
const SUBJECTS: { name: string; re: RegExp }[] = [
  { name: 'Physics', re: /\b(physics|bhautiki|भौतिकी)\b/i },
  { name: 'Chemistry', re: /\b(chemistry|rasayan|रसायन)\b/i },
  { name: 'Mathematics', re: /\b(maths?|mathematics|ganit|गणित)\b/i },
  { name: 'Biology', re: /\b(biology|jeev vigyan|जीव विज्ञान)\b/i },
  { name: 'Science', re: /\bscience\b/i },
  { name: 'Geography', re: /\b(geography|bhugol|भूगोल)\b/i },
  { name: 'History', re: /\b(history|itihas|इतिहास)\b/i },
  { name: 'Civics', re: /\b(civics|political science|polity)\b/i },
  { name: 'Economics', re: /\b(economics|arthshastra)\b/i },
  { name: 'Accountancy', re: /\b(accountancy|accounts)\b/i },
  { name: 'Business Studies', re: /\bbusiness studies\b/i },
  { name: 'English', re: /\benglish (grammar|literature|language|class)\b/i },
  { name: 'Computer Science', re: /\b(computer science|programming|coding)\b/i },
  { name: 'Python programming', re: /\bpython\b/i },
  { name: 'Excel', re: /\b(ms excel|excel)\b/i },
  { name: 'Web development', re: /\b(web development|html|javascript)\b/i },
]
/**
 * Which course a message is about, decided deterministically (live: the model attached a Physics goal to the
 * active Maths course). `existing`: one of the student's courses; `new`: a subject none of them covers.
 */
export function subjectSwitch(message: string, courses: { id: string; title: string }[], currentCourseId: string | undefined): { kind: 'existing'; courseId: string } | { kind: 'new'; subject: string } | null {
  if (!/(learn|study|padh|prepare|exam|course|samajh|sikh|seekh|revise|chapter|class \d|want|chahiye|start)/i.test(message)) return null
  const hit = SUBJECTS.find((x) => x.re.test(message))
  if (!hit) return null
  const mine = courses.filter((c) => hit.re.test(c.title) || c.title.toLowerCase().includes(hit.name.toLowerCase()))
  const grade = /\bclass\s*(\d{1,2})\b/i.exec(message)?.[1]
  const pick = grade ? mine.filter((c) => new RegExp(`\b${grade}\b`).test(c.title)) : mine
  const course = (pick.length ? pick : grade ? [] : mine)[0]
  if (course) return course.id === currentCourseId ? null : { kind: 'existing', courseId: course.id }
  const board = /\b(cbse|icse|ncert|state board|jee|neet)\b/i.exec(message)?.[1]
  return { kind: 'new', subject: [hit.name, grade ? `class ${grade}` : '', board ? board.toUpperCase() : ''].filter(Boolean).join(' ') }
}

const GENERIC = new Set(['another', 'other', 'subject', 'subjects', 'skill', 'skills', 'course', 'courses', 'any', 'some', 'new', 'unspecified', 'learn', 'learning', 'study', 'studies', 'concept', 'concepts', 'mastery', 'conceptual', 'comprehensive', 'self', 'general', 'topic', 'topics', 'chapter', 'something', 'stuff', 'koi', 'aur', 'naya', 'kuch', 'class', 'exam', 'preparation', 'basics', 'complete', 'full', 'note', 'notes', 'notebook', 'pdf', 'docx', 'doc', 'document', 'documents', 'file', 'files', 'upload', 'uploaded', 'material', 'materials', 'book', 'books', 'page', 'pages', 'taking', 'handout', 'slides', 'mera', 'meri', 'mere', 'apne', 'apni'])
/** A course may be created only for a concrete subject the student actually wrote (never "another subject"). */
export function concreteSubject(subject: string, message: string): boolean {
  const words = (x: string) => x.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length >= 3 && !GENERIC.has(w))
  const said = new Set(words(message))
  return words(subject).some((w) => said.has(w) || [...said].some((m) => m.length >= 5 && (m.startsWith(w.slice(0, 5)) || w.startsWith(m.slice(0, 5)))))
}
