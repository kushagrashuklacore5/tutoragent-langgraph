/**
 * Assessment engine — deterministic core (no AI here). Unit-tested.
 *   assemble()        evidence-based question selection for an attempt
 *   validateMarking() turns AI rubric-marking passes into validated marks, or a review flag
 *   summarize()       score breakdown, strengths/weaknesses, recall-vs-application signal
 */

export type ItemType = 'mcq' | 'numeric' | 'expression' | 'short' | 'descriptive'
export type Cognitive = 'recall' | 'understand' | 'apply' | 'transfer' | 'explain'
export interface Criterion { id: string; criterion: string; points: number; keyPoints: string[] }

// ── near-duplicate detection ──
const STOP = new Set(['the', 'and', 'for', 'what', 'which', 'with', 'that', 'this', 'from', 'are', 'its', 'has', 'have', 'into', 'how', 'why', 'does', 'find', 'will', 'your'])
const words = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w)))
/** Jaccard similarity of question stems (numbers included, so "a 3 kg block…" ≠ "a 5 kg block…" only slightly). */
export function stemSimilarity(a: string, b: string): number {
  const x = words(a), y = words(b)
  if (!x.size || !y.size) return 0
  let i = 0
  for (const w of x) if (y.has(w)) i++
  return i / (x.size + y.size - i)
}
export const NEAR_DUPLICATE = 0.75

// ── assembly ──
export interface PoolItem { id: string; conceptId: string; type: ItemType; difficulty: number; cognitive: Cognitive; stem: string; points: number }
export interface SectionSpec { title: string; conceptIds: string[]; count: number; types?: ItemType[]; difficulty?: 'adaptive' | 'mixed' | 'easy' | 'hard' }
export interface ConceptState { pMastery: number; state: string; evidenceCount: number }
export interface PlannedItem { itemId: string; section: number; points: number; reason: string }

/**
 * Pick questions per section from the approved pool using the student's evidence:
 *   - never an item seen in the last `recentDays` (exposure control) or a near-duplicate of one already picked
 *   - difficulty target = the concept's mastery estimate (adaptive), spread (mixed), or fixed (easy/hard)
 *   - concepts the student already does well on (p ≥ 0.7) prefer apply/transfer items (does it transfer?)
 *   - a weak prerequisite (p < 0.5 with evidence) contributes one item, so gaps surface in results
 * Deterministic: ties break by item id.
 */
export function assemble(input: {
  sections: SectionSpec[]; pool: PoolItem[]; mastery: Map<string, ConceptState>; recentlySeen: Set<string>
  prerequisites: Map<string, string[]>; adaptive: boolean
}): { plan: PlannedItem[]; shortfall: { section: number; wanted: number; got: number }[] } {
  const picked: PlannedItem[] = []
  const pickedStems: string[] = []
  const used = new Set<string>()
  const shortfall: { section: number; wanted: number; got: number }[] = []
  const usable = (it: PoolItem) => !used.has(it.id) && !input.recentlySeen.has(it.id) && !pickedStems.some((s) => stemSimilarity(s, it.stem) >= NEAR_DUPLICATE)
  input.sections.forEach((sec, si) => {
    const inSection = (it: PoolItem, conceptIds: string[]) => conceptIds.includes(it.conceptId) && (!sec.types?.length || sec.types.includes(it.type))
    const target = (it: PoolItem, n: number): number => {
      const p = input.mastery.get(it.conceptId)?.pMastery ?? 0.5
      if (sec.difficulty === 'easy') return 0.25
      if (sec.difficulty === 'hard') return 0.8
      if (sec.difficulty === 'mixed' || !input.adaptive) return [0.3, 0.5, 0.7, 0.9][n % 4]!
      return Math.min(0.95, Math.max(0.15, p + 0.05)) // just above the current estimate
    }
    let got = 0
    // weak prerequisites first (adaptive only, one item, counted in this section)
    if (input.adaptive) {
      const weakPre = [...new Set(sec.conceptIds.flatMap((c) => input.prerequisites.get(c) ?? []))]
        .filter((pid) => { const m = input.mastery.get(pid); return m && m.evidenceCount > 0 && m.pMastery < 0.5 })
      for (const pid of weakPre.slice(0, 1)) {
        if (got >= sec.count) break
        const c = input.pool.filter((it) => it.conceptId === pid && usable(it) && (!sec.types?.length || sec.types.includes(it.type))).sort((a, b) => a.difficulty - b.difficulty || a.id.localeCompare(b.id))[0]
        if (c) { take(c, si, `prerequisite check: ${pid}`); got++ }
      }
    }
    // round-robin across the section's concepts so one concept cannot crowd out the rest
    const order = [...sec.conceptIds]
    let stalled = 0
    while (got < sec.count && stalled < order.length) {
      stalled = 0
      for (const cid of order) {
        if (got >= sec.count) break
        const m = input.mastery.get(cid)
        const preferApply = input.adaptive && (m?.pMastery ?? 0) >= 0.7
        const cands = input.pool.filter((it) => inSection(it, [cid]) && usable(it))
        if (!cands.length) { stalled++; continue }
        const t = target(cands[0]!, got)
        cands.sort((a, b) => {
          const ap = preferApply && (a.cognitive === 'apply' || a.cognitive === 'transfer') ? -0.3 : 0
          const bp = preferApply && (b.cognitive === 'apply' || b.cognitive === 'transfer') ? -0.3 : 0
          return (Math.abs(a.difficulty - t) + ap) - (Math.abs(b.difficulty - t) + bp) || a.id.localeCompare(b.id)
        })
        const c = cands[0]!
        take(c, si, preferApply && (c.cognitive === 'apply' || c.cognitive === 'transfer') ? 'transfer check on a strong concept' : `difficulty near ${t.toFixed(2)}`)
        got++
      }
    }
    if (got < sec.count) shortfall.push({ section: si, wanted: sec.count, got })
  })
  return { plan: picked, shortfall }

  function take(it: PoolItem, section: number, reason: string) {
    used.add(it.id)
    pickedStems.push(it.stem)
    picked.push({ itemId: it.id, section, points: it.points, reason })
  }
}

// ── rubric marking validation ──
export interface MarkingPass {
  criteria: { id: string; awarded: number; evidence: string[]; missing: string[]; feedback: string }[]
  overallFeedback: string
  incorrectAssumptions?: string[]
  alternativeApproach?: boolean
  ambiguous?: boolean
  confidence: number
}
export interface ValidatedMark {
  points: number
  maxPoints: number
  needsReview: boolean
  reasons: string[]
  criteria: { id: string; criterion: string; points: number; awarded: number; feedback: string; missing: string[]; evidence: string[] }[]
  feedback: string
  incorrectAssumptions: string[]
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
/** A quoted evidence snippet must really be in the student's answer (normalised, whole words). */
export function quoteInAnswer(quote: string, answer: string): boolean {
  const q = norm(quote)
  if (!q) return false
  const a = ` ${norm(answer)} `
  if (!q.includes(' ') && q.length < 4) return false // one short word proves nothing
  return a.includes(` ${q} `) // whole words only
}
const half = (x: number) => Math.round(x * 2) / 2

/** Validate one pass against the rubric: unknown criteria → invalid; awards clamped; unsupported awards zeroed. */
export function checkPass(rubric: Criterion[], answer: string, pass: MarkingPass): { ok: boolean; total: number; perCriterion: Map<string, number>; issues: string[] } {
  const issues: string[] = []
  const per = new Map<string, number>()
  const ids = new Set(rubric.map((c) => c.id))
  if (pass.criteria.some((c) => !ids.has(c.id))) issues.push('marked a criterion that is not in the rubric')
  for (const c of rubric) {
    const m = pass.criteria.find((x) => x.id === c.id)
    if (!m) { issues.push(`criterion ${c.id} not marked`); per.set(c.id, 0); continue }
    let awarded = Number.isFinite(m.awarded) ? half(Math.min(c.points, Math.max(0, m.awarded))) : 0
    if (m.awarded > c.points || m.awarded < 0) issues.push(`criterion ${c.id} award out of range`)
    if (awarded > 0 && !(m.evidence ?? []).some((q) => quoteInAnswer(q, answer))) {
      issues.push(`criterion ${c.id} awarded without evidence found in the answer`)
      awarded = 0
    }
    per.set(c.id, awarded)
  }
  const total = [...per.values()].reduce((a, b) => a + b, 0)
  return { ok: !issues.some((i) => i.includes('not in the rubric') || i.includes('not marked')), total, perCriterion: per, issues }
}

/**
 * Two independent marking passes → final validated marks. The AI never sets the final mark alone:
 * evidence must be quoted from the answer, awards are clamped to the rubric, and the passes must agree
 * (within 15% of the maximum, at least 1 mark). Anything uncertain goes to educator review with a
 * conservative provisional mark (the lower pass), and no learner evidence is recorded until resolved.
 */
export function validateMarking(rubric: Criterion[], answer: string, passes: MarkingPass[]): ValidatedMark {
  const maxPoints = rubric.reduce((a, c) => a + c.points, 0)
  const base = (reasons: string[], points: number, chosen?: MarkingPass, per?: Map<string, number>): ValidatedMark => ({
    points, maxPoints, needsReview: reasons.length > 0, reasons,
    criteria: rubric.map((c) => {
      const m = chosen?.criteria.find((x) => x.id === c.id)
      return { id: c.id, criterion: c.criterion, points: c.points, awarded: per?.get(c.id) ?? 0, feedback: m?.feedback ?? '', missing: m?.missing ?? [], evidence: (m?.evidence ?? []).filter((q) => quoteInAnswer(q, answer)) }
    }),
    feedback: chosen?.overallFeedback ?? '', incorrectAssumptions: chosen?.incorrectAssumptions ?? [],
  })
  if (!norm(answer)) return base([], 0) // blank: zero, no AI judgement needed
  if (!passes.length) return base(['marking unavailable'], 0)
  const checked = passes.map((p) => ({ p, c: checkPass(rubric, answer, p) }))
  const reasons: string[] = []
  if (checked.some((x) => !x.c.ok)) reasons.push('marking did not follow the rubric')
  const totals = checked.map((x) => x.c.total)
  const spread = Math.max(...totals) - Math.min(...totals)
  if (passes.length >= 2 && spread > Math.max(1, 0.15 * maxPoints)) reasons.push(`independent markings disagree (${Math.min(...totals)} vs ${Math.max(...totals)} of ${maxPoints})`)
  // a criterion one pass awards fully and the other not at all is a real disagreement, even when totals are close
  // (seen live: a correct "2 m/s²" got 1 and 0 from the two passes and averaged to 0.5)
  if (checked.length >= 2) {
    const split = rubric.filter((c) => {
      const v = checked.map((x) => x.c.perCriterion.get(c.id) ?? 0)
      return Math.max(...v) - Math.min(...v) >= c.points
    })
    if (split.length) reasons.push(`independent markings disagree on: ${split.map((c) => c.criterion).join('; ').slice(0, 200)}`)
  }
  const conf = Math.min(...passes.map((p) => (Number.isFinite(p.confidence) ? p.confidence : 0)))
  if (conf < 0.6) reasons.push(`low marking confidence (${conf.toFixed(2)})`)
  if (passes.some((p) => p.ambiguous)) reasons.push('the answer is ambiguous')
  if (passes.some((p) => p.alternativeApproach)) reasons.push('uses an alternative approach — an educator should confirm it')
  const unsupported = checked.flatMap((x) => x.c.issues.filter((i) => i.includes('without evidence')))
  if (unsupported.length && checked.every((x) => x.c.issues.some((i) => i.includes('without evidence')))) reasons.push('marks were claimed without evidence in the answer')
  // final: mean of passes when they agree; otherwise the lower (conservative provisional) pass
  const lowest = checked.reduce((a, b) => (b.c.total < a.c.total ? b : a))
  if (reasons.length) return base(reasons, lowest.c.total, lowest.p, lowest.c.perCriterion)
  const per = new Map(rubric.map((c) => [c.id, half(checked.reduce((s, x) => s + (x.c.perCriterion.get(c.id) ?? 0), 0) / checked.length)]))
  const points = [...per.values()].reduce((a, b) => a + b, 0)
  return base([], Math.min(maxPoints, points), checked[0]!.p, per)
}

// ── results ──
export interface GradedResponse { itemId: string; conceptId: string; conceptName: string; type: ItemType; cognitive: Cognitive; points: number; maxPoints: number; needsReview: boolean; confidence: string | null }
export interface AttemptSummary {
  score: number; maxScore: number; percent: number | null; pendingReview: number
  byConcept: { conceptId: string; name: string; points: number; maxPoints: number; percent: number | null }[]
  byType: { type: ItemType; points: number; maxPoints: number; percent: number | null }[]
  strengths: string[]; weaknesses: string[]
  /** concepts answered well on recall/understand items but poorly on apply/transfer (memorised vs understood) */
  recallNotApplied: string[]
  confidentWrong: number
}
export function summarize(rs: GradedResponse[]): AttemptSummary {
  const pct = (p: number, m: number) => (m > 0 ? Math.round((p / m) * 1000) / 10 : null)
  const settled = rs.filter((r) => !r.needsReview)
  const sum = (xs: GradedResponse[]) => ({ points: xs.reduce((a, r) => a + r.points, 0), maxPoints: xs.reduce((a, r) => a + r.maxPoints, 0) })
  const concepts = [...new Map(rs.map((r) => [r.conceptId, r.conceptName])).entries()]
  const byConcept = concepts.map(([conceptId, name]) => { const s = sum(settled.filter((r) => r.conceptId === conceptId)); return { conceptId, name, ...s, percent: pct(s.points, s.maxPoints) } })
  const byType = [...new Set(rs.map((r) => r.type))].map((type) => { const s = sum(settled.filter((r) => r.type === type)); return { type, ...s, percent: pct(s.points, s.maxPoints) } })
  const recallNotApplied = concepts.filter(([cid]) => {
    const recall = sum(settled.filter((r) => r.conceptId === cid && (r.cognitive === 'recall' || r.cognitive === 'understand')))
    const apply = sum(settled.filter((r) => r.conceptId === cid && (r.cognitive === 'apply' || r.cognitive === 'transfer')))
    return recall.maxPoints > 0 && apply.maxPoints > 0 && recall.points / recall.maxPoints >= 0.75 && apply.points / apply.maxPoints < 0.5
  }).map(([, n]) => n)
  const total = sum(settled)
  return {
    score: total.points, maxScore: sum(rs).maxPoints, percent: pct(total.points, total.maxPoints), pendingReview: rs.length - settled.length,
    byConcept, byType,
    strengths: byConcept.filter((c) => c.percent !== null && c.percent >= 80 && c.maxPoints >= 2).map((c) => c.name),
    weaknesses: byConcept.filter((c) => c.percent !== null && c.percent < 50).map((c) => c.name),
    recallNotApplied,
    confidentWrong: settled.filter((r) => r.confidence === 'sure' && r.points < r.maxPoints * 0.5).length,
  }
}

// ── educator overrides ──
export interface MarkedCriterion { id: string; criterion: string; points: number; awarded: number; feedback: string; missing: string[]; evidence?: string[]; educatorAdjusted?: boolean }
/**
 * Apply an educator's criterion-level marks to a rubric answer. Every rubric criterion must be given, each within
 * 0..points in half marks; the total is always the sum, so the breakdown and the total can never disagree.
 * AI feedback/evidence is kept on each criterion; changed criteria are flagged `educatorAdjusted`.
 */
export function applyCriterionOverride(rubric: Criterion[], current: MarkedCriterion[] | null, input: { id: string; awarded: number }[]): { criteria: MarkedCriterion[]; points: number } | { problems: string[] } {
  const problems: string[] = []
  const given = new Map<string, number>()
  for (const x of input) {
    if (!rubric.some((c) => c.id === x?.id)) { problems.push(`unknown criterion ${String(x?.id)}`); continue }
    if (given.has(x.id)) problems.push(`criterion ${x.id} given twice`)
    given.set(x.id, Number(x.awarded))
  }
  const criteria = rubric.map((c): MarkedCriterion => {
    const prev = current?.find((x) => x.id === c.id)
    const v = given.get(c.id)
    if (v === undefined) { problems.push(`criterion ${c.id} has no mark`); return { id: c.id, criterion: c.criterion, points: c.points, awarded: 0, feedback: '', missing: [] } }
    if (!Number.isFinite(v) || v < 0 || v > c.points || (v * 2) % 1 !== 0) problems.push(`criterion ${c.id} must be 0-${c.points} in half marks`)
    return { id: c.id, criterion: c.criterion, points: c.points, awarded: v, feedback: prev?.feedback ?? '', missing: prev?.missing ?? [], evidence: prev?.evidence ?? [], educatorAdjusted: prev ? prev.awarded !== v : true }
  })
  if (problems.length) return { problems }
  return { criteria, points: criteria.reduce((a, c) => a + c.awarded, 0) }
}
