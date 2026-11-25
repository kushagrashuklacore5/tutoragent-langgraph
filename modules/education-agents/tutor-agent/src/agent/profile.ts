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
  /** total study time the student has for this goal ("I have six hours"), reconciled with dailyMinutes by the roadmap */
  totalMinutes?: number
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
  if (typeof x.totalMinutes === 'number' && Number.isFinite(x.totalMinutes)) set('totalMinutes', Math.round(Math.min(6000, Math.max(15, x.totalMinutes))))
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
    // a stated total is enough to plan; the roadmap uses a sensible daily default the student can change
    if (s === 'dailyMinutes' && p.totalMinutes) return false
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
  if (slot === 'objective') {
    if (/\b(exam|test|taiyaari|preparation)\b/.test(t)) return { objective: 'exam_prep' }
    if (/\b(practical|skills?|hands.on)\b/.test(t)) return { objective: 'practical_skills' }
    if (/\b(concepts?|understand|samajh\w*)\b/.test(t)) return { objective: 'conceptual_mastery' }
    if (/\bgeneral\b/.test(t)) return { objective: 'general' }
  }
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
    if (/(upload|my notes|my own|have (some |my )?notes|apne notes|mere notes|meri notes|mere paas|apna material|pdf|docx|\bphotos?\b|own notes|^own|^1\b)/.test(t)) return { material: 'own' }
    if (/(ncert|curriculum|syllabus|textbook|text book|course material|\bboard\b|^2\b)/.test(t)) return { material: 'curriculum' }
    // whole words (live: "photosynthesis" read as a photo; "momentum" and "accurate" would read as "tum" and "curat")
    if (/(\bai\b|\bgenerate|\bprepare|\bcurat|\baap\b|\btum\b|\byou\b|banao|bana do|koi bhi|^3\b)/.test(t)) return { material: 'ai' }
  }
  // the student's own words ARE the answer to "which chapter or topic?" (live: a rate-limited model left it unread, so the question repeated)
  if (slot === 'topic') { const topic = cleanTopic(text.replace(/^(?:i\s+have\s+)?(?:my\s+(?:own\s+)?topic(?:\s+is)?|(?:it'?s|its|it is)\s+(?:the\s+)?topic|the\s+topic\s+is)\s*[:\-]?\s*/i, '')); if (namesATopic(topic)) return { topic } }
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
export const PLAN_FIELDS: (keyof LearnerProfile)[] = ['courseId', 'objective', 'topic', 'depth', 'examDate', 'dailyMinutes', 'totalMinutes', 'studyDaysPerWeek']

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
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, che: 6, saat: 7, aath: 8, nau: 9, das: 10 }
const digits = (t: string) => t.replace(/\b([a-z]+)(?=\s+(?:h|hr|hrs|hour|hours|ghanta|ghante|min|mins|minute|minutes)\b)/g, (w) => (w in NUMBER_WORDS ? String(NUMBER_WORDS[w]) : w))
const DAILY_CUE = /(a day|per day|daily|every day|each day|roz|rozana|din mein|din me|\/day)/
/** Total time for the goal ("I have six hours", "only 6 hours left", "6 ghante hain"). Never a per-day figure. */
export function statedTotalMinutes(text: string): number | null {
  const t = digits(text.toLowerCase())
  if (DAILY_CUE.test(t)) return null
  const n = /(?:\b(?:have|got|only|within|in|total|next|sirf|bas)\s+(?:about\s+|around\s+|just\s+|only\s+)?(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours|ghanta|ghante)\b)|(?:\b(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours|ghanta|ghante)\s+(?:total|left|hain|hai|available)\b)/.exec(t)
  const h = n ? Number(n[1] ?? n[2]) : 0
  return h >= 0.5 && h <= 100 ? Math.round(h * 60) : null
}

export function statedDailyMinutes(text: string): number | null {
  const t = digits(text.toLowerCase())
  if (!DAILY_CUE.test(t)) return null
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
  { name: 'Machine Learning', re: /\bmachine learning\b/i },
  { name: 'Artificial Intelligence', re: /\b(artificial intelligence|neural networks?|deep learning|(?:learn|study|about)\s+ai)\b/i },
  { name: 'Python programming', re: /\bpython\b/i },
  { name: 'Excel', re: /\b(ms excel|excel)\b/i },
  { name: 'Web development', re: /\b(web development|html|javascript)\b/i },
]
/** Words that never name a learning topic on their own ("explain this again", "another subject"). */
const NOT_A_TOPIC = new Set(['this', 'that', 'these', 'those', 'again', 'more', 'something', 'anything', 'another', 'other', 'subject', 'skill', 'topic', 'topics', 'course', 'courses', 'please', 'simple', 'simply', 'detail', 'details', 'example', 'examples', 'answer', 'question', 'above', 'same', 'step', 'steps', 'words', 'better', 'properly', 'clearly', 'it', 'me', 'my', 'own', 'the', 'about', 'with', 'what', 'learn', 'study', 'understand', 'know', 'teach', 'explain', 'new', 'different', 'kuch', 'aur', 'koi', 'yeh', 'woh', 'ise', 'use'])
const LEARN_CUES: RegExp[] = [
  /(?:^|[,.;!]\s*|\b(?:and|so|now)\s+)(?:please\s+|pls\s+|can you\s+|could you\s+)*(?:explain|teach|describe|tell me about|samjhao|samjha do|batao)(?:\s+(?:me|to me|us|mujhe))?\s+(?:about\s+|on\s+)?(.+)$/i,
  /\b(?:i\s+(?:want|would like|wanna|need|wish)\s+to\s+(?:learn|study|understand|know about)|help me (?:learn|understand|study)|let'?s learn|start learning)\s+(?:about\s+)?(.+)$/i,
  /\b(?:i\s+have\s+)?my\s+(?:own\s+)?topic(?:\s+is)?\s*[:\-]?\s*(.+)$/i,
  /\b(?:it'?s|its|it is)\s+(?:the\s+)?topic\s*[:\-]?\s*(.+)$/i,
  /\b(?:prepare|get)\s+me\s+(?:ready\s+)?for\s+(?:my\s+|the\s+)?(.+?)\s*(?:exam(?:ination)?s?|tests?|boards?)?[.!]*$/i,
  /^(?:the\s+)?topic(?:\s+is)?\s*[:\-]\s*(.+)$/i,
]
/** the topic words a student typed, without filler ("step by step", "please", trailing punctuation) */
export function cleanTopic(text: string): string {
  return text.replace(/\b(step by step|in simple (words|language|terms)|in detail|in short|briefly|for me|please|pls|thanks|thank you)\b/gi, ' ')
    .replace(/^[\s,:;\-]*(?:on|about|the topic|topic)\s+/i, '').replace(/[?.!,;:\s]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 120)
}
/** a phrase that really names something to learn (at least one meaningful word), never filler or a request for more */
export const namesATopic = (phrase: string) => !!phrase && phrase.length >= 3 && phrase.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).some((w) => w.length >= 4 && !NOT_A_TOPIC.has(w))
/**
 * The topic a student explicitly asked to learn, decided by rule so it never depends on the model:
 * "explain me dissection of human body", "I want to learn Python", "my own topic: X", "it's the topic X".
 * When the student is answering "which subject or skill?", the whole answer is the topic.
 */
export function requestedTopic(message: string, answeringSubject: boolean): string | null {
  const text = message.trim()
  if (!text || text.length > 300) return null
  // a learning phrase that names nothing ("I want to learn something new") is not a topic, even as an answer
  for (const re of LEARN_CUES) { const m = re.exec(text); if (m?.[1]) { const t = cleanTopic(m[1]); return namesATopic(t) ? t : null } }
  if (answeringSubject) { const t = cleanTopic(text.replace(/^(?:i\s+(?:want|would like)\s+(?:to\s+)?|i\s+have\s+)/i, '')); return namesATopic(t) ? t : null }
  return null
}
/** an explicit change of subject while another course is active ("switch topic to X", "new topic: X", "instead teach me X") */
export function topicChange(message: string): string | null {
  const m = /\b(?:change|switch)\s+(?:the\s+|my\s+)?(?:topic|subject)\s+to\s+(.+)$|\b(?:new|different|another)\s+(?:topic|subject)\s*[:\-]\s*(.+)$|\binstead,?\s+(?:teach|explain)\s+(?:me\s+)?(?:about\s+)?(.+)$/i.exec(message.trim())
  const t = m ? cleanTopic(m[1] ?? m[2] ?? m[3] ?? '') : ''
  return namesATopic(t) ? t : null
}
/** whether a topic shares a meaningful word (first 5 letters, so plurals and small misspellings match) with any of these names */
export function relatedTo(topic: string, names: string[]): boolean {
  const stems = (x: string) => x.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length >= 4 && !NOT_A_TOPIC.has(w)).map((w) => w.slice(0, 5))
  const mine = new Set(stems(topic))
  return names.some((n) => stems(n).some((w) => mine.has(w)))
}
/** "explain …" / "what is …" asks for an explanation, not a study plan */
export const asksForExplanation = (message: string) => /^(?:please\s+|can you\s+|could you\s+)*(?:explain|describe|tell me about|what is|what are|samjhao|samjha do|batao)\b/i.test(message.trim())

const SWITCH_CUE = /\b(go back|back to|switch|return to|wapas|continue with|resume|learn|study|padh\w*)\b/i
const TITLE_NOISE = new Set(['course', 'courses', 'complete', 'sample', 'study', 'notes', 'material', 'materials', 'untitled', 'chapter', 'basics', 'introduction', 'personal', 'subject', 'learning'])
const titleWords = (x: string) => x.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)
/** The one enrolled course whose distinctive title word the message uses (personal courses can be about anything). */
export function courseNamed<C extends { id: string; title: string; createdAt?: string }>(message: string, courses: C[]): C | null {
  const said = new Set(titleWords(message))
  const grade = /\bclass\s*(\d{1,2})\b/i.exec(message)?.[1]
  const hits = courses.filter((c) => titleWords(c.title).some((w) => w.length >= 6 && !TITLE_NOISE.has(w) && said.has(w)) && (!grade || new RegExp(`\\b${grade}\\b`).test(c.title)))
  if (hits.length <= 1) return hits[0] ?? null
  // several courses on the same subject: the one whose title the message covers best, then the newest (never a new duplicate)
  const score = (t: string) => { const w = titleWords(t).filter((x) => x.length >= 4 && !TITLE_NOISE.has(x)); return w.length ? w.filter((x) => said.has(x)).length / w.length : 0 }
  const best = Math.max(...hits.map((c) => score(c.title)))
  const top = hits.filter((c) => score(c.title) === best)
  return [...top].sort((x, y) => String(x.createdAt ?? '').localeCompare(String(y.createdAt ?? ''))).at(-1)!
}
/**
 * Which course a message is about, decided deterministically (live: the model attached a Physics goal to the
 * active Maths course). `existing`: one of the student's courses; `new`: a subject none of them covers.
 */
export function subjectSwitch(message: string, courses: { id: string; title: string }[], currentCourseId: string | undefined): { kind: 'existing'; courseId: string } | { kind: 'new'; subject: string } | null {
  const named = SWITCH_CUE.test(message) ? courseNamed(message, courses) : null
  if (named) return named.id === currentCourseId ? null : { kind: 'existing', courseId: named.id }
  if (!/(learn|study|padh|prepare|exam|course|samajh|sikh|seekh|revise|chapter|class \d|want|chahiye|start)/i.test(message)) return null
  const hit = SUBJECTS.find((x) => x.re.test(message))
  if (!hit) return null
  const mine = courses.filter((c) => hit.re.test(c.title) || c.title.toLowerCase().includes(hit.name.toLowerCase()))
  const grade = /\bclass\s*(\d{1,2})\b/i.exec(message)?.[1]
  const pick = grade ? mine.filter((c) => new RegExp(`\\b${grade}\\b`).test(c.title)) : mine
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
