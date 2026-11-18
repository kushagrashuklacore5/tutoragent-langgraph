import { masteryView, type MasteryEstimate } from '../lib/tutor.ts'

/** Mastery chip with a confidence ring (arc = estimate, faint band = 95% range). Text always states the meaning. */
export function MasteryChip({ m, compact }: { m: Pick<MasteryEstimate, 'state' | 'pMastery' | 'low' | 'high'>; compact?: boolean }) {
  const v = masteryView(m)
  const r = 9
  const C = 2 * Math.PI * r
  const insufficient = v.percent === null
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-2 py-1 text-[0.8rem]">
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden className="shrink-0 -rotate-90">
        <circle cx="12" cy="12" r={r} fill="none" stroke="var(--color-line-strong)" strokeWidth="3" strokeDasharray={insufficient ? '2 2.5' : undefined} />
        {!insufficient ? (
          <>
            <circle cx="12" cy="12" r={r} fill="none" stroke={`var(--color-mastery-${v.level})`} strokeOpacity="0.28" strokeWidth="3"
              strokeDasharray={`${(m.high - m.low) * C} ${C}`} strokeDashoffset={-m.low * C} />
            <circle cx="12" cy="12" r={r} fill="none" stroke={`var(--color-mastery-${v.level})`} strokeWidth="3" strokeLinecap="round" strokeDasharray={`${m.pMastery * C} ${C}`} />
          </>
        ) : null}
      </svg>
      <span className="font-semibold text-fg">{v.label}</span>
      {!compact && v.percent !== null ? <span className="text-muted">~{v.percent}% <span className="sr-only">estimated, likely range</span><span aria-hidden>(</span>{v.range}<span aria-hidden>)</span></span> : null}
    </span>
  )
}
