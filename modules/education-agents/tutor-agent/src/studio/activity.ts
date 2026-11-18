/**
 * In-book quick checks (pure). These are FORMATIVE: their keys come from generated content, so results are never
 * learner evidence (mastery is untouched). Objective kinds are checked deterministically; 'explain' answers get
 * model feedback elsewhere. A wrong answer returns the hint (first time) or the explanation, and points back to
 * the block that teaches it.
 */
import type { Activity } from './blocks.ts'

export interface CheckResult { verdict: 'correct' | 'incorrect' | 'needs_feedback'; reveal: 'hint' | 'explanation' | 'none' }

const norm = (s: string) => s.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}.\-/^=+*() ]/gu, '').replace(/\s+/g, ' ').trim()

const leadingNumber = (s: string): number | null => {
  const m = /^\s*[-+]?\d+(\.\d+)?(e[-+]?\d+)?/i.exec(s.replace(/,/g, ''))
  return m ? Number(m[0]) : null
}

/**
 * Model-written multiple-choice keys are NOT trusted (live runs produced keys that contradicted their own
 * explanation). Decide whether to keep the check:
 *  - numeric options: the key must be the option matching `answerExpr` as evaluated by the maths service;
 *  - text options: the explanation must not name a different option while omitting the keyed one.
 * Returns the verified correct index, or null to drop the activity (fail closed).
 */
export function verifyMcqKey(a: Activity, evaluated: number | null): number | null {
  const opts = a.options ?? []
  const keyed = a.key?.correct?.[0]
  if (keyed === undefined || !opts[keyed]) return null
  const nums = opts.map(leadingNumber)
  if (nums.filter((n) => n !== null).length >= 2) {
    if (evaluated === null || !Number.isFinite(evaluated)) return null
    const tol = Math.max(1e-6, Math.abs(evaluated) * 1e-3)
    const match = nums.map((n, i) => (n !== null && Math.abs(n - evaluated) <= tol ? i : -1)).filter((i) => i >= 0)
    return match.length === 1 && match[0] === keyed ? keyed : null
  }
  const ex = norm(a.explanation ?? '')
  if (!ex) return keyed
  const mentions = opts.map((o) => norm(o).length >= 4 && ex.includes(norm(o)))
  return mentions.some((m, i) => m && i !== keyed) && !mentions[keyed] ? null : keyed
}

export function checkActivity(a: Activity, answer: unknown, previousWrong: number): CheckResult {
  const wrong = (): CheckResult => ({ verdict: 'incorrect', reveal: previousWrong >= 1 || !a.hint ? 'explanation' : 'hint' })
  const k = a.key ?? {}
  if (a.kind === 'mcq') {
    const i = Number(answer)
    return Number.isInteger(i) && k.correct?.includes(i) ? { verdict: 'correct', reveal: 'explanation' } : wrong()
  }
  if (a.kind === 'numeric') {
    const s = typeof answer === 'number' ? String(answer) : String(answer ?? '').replace(/,/g, '').trim()
    const m = /^[-+]?\d*\.?\d+(e[-+]?\d+)?/i.exec(s)
    if (!m || k.value === undefined) return wrong()
    return Math.abs(Number(m[0]) - k.value) <= (k.tolerance ?? 0) + 1e-9 ? { verdict: 'correct', reveal: 'explanation' } : wrong()
  }
  if (a.kind === 'short') {
    const v = norm(String(answer ?? ''))
    return v && (k.accept ?? []).some((x) => norm(x) === v) ? { verdict: 'correct', reveal: 'explanation' } : wrong()
  }
  return String(answer ?? '').trim().length >= 3 ? { verdict: 'needs_feedback', reveal: 'none' } : wrong()
}
