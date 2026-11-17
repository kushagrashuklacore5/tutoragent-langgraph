/**
 * Deterministic study planner (FEATURE_SPECIFICATIONS.md § C). No AI involved: same inputs, same plan.
 * Priority = exam weight × (1 − mastery) with prerequisites scheduled before dependants, inside the
 * student's daily capacity. Missed work is re-planned without ever exceeding 125% of stated daily time.
 */

export interface PlanConcept {
  id: string
  name: string
  estMinutes: number
  examWeight: number // relative, > 0
  pMastery: number // 0..1
  mastered: boolean
  prerequisites: string[]
}
export interface PlanInput {
  today: Date
  examAt: Date | null
  /** minutes the student can study per day (from weekly hours / days) */
  dailyMinutes: number
  concepts: PlanConcept[]
  /** due spaced-repetition reviews per day (estimated minutes) */
  reviewMinutesPerDay?: number
  /** tasks already completed (concept ids) */
  completed?: string[]
}
export interface PlanTask {
  date: string
  conceptId: string
  conceptName: string
  kind: 'learn' | 'practice' | 'review'
  minutes: number
}
export interface Plan {
  tasks: PlanTask[]
  dropped: { conceptId: string; reason: string }[]
  rationale: string[]
}

export const MAX_OVERLOAD = 1.25
const ymd = (d: Date) => d.toISOString().slice(0, 10)

/** Topological order that respects prerequisites; ties broken by priority then id (deterministic). */
export function orderConcepts(concepts: PlanConcept[]): PlanConcept[] {
  const byId = new Map(concepts.map((c) => [c.id, c]))
  const prio = (c: PlanConcept) => c.examWeight * (1 - c.pMastery)
  const out: PlanConcept[] = []
  const done = new Set<string>()
  const visiting = new Set<string>()
  const visit = (c: PlanConcept) => {
    if (done.has(c.id)) return
    if (visiting.has(c.id)) return // cycle guard: educators' graph is validated elsewhere
    visiting.add(c.id)
    for (const p of [...c.prerequisites].sort()) {
      const pc = byId.get(p)
      if (pc) visit(pc)
    }
    visiting.delete(c.id)
    done.add(c.id)
    out.push(c)
  }
  for (const c of [...concepts].sort((a, b) => prio(b) - prio(a) || a.id.localeCompare(b.id))) visit(c)
  return out
}

export function buildPlan(input: PlanInput): Plan {
  const rationale: string[] = []
  const dropped: Plan['dropped'] = []
  const completed = new Set(input.completed ?? [])
  const daily = Math.max(10, Math.round(input.dailyMinutes))
  const review = Math.min(Math.round(input.reviewMinutesPerDay ?? 0), Math.floor(daily * 0.4))
  const start = new Date(Date.UTC(input.today.getUTCFullYear(), input.today.getUTCMonth(), input.today.getUTCDate()))
  const lastDay = input.examAt ? new Date(Date.UTC(input.examAt.getUTCFullYear(), input.examAt.getUTCMonth(), input.examAt.getUTCDate()) - 86_400_000) : new Date(start.getTime() + 13 * 86_400_000)
  const days: { date: string; left: number }[] = []
  for (let d = start.getTime(); d <= lastDay.getTime(); d += 86_400_000) days.push({ date: ymd(new Date(d)), left: daily - review })
  if (!days.length) return { tasks: [], dropped: input.concepts.map((c) => ({ conceptId: c.id, reason: 'exam date has passed' })), rationale: ['The exam date is today or in the past.'] }

  const tasks: PlanTask[] = days.filter(() => review > 0).map((d) => ({ date: d.date, conceptId: '*', conceptName: 'Spaced revision', kind: 'review' as const, minutes: review }))
  if (review > 0) rationale.push(`${review} min/day reserved for spaced revision.`)

  const todo = orderConcepts(input.concepts.filter((c) => !c.mastered && !completed.has(c.id)))
  const skipMastered = input.concepts.filter((c) => c.mastered).length
  if (skipMastered) rationale.push(`${skipMastered} concept(s) already mastered are left to spaced revision.`)

  let di = 0
  const placed = new Set<string>()
  for (const c of todo) {
    // a concept cannot start before its prerequisites are placed
    const blocked = c.prerequisites.some((p) => input.concepts.some((x) => x.id === p && !x.mastered && !completed.has(p)) && !placed.has(p))
    if (blocked) {
      dropped.push({ conceptId: c.id, reason: 'a prerequisite could not be scheduled in time' })
      continue
    }
    const learn = Math.max(10, Math.round(c.estMinutes * (1 - c.pMastery)))
    const practice = Math.max(10, Math.round(learn * 0.5))
    let need = [{ kind: 'learn' as const, minutes: learn }, { kind: 'practice' as const, minutes: practice }]
    const startDi = di
    const pending: PlanTask[] = []
    while (need.length && di < days.length) {
      const day = days[di]!
      const part = need[0]!
      const take = Math.min(part.minutes, day.left)
      if (take >= 10 || take === part.minutes) {
        pending.push({ date: day.date, conceptId: c.id, conceptName: c.name, kind: part.kind, minutes: take })
        day.left -= take
        part.minutes -= take
        if (part.minutes <= 0) need = need.slice(1)
      }
      if (day.left < 10) di++
    }
    if (need.length) {
      // does not fit: roll back this concept and record why (never silently overload)
      for (const t of pending) days.find((d) => d.date === t.date)!.left += t.minutes
      di = startDi
      dropped.push({ conceptId: c.id, reason: 'not enough time before the exam at your daily study time' })
      continue
    }
    tasks.push(...pending)
    placed.add(c.id)
  }
  if (dropped.length) rationale.push(`${dropped.length} concept(s) did not fit; increase daily time or prioritise them manually.`)
  rationale.push('Higher exam weight and lower mastery come first; prerequisites always come before dependent topics.')
  tasks.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'review' ? -1 : b.kind === 'review' ? 1 : 0))
  return { tasks, dropped, rationale }
}

/** Re-plan after missed days: incomplete concepts are rescheduled from today; daily load stays within 125%. */
export function recoverPlan(input: PlanInput, missedMinutes: number): Plan {
  const boosted = Math.min(input.dailyMinutes * MAX_OVERLOAD, input.dailyMinutes + missedMinutes)
  const p = buildPlan({ ...input, dailyMinutes: boosted })
  p.rationale.unshift(`Missed work was moved forward; daily time is temporarily ${Math.round(boosted)} min (max ${Math.round(MAX_OVERLOAD * 100)}% of your usual).`)
  return p
}
