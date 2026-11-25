/** Intake helpers (pure). A question with `showIf` appears only when the answer it depends on matches. */
export interface IntakeQ { slot: string; label: string; options: { value: string; label: string }[]; default: string | null; required: boolean; allowCustom: boolean; showIf?: { slot: string; in: string[] } }
export const CUSTOM = '__custom'
export const visibleQuestions = <Q extends IntakeQ>(qs: Q[], answers: Record<string, string>): Q[] => qs.filter((q) => !q.showIf || q.showIf.in.includes(answers[q.showIf.slot] ?? ''))
/** what is sent: one answer per visible question (an option value or the student's own words); blanks are left out */
export function intakePayload(qs: IntakeQ[], answers: Record<string, string>, custom: Record<string, string>): { answers: Record<string, string>; summary: string; missing: string[] } {
  const out: Record<string, string> = {}
  const said: string[] = []
  const missing: string[] = []
  for (const q of visibleQuestions(qs, answers)) {
    const a = answers[q.slot] === CUSTOM ? (custom[q.slot] ?? '').trim() : answers[q.slot] ?? ''
    if (!a) { if (q.required) missing.push(q.slot); continue }
    out[q.slot] = a
    said.push(q.options.find((o) => o.value === a)?.label ?? a)
  }
  return { answers: out, summary: said.join(' · ') || 'Start learning', missing }
}
