/** Developer product intelligence: deterministic recommendations from aggregate signals (pure; unit-tested).
 *  Every recommendation carries its evidence, sample size and a confidence; nothing is about an individual. */
export interface Signal { area: string; key: string; events: number; failures: number; users: number }
export type Confidence = 'low' | 'medium' | 'high'
export interface Recommendation { area: string; finding: string; evidence: string; n: number; confidence: Confidence; suggestion: string; severity: 'high' | 'medium' | 'low' }

export const confidenceFor = (n: number): Confidence => (n >= 100 ? 'high' : n >= 30 ? 'medium' : 'low')
const pct = (a: number, b: number) => Math.round((a / Math.max(1, b)) * 100)

const PHASE_ADVICE: Record<string, string> = {
  onboarding: 'Students leave while the tutor is still asking setup questions: shorten the questions or let them start learning before the profile is complete.',
  awaiting_approval: 'Students see a roadmap but do not approve it: make the plan shorter, show the first session first, or offer "start without a plan".',
  planning: 'Planning workflows stall: check the planning step failures in tool signals.',
}

export function recommend(signals: Signal[]): Recommendation[] {
  const out: Recommendation[] = []
  const conv = signals.find((s) => s.area === 'conversations')
  for (const s of signals) {
    if (s.area === 'tool' && s.events >= 10 && s.failures / s.events >= 0.2) {
      out.push({ area: 'Tools', finding: `"${s.key}" fails often`, evidence: `${s.failures} of ${s.events} calls failed (${pct(s.failures, s.events)}%) across ${s.users} students`, n: s.events, confidence: confidenceFor(s.events), suggestion: 'Inspect agent_tool_calls error codes for this tool and fix the most common one.', severity: s.failures / s.events >= 0.5 ? 'high' : 'medium' })
    }
    if (s.area === 'stalled' && s.key !== 'active' && conv && conv.events >= 10 && s.events / conv.events >= 0.15) {
      out.push({ area: 'Journey', finding: `Conversations stall in "${s.key}"`, evidence: `${s.events} of ${conv.events} conversations (${pct(s.events, conv.events)}%) had no activity for 2+ days in this phase`, n: conv.events, confidence: confidenceFor(conv.events), suggestion: PHASE_ADVICE[s.key] ?? 'Review this step of the journey.', severity: 'medium' })
    }
    if (s.area === 'studio' && s.key === 'activity' && s.events >= 20 && s.failures / s.events >= 0.6) {
      out.push({ area: 'Books', finding: 'Quick checks are mostly missed', evidence: `${s.failures} of ${s.events} quick-check answers were not correct (${pct(s.failures, s.events)}%)`, n: s.events, confidence: confidenceFor(s.events), suggestion: 'Explanations may move too fast or checks may be too hard: add a worked example before each check.', severity: 'low' })
    }
    if (s.area === 'ai_error' && (s.key === 'auth' || s.key === 'quota_exhausted' || s.key === 'no_eligible_route') && s.events > 0) {
      out.push({ area: 'AI service', finding: s.key === 'auth' ? 'AI provider rejects the key' : s.key === 'quota_exhausted' ? 'AI provider quota exhausted' : 'Some AI tasks have no model route', evidence: `${s.events} failed AI calls (${s.key})`, n: s.events, confidence: 'high', suggestion: s.key === 'auth' ? 'Rotate the provider key in Settings → AI keys.' : s.key === 'quota_exhausted' ? 'Raise the provider quota or add a fallback connection.' : 'Add a route for the affected category in the AI gateway.', severity: 'high' })
    }
    if (s.area === 'ai' && s.events >= 20 && s.failures / s.events >= 0.1) {
      out.push({ area: 'AI service', finding: `AI task "${s.key}" is unreliable`, evidence: `${s.failures} of ${s.events} calls failed (${pct(s.failures, s.events)}%)`, n: s.events, confidence: confidenceFor(s.events), suggestion: 'Check the error kinds; consider a fallback route or a smaller prompt.', severity: 'medium' })
    }
  }
  const rank = { high: 0, medium: 1, low: 2 }
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || b.n - a.n)
}
