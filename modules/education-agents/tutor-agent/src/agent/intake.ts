/**
 * One-shot onboarding intake (pure, unit-tested; no model call).
 * When a student states a learning goal, every question that still matters is asked TOGETHER in one structured card,
 * answered once and validated as one payload. Known facts are never asked again; optional ones have defaults and may
 * be skipped; any question allows the student's own words. The answers are mapped to the learner profile by rule.
 */
import { type LearnerProfile, type Objective } from './profile.ts'

export type IntakeSlot = 'level' | 'confidence' | 'objective' | 'learningStyle' | 'dailyMinutes' | 'examDate' | 'material'
export interface IntakeOption { value: string; label: string }
export interface IntakeQuestion {
  slot: IntakeSlot
  label: string
  options: IntakeOption[]
  /** answered by the default when left blank (a required question has no default and must be answered) */
  default: string | null
  required: boolean
  allowCustom: boolean
  /** shown only when another answer is one of these values (e.g. study time only for a scheduled goal) */
  showIf?: { slot: IntakeSlot; in: string[] }
}
export interface Intake { id: string; courseId: string; questions: IntakeQuestion[] }
/** what the conversation keeps (structural: no student text) */
export interface IntakeRecord { id: string; courseId: string; slots: IntakeSlot[]; status: 'pending' | 'submitted' }

/** goals that need a schedule (study time, date); a concept explanation never gets a multi-day timetable */
export const SCHEDULED: Objective[] = ['exam_prep', 'revision', 'interview_prep']
const LEVEL: Record<string, Partial<LearnerProfile>> = {
  class_6_8: { level: 'school', grade: 'Class 6–8' },
  class_9_10: { level: 'school', grade: 'Class 9–10' },
  class_11_12: { level: 'school', grade: 'Class 11–12' },
  undergraduate: { level: 'undergraduate' },
  professional: { level: 'professional' },
}
const CONFIDENCE: Record<string, number> = { beginner: 1, basic: 2, intermediate: 3, advanced: 4 }
const OBJECTIVE: Record<string, Partial<LearnerProfile>> = {
  concepts: { objective: 'conceptual_mastery', depth: 'standard' },
  exam: { objective: 'exam_prep' },
  detailed: { objective: 'conceptual_mastery', depth: 'deep' },
  practical: { objective: 'practical_skills' },
  visual: { objective: 'conceptual_mastery', learningStyle: 'visual' },
}
const STYLE: Record<string, LearnerProfile['learningStyle']> = { examples: 'examples_first', visual: 'visual', steps: 'theory_first', practice: 'practice_heavy', mixed: 'mixed' }
const MINUTES: Record<string, number> = { m30: 30, m60: 60, m120: 120, flexible: 30 }
const DATE_IN_DAYS: Record<string, number> = { d14: 14, d30: 30, d75: 75 }

/** "I am in class 12", "12th class", "a beginner", "I'm in college" — what a message says about the learner (by rule) */
export function statedLearner(message: string): Partial<LearnerProfile> {
  const t = message.toLowerCase()
  const out: Partial<LearnerProfile> = {}
  const cls = /\b(?:class|grade|std\.?|standard)\s*(\d{1,2})(?:st|nd|rd|th)?\b|\b(\d{1,2})(?:st|nd|rd|th)\s*(?:class|grade|std|standard)\b/.exec(t)
  const n = cls ? Number(cls[1] ?? cls[2]) : NaN
  if (n >= 1 && n <= 12) { out.level = 'school'; out.grade = `Class ${n}` }
  else if (/\b(college|undergrad\w*|b\.?\s?tech|b\.?\s?sc|b\.?\s?com|b\.?\s?a\b|bachelor'?s?|university|engineering student)\b/.test(t)) out.level = 'undergraduate'
  else if (/\b(mbbs|medical student|nursing|working professional|professional|m\.?\s?tech|master'?s|postgrad\w*)\b/.test(t)) out.level = /postgrad|master|m\.?\s?tech/.test(t) ? 'postgraduate' : 'professional'
  if (/\b(complete beginner|beginner|from scratch|new to (it|this)|never studied|zero knowledge|bilkul nahi aata)\b/.test(t)) out.confidence = 1
  else if (/\b(basic (understanding|knowledge|idea)|a little|thoda aata)\b/.test(t)) out.confidence = 2
  else if (/\bintermediate\b/.test(t)) out.confidence = 3
  else if (/\badvanced\b/.test(t)) out.confidence = 4
  if (/\b(exam|examination|boards?|test)\b/.test(t) && /\b(prepare|preparing|preparation|for my|taiyaari|revise)\b/.test(t)) out.objective = 'exam_prep'
  return out
}
/** a typed answer to "which class or year?" ("5", "12th class", "college") */
export function parseLevelAnswer(text: string): Partial<LearnerProfile> {
  const t = text.trim()
  const bare = /^(\d{1,2})(?:st|nd|rd|th)?\.?$/.exec(t)
  if (bare && Number(bare[1]) >= 1 && Number(bare[1]) <= 12) return { level: 'school', grade: `Class ${Number(bare[1])}` }
  const s = statedLearner(t)
  return s.level ? { level: s.level, ...(s.grade ? { grade: s.grade } : {}) } : {}
}

const levelKnown = (p: LearnerProfile) => !!p.level || !!p.grade
const materialKnown = (p: LearnerProfile) => p.material !== undefined && p.materialFor === p.courseId

/** The questions that still matter for this goal, all at once; null when nothing needs asking. */
export function buildIntake(p: LearnerProfile, o: { id: string; courseId: string; explain: boolean }): Intake | null {
  const q: IntakeQuestion[] = []
  if (!levelKnown(p)) q.push({ slot: 'level', label: 'Your academic level', required: false, default: null, allowCustom: true, options: [
    { value: 'class_9_10', label: 'Class 9–10' }, { value: 'class_11_12', label: 'Class 11–12' }, { value: 'undergraduate', label: 'Undergraduate' }, { value: 'professional', label: 'Medical / professional studies' }, { value: 'class_6_8', label: 'Class 6–8' },
  ] })
  if (p.confidence === undefined) q.push({ slot: 'confidence', label: 'Your current understanding', required: false, default: 'beginner', allowCustom: false, options: [
    { value: 'beginner', label: 'Complete beginner' }, { value: 'basic', label: 'Basic understanding' }, { value: 'intermediate', label: 'Intermediate' }, { value: 'advanced', label: 'Advanced' },
  ] })
  if (!p.objective) q.push({ slot: 'objective', label: 'What do you want from this?', required: false, default: 'concepts', allowCustom: true, options: [
    { value: 'concepts', label: o.explain ? 'Understand it from scratch' : 'Understand the concepts' }, { value: 'exam', label: 'Prepare for an exam' }, { value: 'visual', label: 'Learn through diagrams and visuals' }, { value: 'detailed', label: 'Detailed academic understanding' }, { value: 'practical', label: 'Practical / hands-on use' },
  ] })
  if (!p.learningStyle) q.push({ slot: 'learningStyle', label: 'How should Vidya teach you?', required: false, default: 'mixed', allowCustom: false, options: [
    { value: 'examples', label: 'Simple explanations with examples' }, { value: 'visual', label: 'Diagrams and visual demonstrations' }, { value: 'steps', label: 'Step-by-step explanations' }, { value: 'mixed', label: 'A mix of all' },
  ] })
  const scheduled = p.objective ? SCHEDULED.includes(p.objective) : null
  const scheduleIf = scheduled === null ? { slot: 'objective' as const, in: ['exam'] } : undefined
  if (scheduled !== false && !p.examDate) q.push({ slot: 'examDate', label: 'When is your exam?', required: false, default: 'd30', allowCustom: true, showIf: scheduleIf, options: [
    { value: 'd14', label: 'Within 2 weeks' }, { value: 'd30', label: 'In about a month' }, { value: 'd75', label: 'In 2–3 months' }, { value: 'none', label: 'No fixed date' },
  ] })
  if (scheduled !== false && !p.dailyMinutes && !p.totalMinutes) q.push({ slot: 'dailyMinutes', label: 'Study time you have', required: false, default: 'm60', allowCustom: false, showIf: scheduleIf, options: [
    { value: 'm30', label: '15–30 minutes a day' }, { value: 'm60', label: '1 hour a day' }, { value: 'm120', label: '2 hours a day' }, { value: 'flexible', label: 'Flexible' },
  ] })
  // the material source is the student's explicit choice (never guessed): the one question with a pre-picked, visible answer
  if (!materialKnown(p)) q.push({ slot: 'material', label: 'What should we learn from?', required: true, default: 'ai', allowCustom: false, options: [
    { value: 'ai', label: 'Vidya prepares the lessons' }, { value: 'curriculum', label: 'NCERT / my syllabus' }, { value: 'own', label: 'My own notes or PDF (upload next)' },
  ] })
  return q.length ? { id: o.id, courseId: o.courseId, questions: q } : null
}

export const intakeRecord = (i: Intake): IntakeRecord => ({ id: i.id, courseId: i.courseId, slots: i.questions.map((x) => x.slot), status: 'pending' })

const ymdIn = (now: Date, days: number) => new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10)

/**
 * Apply ONE submitted intake to the profile. Unknown slots and unknown option values are rejected (custom text only
 * where allowed); blanks take the question's default; a goal without a schedule gets no timetable questions.
 * Returns the problems instead of throwing so the reply can say exactly what was wrong.
 */
export function applyIntake(p: LearnerProfile, rec: IntakeRecord, answers: Record<string, unknown>, now: Date): { profile: LearnerProfile; problems: string[]; stated: string[] } {
  const problems: string[] = []
  const stated: string[] = []
  const intake = buildIntake({ ...p, objective: undefined, learningStyle: undefined, confidence: undefined, level: undefined, grade: undefined, examDate: undefined, dailyMinutes: undefined, totalMinutes: undefined, material: undefined }, { id: rec.id, courseId: rec.courseId, explain: false })!
  const questions = intake.questions.filter((x) => rec.slots.includes(x.slot))
  for (const k of Object.keys(answers)) if (!rec.slots.includes(k as IntakeSlot)) problems.push(`unexpected answer: ${k}`)
  let next: LearnerProfile = { ...p }
  const pick = (q: IntakeQuestion): { value: string | null; custom: string | null } => {
    const raw = answers[q.slot]
    if (raw === undefined || raw === null || raw === '') return { value: q.default, custom: null }
    if (typeof raw !== 'string') { problems.push(`invalid answer: ${q.slot}`); return { value: q.default, custom: null } }
    if (q.options.some((x) => x.value === raw)) return { value: raw, custom: null }
    const custom = raw.trim().replace(/\s+/g, ' ').slice(0, 160)
    if (q.allowCustom && custom.length >= 2) return { value: null, custom }
    problems.push(`invalid answer: ${q.slot}`)
    return { value: q.default, custom: null }
  }
  // the objective first: whether study time and a date apply depends on it
  const ordered = [...questions].sort((a, b) => (a.slot === 'objective' ? -1 : b.slot === 'objective' ? 1 : 0))
  for (const q of ordered) {
    if (q.showIf) {
      const dep = q.showIf.slot === 'objective' ? next.objective : undefined
      const depValue = Object.entries(OBJECTIVE).find(([, v]) => v.objective === dep)?.[0]
      if (!depValue || !q.showIf.in.includes(depValue)) continue
    }
    // a blank answer never overrides what another answer already set ("learn through visuals" sets the style)
    const blank = answers[q.slot] === undefined || answers[q.slot] === null || answers[q.slot] === ''
    if (blank && q.slot !== 'level' && next[q.slot] !== undefined) continue
    const { value, custom } = pick(q)
    if (q.required && !value && !custom) { problems.push(`missing answer: ${q.slot}`); continue }
    if (value !== null || custom) stated.push(q.slot)
    switch (q.slot) {
      case 'level': {
        if (value) next = { ...next, ...LEVEL[value] }
        else if (custom) { const parsed = parseLevelAnswer(custom); next = { ...next, ...parsed, ...(parsed.grade ? {} : { grade: custom.slice(0, 60) }) } }
        break
      }
      case 'confidence': if (value) next.confidence = CONFIDENCE[value]; break
      case 'objective': {
        if (value) next = { ...next, ...OBJECTIVE[value], ...(OBJECTIVE[value]!.learningStyle && next.learningStyle ? { learningStyle: next.learningStyle } : {}) }
        else if (custom) next = { ...next, objective: /exam|test|board/i.test(custom) ? 'exam_prep' : /practical|hands|project|job/i.test(custom) ? 'practical_skills' : 'conceptual_mastery', goalText: custom }
        break
      }
      case 'learningStyle': if (value) next.learningStyle = STYLE[value]; break
      case 'dailyMinutes': if (value) next.dailyMinutes = MINUTES[value]; break
      case 'examDate': {
        if (value === 'none') next.examDate = 'none'
        else if (value) next.examDate = ymdIn(now, DATE_IN_DAYS[value]!)
        else if (custom) { const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(custom)?.[1]; next.examDate = iso && iso > now.toISOString().slice(0, 10) ? iso : ymdIn(now, 30) }
        break
      }
      case 'material': if (value === 'ai' || value === 'curriculum' || value === 'own') { next.material = value; next.materialFor = next.courseId }; break
    }
  }
  // a goal without a schedule is self-paced: no timetable questions, a sensible default daily time the student can change
  if (!next.objective) next.objective = 'conceptual_mastery'
  if (!SCHEDULED.includes(next.objective)) { if (!next.examDate) next.examDate = 'none'; if (!next.dailyMinutes && !next.totalMinutes) next.dailyMinutes = 30 }
  else { if (!next.dailyMinutes && !next.totalMinutes) next.dailyMinutes = 60; if (!next.examDate) next.examDate = ymdIn(now, 30) }
  if (!next.depth) next.depth = 'standard'
  // optional facts not given are skipped (never asked again)
  for (const s of ['confidence', 'level', 'learningStyle'] as const) if (next[s] === undefined && !(s === 'level' && next.grade)) next.skipped = [...new Set([...(next.skipped ?? []), s])]
  return { profile: next, problems, stated }
}

/** a short line for the conversation log: what the student chose (labels only) */
export function intakeSummary(i: Intake, answers: Record<string, string>): string {
  return i.questions.map((q) => { const a = answers[q.slot]; return a ? q.options.find((x) => x.value === a)?.label ?? a : null }).filter(Boolean).join(' · ') || 'Start learning'
}

/**
 * The student already stated the goal and the material (e.g. "general learning from my notes"): nothing material is
 * left to ask for an unscheduled goal, so the optional preferences take their defaults instead of another form.
 */
export function settledWithoutIntake(p: LearnerProfile): LearnerProfile | null {
  if (!p.courseId || !p.objective || SCHEDULED.includes(p.objective) || !materialKnown(p)) return null
  const next: LearnerProfile = { ...p }
  if (!next.dailyMinutes && !next.totalMinutes) next.dailyMinutes = 30
  if (!next.examDate) next.examDate = 'none'
  for (const s of ['confidence', 'level', 'learningStyle'] as const) if (next[s] === undefined && !(s === 'level' && next.grade)) next.skipped = [...new Set([...(next.skipped ?? []), s])]
  return next
}
