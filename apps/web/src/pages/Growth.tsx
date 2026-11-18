import { useState } from 'react'
import { TUTOR, api } from '../lib/api.ts'
import { useSession } from '../session.tsx'
import { Button, Card, ErrorNote, Field, Loading, Notice, PageHeader, inputCls, useAction, useLoad } from '../ui/kit.tsx'

interface Metric { value: number | null; n: number; note?: string }
interface GrowthView {
  xp: number; xpBreakdown: { reason: string; xp: number }[]
  levels: { conceptId: string; name: string; level: number; label: string; pMastery: number }[]; levelNames: string[]
  streak: { days: number; restDaysUsed: number; studiedThisWeek: number }
  badges: { id: string; title: string; why: string }[]
  personalBests: { assessmentId: string; title: string; best: number; latest: number; attempts: number; improved: boolean }[]
  improvementPoints: number
  prefs: { leaderboard: boolean; pseudonym: string | null; outcomesConsent: boolean }
  leaderboard: { visible: boolean; rows: { rank: number; pseudonym: string; improvementPoints: number; me: boolean }[] }
  outcomes: { diagnostic: Metric; postLearning: Metric; change: Metric; delayedRetention: Metric; transfer: Metric; repeatedMistakes: { before: Metric; after: Metric }; independence: { before: Metric; after: Metric }; calibration: Metric; planCompletion: Metric; caveats: string[] }
}
const pct = (m: Metric) => (m.value === null ? '—' : `${Math.round(m.value * 100)}%`)

/** Growth: progress you earned, compared only with your own past. */
export default function Growth() {
  const s = useSession()
  const courses = s.courses.filter((c) => c.role === 'student')
  const [courseId, setCourseId] = useState(courses[0]?.id ?? '')
  const v = useLoad<GrowthView>(courseId ? `growth:${courseId}` : null, (sig) => api.get(`${TUTOR}/courses/${courseId}/growth`, sig))
  if (!courseId) return <Notice title="No courses yet">Join a course as a student to see your growth.</Notice>
  if (v.loading && !v.data) return <Loading />
  if (v.error || !v.data) return <ErrorNote error={v.error} retry={v.reload} />
  const g = v.data
  const o = g.outcomes
  return (
    <div className="mx-auto grid max-w-5xl gap-5">
      <PageHeader title="Your growth" eyebrow="Compared with you, not with others">
        {courses.length > 1 ? <select aria-label="Course" value={courseId} onChange={(e) => setCourseId(e.target.value)} className={`${inputCls} w-auto`}>{courses.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}</select> : null}
      </PageHeader>
      <div className="grid gap-4 sm:grid-cols-3">
        <Card><p className="text-xs uppercase tracking-wide text-muted">Learning XP</p><p className="font-serif text-4xl">{g.xp}</p><p className="text-xs text-muted">earned by understanding, not speed</p></Card>
        <Card><p className="text-xs uppercase tracking-wide text-muted">Study streak</p><p className="font-serif text-4xl">{g.streak.days} <span className="text-base">days</span></p><p className="text-xs text-muted">{g.streak.restDaysUsed ? `${g.streak.restDaysUsed} rest day(s) included — rest is part of learning` : 'up to 2 rest days a week never break it'}</p></Card>
        <Card><p className="text-xs uppercase tracking-wide text-muted">Improvement points</p><p className="font-serif text-4xl">{g.improvementPoints}</p><p className="text-xs text-muted">gains over your own previous best</p></Card>
      </div>

      <Card>
        <h2 className="mb-3 font-semibold">Topic levels</h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {g.levels.map((l) => (
            <li key={l.conceptId} className="flex items-center gap-3">
              <span className="min-w-0 flex-1 truncate text-sm">{l.name}</span>
              <span className="flex gap-1" aria-label={`${l.label}, level ${l.level} of 4`}>{[1, 2, 3, 4].map((i) => <span key={i} className={`h-2 w-6 rounded-full ${i <= l.level ? 'bg-accent' : 'bg-line'}`} />)}</span>
              <span className="w-20 text-right text-xs text-muted">{l.label}</span>
            </li>
          ))}
        </ul>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 font-semibold">Before and after</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt>Starting-point check</dt><dd>{pct(o.diagnostic)}</dd>
            <dt>Latest after-learning test</dt><dd>{pct(o.postLearning)}</dd>
            <dt>Change</dt><dd>{o.change.value === null ? '—' : `${o.change.value >= 0 ? '+' : ''}${Math.round(o.change.value * 100)} points`}</dd>
            <dt>Solved on your own</dt><dd>{pct(o.independence.before)} → {pct(o.independence.after)} <span className="text-xs text-muted">(n={o.independence.before.n}/{o.independence.after.n})</span></dd>
            <dt>Repeated mistakes</dt><dd>{o.repeatedMistakes.before.value ?? '—'} → {o.repeatedMistakes.after.value ?? '—'}</dd>
            <dt>New-situation questions</dt><dd>{pct(o.transfer)} <span className="text-xs text-muted">(n={o.transfer.n})</span></dd>
            <dt>Remembered weeks later</dt><dd>{pct(o.delayedRetention)} <span className="text-xs text-muted">(n={o.delayedRetention.n})</span></dd>
            <dt>"Sure" matched being right</dt><dd>{pct(o.calibration)} <span className="text-xs text-muted">(n={o.calibration.n})</span></dd>
            <dt>Plan milestones done</dt><dd>{pct(o.planCompletion)}</dd>
          </dl>
          <ul className="mt-3 list-disc pl-5 text-xs text-muted">{o.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
        </Card>
        <Card>
          <h2 className="mb-3 font-semibold">Personal bests</h2>
          {g.personalBests.length ? <ul className="grid gap-2 text-sm">{g.personalBests.map((b) => <li key={b.assessmentId} className="flex justify-between gap-2"><span className="truncate">{b.title}</span><span>best {Math.round(b.best * 100)}% · latest {Math.round(b.latest * 100)}%{b.improved ? ' ↑' : ''}</span></li>)}</ul> : <p className="text-sm text-muted">Take a test to start your scorecard.</p>}
          <h2 className="mb-2 mt-5 font-semibold">Badges</h2>
          {g.badges.length ? <ul className="flex flex-wrap gap-2">{g.badges.map((b) => <li key={b.id} className="rounded-full border border-line px-3 py-1 text-sm" title={b.why}>🏅 {b.title}</li>)}</ul> : <p className="text-sm text-muted">Badges reward independence, comebacks, steady weeks and remembering — not speed.</p>}
          <h2 className="mb-2 mt-5 font-semibold">Where your XP came from</h2>
          <ul className="grid gap-1 text-sm">{g.xpBreakdown.slice(0, 6).map((x) => <li key={x.reason} className="flex justify-between"><span>{x.reason}</span><span className="tabular-nums">+{x.xp}</span></li>)}</ul>
        </Card>
      </div>
      <Prefs prefs={g.prefs} board={g.leaderboard} onSaved={v.reload} />
    </div>
  )
}

function Prefs({ prefs, board, onSaved }: { prefs: GrowthView['prefs']; board: GrowthView['leaderboard']; onSaved: () => void }) {
  const [on, setOn] = useState(prefs.leaderboard)
  const [nick, setNick] = useState(prefs.pseudonym ?? '')
  const [consent, setConsent] = useState(prefs.outcomesConsent)
  const a = useAction()
  return (
    <Card className="grid gap-3">
      <h2 className="font-semibold">Sharing (optional)</h2>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} className="accent-[var(--color-accent)]" />Join the class improvement board under a nickname (shows improvement only, never marks; hidden until 5 classmates join)</label>
      {on ? <Field id="nick" label="Nickname (not your real name)"><input id="nick" value={nick} onChange={(e) => setNick(e.target.value)} maxLength={40} className={`${inputCls} max-w-xs`} /></Field> : null}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="accent-[var(--color-accent)]" />Include my results in anonymous class averages for my educator (only shown for groups of 5 or more)</label>
      {a.error ? <ErrorNote error={a.error} /> : null}
      <Button className="justify-self-start" busy={a.busy} onClick={() => void a.run(() => api.put(`${TUTOR}/growth/prefs`, { leaderboard: on, pseudonym: nick || null, outcomesConsent: consent })).then((r) => { if (r !== undefined) onSaved() })}>Save</Button>
      {prefs.leaderboard ? (board.visible ? <ol className="grid gap-1 text-sm">{board.rows.map((r) => <li key={r.rank} className={r.me ? 'font-semibold' : ''}>{r.rank}. {r.pseudonym} — {r.improvementPoints} improvement points</li>)}</ol> : <p className="text-sm text-muted">The board appears once at least 5 classmates have joined.</p>) : null}
    </Card>
  )
}
