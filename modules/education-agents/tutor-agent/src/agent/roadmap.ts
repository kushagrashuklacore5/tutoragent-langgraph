/**
 * Study roadmap = the deterministic planner's day plan (domain/planner.ts) plus what a student needs to judge and
 * approve it: a realistic workload estimate against the time available, weekly milestones with a checkpoint after
 * each, prerequisite gaps and a plain-language feasibility verdict. Pure and unit-tested; no model involved.
 */
import { buildPlan, orderConcepts, type Plan, type PlanConcept } from '../domain/planner.ts'

export interface RoadmapInput {
  today: Date
  /** exam/target date, or null (no fixed date: a 4-week horizon is planned) */
  examAt: Date | null
  dailyMinutes: number
  studyDaysPerWeek?: number
  concepts: PlanConcept[]
  reviewMinutesPerDay?: number
  /** start with a short diagnostic (starting-point check) on day 1 */
  diagnosticFirst?: boolean
}
export interface Milestone { seq: number; title: string; conceptIds: string[]; conceptNames: string[]; due: string }
export interface Roadmap {
  horizon: { start: string; end: string; days: number; fixedDate: boolean }
  dailyMinutes: number
  /** average per calendar day the planner uses (daily minutes × study days / 7) */
  effectiveDailyMinutes: number
  requiredMinutes: number
  availableMinutes: number
  feasibility: 'comfortable' | 'tight' | 'over'
  /** minutes per study day that would fit everything (only when not comfortable) */
  suggestedDailyMinutes: number | null
  milestones: Milestone[]
  checkpoints: Milestone[]
  weeks: { week: number; start: string; learn: number; practice: number; review: number }[]
  gaps: string[]
  notStarted: string[]
  dropped: { name: string; reason: string }[]
  rationale: string[]
  plan: Plan
}

const DAY = 86_400_000
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
export const NO_DATE_HORIZON_DAYS = 28
export const MAX_SPACED_REVIEWS = 6
/** concept work as the planner estimates it (learn + practice) */
export const conceptMinutes = (c: PlanConcept) => { const learn = Math.max(10, Math.round(c.estMinutes * (1 - c.pMastery))); return learn + Math.max(10, Math.round(learn * 0.5)) }

export function buildRoadmap(input: RoadmapInput): Roadmap {
  const start = utcDay(input.today)
  const fixedDate = !!input.examAt
  const end = input.examAt ? new Date(utcDay(input.examAt).getTime() - DAY) : new Date(start.getTime() + (NO_DATE_HORIZON_DAYS - 1) * DAY)
  const days = Math.max(0, Math.round((end.getTime() - start.getTime()) / DAY) + 1)
  const studyDays = Math.min(7, Math.max(1, input.studyDaysPerWeek ?? 7))
  const effective = Math.max(10, Math.round((input.dailyMinutes * studyDays) / 7))
  const plan = buildPlan({ today: start, examAt: new Date(end.getTime() + DAY), dailyMinutes: effective, concepts: input.concepts, reviewMinutesPerDay: input.reviewMinutesPerDay })
  const todo = input.concepts.filter((c) => !c.mastered)
  const review = plan.tasks.filter((t) => t.kind === 'review').reduce((n, t) => n + t.minutes, 0)
  const requiredMinutes = todo.reduce((n, c) => n + conceptMinutes(c), 0) + review
  const availableMinutes = days * effective
  const ratio = availableMinutes ? requiredMinutes / availableMinutes : Infinity
  const feasibility: Roadmap['feasibility'] = plan.dropped.length || ratio > 1 ? 'over' : ratio > 0.85 ? 'tight' : 'comfortable'
  const suggestedDailyMinutes = feasibility === 'comfortable' || !days ? null : Math.min(600, Math.ceil(((requiredMinutes / 0.85) / days) * (7 / studyDays) / 5) * 5)

  // milestones: concepts grouped by the week in which their last task falls, in planner order
  const name = new Map(input.concepts.map((c) => [c.id, c.name]))
  const finish = new Map<string, string>()
  for (const t of plan.tasks) if (t.kind !== 'review') finish.set(t.conceptId, t.date)
  const weekOf = (date: string) => Math.floor((new Date(`${date}T00:00:00Z`).getTime() - start.getTime()) / (7 * DAY))
  const byWeek = new Map<number, string[]>()
  for (const c of orderConcepts(input.concepts)) {
    const f = finish.get(c.id)
    if (!f) continue
    const w = weekOf(f)
    byWeek.set(w, [...(byWeek.get(w) ?? []), c.id])
  }
  const milestones: Milestone[] = []
  const checkpoints: Milestone[] = []
  for (const w of [...byWeek.keys()].sort((a, b) => a - b)) {
    const ids = byWeek.get(w)!
    const due = ids.map((id) => finish.get(id)!).sort().at(-1)!
    const seq = milestones.length + 1
    const names = ids.map((id) => name.get(id)!)
    milestones.push({ seq, title: `Week ${w + 1}: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}`, conceptIds: ids, conceptNames: names, due })
    const cpDate = new Date(Math.min(new Date(`${due}T00:00:00Z`).getTime() + DAY, end.getTime()))
    checkpoints.push({ seq, title: `Checkpoint ${seq}: quick practice check on ${names.slice(0, 3).join(', ')}`, conceptIds: ids, conceptNames: names, due: ymd(cpDate) })
  }
  // spare weeks after the last milestone: weekly spaced retrieval practice on everything covered so far
  // (spacing + retrieval practice beat re-reading; each is a short mixed check, not new content)
  let spaced = 0
  if (milestones.length) {
    const covered = milestones.flatMap((m) => m.conceptIds)
    const finalCheck = fixedDate && days >= 3 ? end.getTime() - DAY : Infinity
    for (let d = new Date(`${milestones.at(-1)!.due}T00:00:00Z`).getTime() + 7 * DAY; d < Math.min(finalCheck - 2 * DAY, end.getTime() + DAY) && spaced < MAX_SPACED_REVIEWS; d += 7 * DAY) {
      spaced++
      checkpoints.push({ seq: checkpoints.length + 1, title: `Spaced review ${spaced}: mixed practice from memory on ${covered.length === 1 ? name.get(covered[0]!)! : `${covered.length} topics`}`, conceptIds: covered, conceptNames: covered.map((id) => name.get(id)!), due: ymd(new Date(d)) })
    }
  }
  if (fixedDate && days >= 3 && milestones.length) {
    const all = milestones.flatMap((m) => m.conceptIds)
    checkpoints.push({ seq: checkpoints.length + 1, title: 'Full mock test: timed, mixed questions across everything', conceptIds: all, conceptNames: all.map((id) => name.get(id)!), due: ymd(new Date(end.getTime() - DAY)) })
  }
  if (input.diagnosticFirst && milestones.length) {
    const all = milestones.flatMap((m) => m.conceptIds)
    checkpoints.unshift({ seq: 0, title: 'Starting-point check: a short diagnostic so the plan fits what you already know', conceptIds: all, conceptNames: all.map((id) => name.get(id)!), due: ymd(start) })
  }

  const weeks: Roadmap['weeks'] = []
  for (const t of plan.tasks) {
    const w = weekOf(t.date)
    let row = weeks.find((x) => x.week === w + 1)
    if (!row) { row = { week: w + 1, start: ymd(new Date(start.getTime() + w * 7 * DAY)), learn: 0, practice: 0, review: 0 }; weeks.push(row) }
    row[t.kind] += t.minutes
  }
  weeks.sort((a, b) => a.week - b.week)

  // prerequisite gaps: a prerequisite of unfinished work that the student has tried but not yet secured
  const prereqOf = new Set(todo.flatMap((c) => c.prerequisites))
  const gaps = input.concepts.filter((c) => prereqOf.has(c.id) && !c.mastered && c.pMastery < 0.5).map((c) => c.name)
  const notStarted = todo.filter((c) => c.pMastery <= 0.2).map((c) => c.name)

  const rationale = [...plan.rationale]
  if (studyDays < 7) rationale.unshift(`You study ${studyDays} day(s) a week, so ${input.dailyMinutes} min on study days averages ${effective} min a day.`)
  rationale.unshift(`About ${Math.round(requiredMinutes / 60 * 10) / 10} h of work against ${Math.round(availableMinutes / 60 * 10) / 10} h available${fixedDate ? ' before your date' : ` over the next ${NO_DATE_HORIZON_DAYS} days`}.`)
  if (spaced) rationale.push(`Spare time after the last milestone is used for ${spaced} weekly spaced review(s): short mixed practice from memory, which helps retention more than re-reading.`)
  if (suggestedDailyMinutes) rationale.push(`To fit everything comfortably, about ${suggestedDailyMinutes} min per study day would be needed.`)

  return {
    horizon: { start: ymd(start), end: ymd(end), days, fixedDate }, dailyMinutes: input.dailyMinutes, effectiveDailyMinutes: effective,
    requiredMinutes, availableMinutes, feasibility, suggestedDailyMinutes, milestones, checkpoints, weeks, gaps, notStarted,
    dropped: plan.dropped.map((d) => ({ name: name.get(d.conceptId) ?? d.conceptId, reason: d.reason })), rationale, plan,
  }
}
