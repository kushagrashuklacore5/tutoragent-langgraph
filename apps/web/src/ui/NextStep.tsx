import { Link } from 'react-router'
import { TUTOR, api } from '../lib/api.ts'
import { Icon } from './icons.tsx'
import { useLoad } from './kit.tsx'

export type NextAction = 'revise_due_cards' | 'repair_misconception' | 'review_prerequisite' | 'diagnostic_practice' | 'guided_practice'
  | 'independent_practice' | 'transfer_challenge' | 'learn_new' | 'refresh_fading' | 'advanced_challenge'
export interface Recommendation { action: NextAction; conceptId: string | null; conceptName: string | null; reason: string; minutes: number }
export interface CoachResponse { next: Recommendation; dueCards: number; examAt: string | null }

const LABEL: Record<NextAction, string> = {
  revise_due_cards: 'Review your due cards', repair_misconception: 'Fix a recurring mistake', review_prerequisite: 'Shore up a foundation',
  diagnostic_practice: 'Quick check', guided_practice: 'Guided practice', independent_practice: 'Practise on your own',
  transfer_challenge: 'Try it somewhere new', learn_new: 'Learn something new', refresh_fading: 'Refresh before it fades', advanced_challenge: 'Take on a challenge',
}

/** Where each recommendation is carried out. */
export function actionHref(base: string, r: Recommendation): string {
  const q = r.conceptId ? `?conceptId=${r.conceptId}` : ''
  switch (r.action) {
    case 'revise_due_cards': return `${base}/revision`
    case 'repair_misconception': case 'review_prerequisite': case 'learn_new': return `${base}/tutor${q}`
    default: return `${base}/practice${q}`
  }
}

/** The single recommended next learning step for this course, with the reason it was chosen. */
export function NextStep({ courseId, base }: { courseId: string; base: string }) {
  const c = useLoad(`coach:${courseId}`, (sig) => api.get<CoachResponse>(`${TUTOR}/courses/${courseId}/coach`, sig))
  if (c.loading || c.error || !c.data) return null
  const r = c.data.next
  return (
    <section aria-labelledby="next-h" className="mb-6 rounded-xl border border-line bg-surface p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">Recommended next · about {r.minutes} min</p>
      <h2 id="next-h" className="mt-1 text-lg font-semibold">{LABEL[r.action]}{r.conceptName ? `: ${r.conceptName}` : ''}</h2>
      <p className="mt-1 text-fg-soft">{r.reason}</p>
      <Link to={actionHref(base, r)} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-lg bg-accent px-4 font-semibold text-on-accent">Start <Icon name="right" size={16} /></Link>
    </section>
  )
}
