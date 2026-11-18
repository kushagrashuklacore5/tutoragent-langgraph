/**
 * Exam intelligence (pure). Turns questions extracted from real papers into transparent topic priorities.
 * Two kinds of statement are kept apart:
 *   - VERIFIED: counted facts ("appeared in 3 of 4 board papers, avg 4.3 marks") with the papers named;
 *   - ESTIMATE: a priority score mixing that frequency with exam weight and the student's mastery gap.
 * Nothing here says a question WILL appear. With no papers, priorities fall back to syllabus weight with low confidence.
 */
export type SourceKind = 'board_past_paper' | 'board_sample_paper' | 'school_paper' | 'textbook_exercise' | 'other'
export interface PaperFact { id: string; title: string; kind: SourceKind; year: number | null; school: string | null }
export interface QuestionFact { paperId: string; conceptId: string | null; marks: number | null; qtype: string; features: string[] }
export interface TopicFact { id: string; name: string; examWeight: number; pMastery: number }

/** papers that count as exam evidence (textbook exercises show question styles, not exam frequency) */
export const EXAM_KINDS: SourceKind[] = ['board_past_paper', 'board_sample_paper', 'school_paper']

export interface TopicPattern {
  conceptId: string; name: string
  papersWith: number; papersTotal: number; questions: number; avgMarks: number | null; marksShare: number
  types: Record<string, number>; features: string[]
  /** recent half of papers vs older half: 'rising' | 'falling' | 'steady' | 'new' | 'unknown' */
  trend: 'rising' | 'falling' | 'steady' | 'new' | 'unknown'
  verified: string
  priority: number
  confidence: 'high' | 'medium' | 'low'
  reasons: string[]
}

const r2 = (x: number) => Math.round(x * 100) / 100

export function analysePatterns(o: { topics: TopicFact[]; papers: PaperFact[]; questions: QuestionFact[]; scope?: 'board' | 'school' | 'all' }): { topics: TopicPattern[]; papersUsed: PaperFact[]; unmatchedQuestions: number; note: string } {
  const scope = o.scope ?? 'all'
  const papers = o.papers.filter((p) => EXAM_KINDS.includes(p.kind) && (scope === 'all' || (scope === 'school' ? p.kind === 'school_paper' : p.kind !== 'school_paper')))
  const ids = new Set(papers.map((p) => p.id))
  const qs = o.questions.filter((q) => ids.has(q.paperId))
  const totalMarks = qs.reduce((n, q) => n + (q.marks ?? 0), 0)
  // chronological halves for trend (papers without a year are not used for trend)
  const dated = papers.filter((p) => p.year !== null).sort((a, b) => a.year! - b.year!)
  const half = Math.floor(dated.length / 2)
  const older = new Set(dated.slice(0, half).map((p) => p.id))
  const recent = new Set(dated.slice(dated.length - half).map((p) => p.id))
  const maxWeight = Math.max(1, ...o.topics.map((t) => t.examWeight))
  const topics = o.topics.map((t): TopicPattern => {
    const mine = qs.filter((q) => q.conceptId === t.id)
    const withIt = new Set(mine.map((q) => q.paperId))
    const marks = mine.map((q) => q.marks).filter((m): m is number => m !== null)
    const types: Record<string, number> = {}
    for (const q of mine) types[q.qtype] = (types[q.qtype] ?? 0) + 1
    const features = [...new Set(mine.flatMap((q) => q.features))].slice(0, 6)
    let trend: TopicPattern['trend'] = 'unknown'
    if (half >= 1) {
      const inOld = [...withIt].filter((id) => older.has(id)).length / half
      const inNew = [...withIt].filter((id) => recent.has(id)).length / half
      trend = inOld === 0 && inNew > 0 ? 'new' : inNew - inOld >= 0.34 ? 'rising' : inOld - inNew >= 0.34 ? 'falling' : 'steady'
    }
    const freq = papers.length ? withIt.size / papers.length : 0
    const marksShare = totalMarks ? mine.reduce((n, q) => n + (q.marks ?? 0), 0) / totalMarks : 0
    const gap = 1 - t.pMastery
    // estimate: evidence when papers exist, syllabus weight otherwise; the mastery gap decides what is worth time NOW
    const base = papers.length ? 0.55 * freq + 0.25 * Math.min(1, marksShare * 4) + 0.2 * (t.examWeight / maxWeight) : t.examWeight / maxWeight
    const priority = r2(base * (0.4 + 0.6 * gap))
    const confidence: TopicPattern['confidence'] = papers.length >= 4 ? 'high' : papers.length >= 2 ? 'medium' : 'low'
    const reasons: string[] = []
    if (papers.length) reasons.push(`In ${withIt.size} of ${papers.length} paper(s)`)
    else reasons.push('No past papers yet: based on syllabus weight only')
    if (marks.length) reasons.push(`about ${r2(marks.reduce((a, b) => a + b, 0) / marks.length)} marks per question`)
    if (trend === 'rising' || trend === 'new') reasons.push('appears more in recent papers (a pattern, not a guarantee)')
    if (trend === 'falling') reasons.push('appears less in recent papers')
    if (gap > 0.5) reasons.push('you have not secured it yet')
    return {
      conceptId: t.id, name: t.name, papersWith: withIt.size, papersTotal: papers.length, questions: mine.length, avgMarks: marks.length ? r2(marks.reduce((a, b) => a + b, 0) / marks.length) : null,
      marksShare: r2(marksShare), types, features, trend,
      verified: papers.length ? `Appeared in ${withIt.size} of ${papers.length} paper(s): ${papers.filter((p) => withIt.has(p.id)).map((p) => p.title).join('; ') || 'none'}` : 'No verified past-paper evidence',
      priority, confidence, reasons,
    }
  }).sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name))
  return {
    topics, papersUsed: papers, unmatchedQuestions: qs.filter((q) => !q.conceptId).length,
    note: papers.length ? 'Frequencies are counted from the papers listed. Priorities are estimates; no question is guaranteed to appear.' : 'No past or sample papers have been added. Upload papers (yours or your school\'s) to see verified patterns; until then priorities use the syllabus weights.',
  }
}

/** School vs board: topics whose share of questions differs noticeably between the two. */
export function compareSchoolBoard(o: { topics: TopicFact[]; papers: PaperFact[]; questions: QuestionFact[] }): { conceptId: string; name: string; schoolShare: number; boardShare: number; note: string }[] {
  const share = (kinds: SourceKind[]) => {
    const ids = new Set(o.papers.filter((p) => kinds.includes(p.kind)).map((p) => p.id))
    const qs = o.questions.filter((q) => ids.has(q.paperId))
    return (cid: string) => (qs.length ? qs.filter((q) => q.conceptId === cid).length / qs.length : 0)
  }
  const school = share(['school_paper'])
  const board = share(['board_past_paper', 'board_sample_paper'])
  const hasBoth = o.papers.some((p) => p.kind === 'school_paper') && o.papers.some((p) => p.kind !== 'school_paper' && EXAM_KINDS.includes(p.kind))
  if (!hasBoth) return []
  return o.topics.map((t) => ({ conceptId: t.id, name: t.name, schoolShare: r2(school(t.id)), boardShare: r2(board(t.id)) }))
    .filter((x) => Math.abs(x.schoolShare - x.boardShare) >= 0.1)
    .map((x) => ({ ...x, note: x.schoolShare > x.boardShare ? 'your school asks this more than the board papers' : 'the board papers ask this more than your school' }))
}

/** Question distribution for a pattern-aligned practice paper: top-priority topics, counts proportional to priority. */
export function practiceBlueprint(patterns: TopicPattern[], totalQuestions: number): { conceptId: string; name: string; count: number }[] {
  const top = patterns.filter((p) => p.priority > 0).slice(0, 6)
  const sum = top.reduce((n, p) => n + p.priority, 0)
  if (!sum) return []
  const raw = top.map((p) => ({ conceptId: p.conceptId, name: p.name, exact: (p.priority / sum) * totalQuestions }))
  const out = raw.map((x) => ({ conceptId: x.conceptId, name: x.name, count: Math.max(1, Math.floor(x.exact)) }))
  let left = totalQuestions - out.reduce((n, x) => n + x.count, 0)
  for (const x of [...raw].sort((a, b) => (b.exact % 1) - (a.exact % 1))) { if (left <= 0) break; out.find((y) => y.conceptId === x.conceptId)!.count++; left-- }
  return out.filter((x) => x.count > 0)
}
