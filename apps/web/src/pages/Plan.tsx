import { useState, type FormEvent } from 'react'
import { TUTOR, api } from '../lib/api.ts'
import { prefs } from '../lib/storage.ts'
import { TASK_KIND_LABEL, countdownText, daysUntil, formatDay, missedMinutes, taskKey, weekOf, ymd, type Plan as PlanT } from '../lib/tutor.ts'
import { useMe } from '../session.tsx'
import { Icon } from '../ui/icons.tsx'
import { Button, Card, EmptyState, ErrorNote, Field, Notice, PageHeader, inputCls, useAction } from '../ui/kit.tsx'
import { useCourse } from './CourseLayout.tsx'

const addDays = (d: string, n: number) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y!, m! - 1, dd! + n)).toISOString().slice(0, 10) }

export default function Plan() {
  const course = useCourse()
  const me = useMe()
  const goal0 = prefs.goal(me.userId, course.id)
  const [plan, setPlan] = useState<PlanT | null>(() => prefs.plan(me.userId, course.id))
  const [examAt, setExamAt] = useState(goal0?.examAt ?? '')
  const [daily, setDaily] = useState(goal0?.dailyMinutes ?? 45)
  const [savedDaily, setSavedDaily] = useState(goal0?.dailyMinutes ?? null)
  const [done, setDone] = useState(() => prefs.doneTasks(me.userId, course.id))
  const today = ymd(new Date())
  const [weekStart, setWeekStart] = useState(today)
  const a = useAction()

  const generate = async (missed = 0) => {
    const r = await a.run(async () => {
      await api.put(`${TUTOR}/courses/${course.id}/goal`, { examAt: examAt || null, dailyMinutes: daily })
      prefs.setGoal(me.userId, course.id, { examAt: examAt || null, dailyMinutes: daily })
      setSavedDaily(daily)
      return api.post<PlanT>(`${TUTOR}/courses/${course.id}/plan`, missed ? { missedMinutes: missed } : {})
    })
    if (r) {
      prefs.setPlan(me.userId, course.id, r)
      setPlan(r)
      const cleared = new Set<string>()
      prefs.setDoneTasks(me.userId, course.id, cleared)
      setDone(cleared)
      setWeekStart(today)
    }
  }
  const submit = (e: FormEvent) => { e.preventDefault(); void generate() }
  const toggle = (k: string) => {
    const next = new Set(done)
    if (next.has(k)) next.delete(k); else next.add(k)
    setDone(next)
    prefs.setDoneTasks(me.userId, course.id, next)
  }

  const missed = plan ? missedMinutes(plan.tasks, today, done) : 0
  const week = plan ? weekOf(plan.tasks, weekStart) : []
  const cap = savedDaily ?? daily
  const exam = examAt ? daysUntil(examAt) : null

  return (
    <>
      <PageHeader title="Plan" eyebrow={`${course.code}${exam !== null ? ` · ${countdownText(exam)}` : ''}`} />
      <div className="grid gap-6 xl:grid-cols-[20rem_minmax(0,1fr)]">
        <Card className="h-fit">
          <form onSubmit={submit} className="grid gap-4">
            <h2 className="text-lg font-semibold">Your goal</h2>
            <Field id="plan-exam" label="Exam date" hint="Optional. Without one we plan two weeks ahead.">
              <input id="plan-exam" type="date" min={today} value={examAt} onChange={(e) => setExamAt(e.target.value)} className={inputCls} aria-describedby="plan-exam-hint" />
            </Field>
            <Field id="plan-daily" label={`Daily study time: ${daily} min`}>
              <input id="plan-daily" type="range" min={10} max={240} step={5} value={daily} onChange={(e) => setDaily(Number(e.target.value))} className="w-full accent-[var(--color-accent)]" />
            </Field>
            {a.error ? <ErrorNote error={a.error} /> : null}
            <Button type="submit" variant="primary" icon="refresh" busy={a.busy}>{plan ? 'Regenerate plan' : 'Make my plan'}</Button>
            <p className="text-xs text-muted">Plans are built by fixed rules, not AI: exam weight × how much is left to learn, prerequisites first, within your daily time.</p>
          </form>
        </Card>

        <section aria-labelledby="week-h" className="min-w-0">
          {!plan ? (
            <EmptyState icon="calendar" title="No plan yet">Set your goal and we will lay out what to study each day.</EmptyState>
          ) : (
            <>
              {missed > 0 ? (
                <div className="mb-4">
                  <Notice tone="warn" title={`You have ${missed} minutes of unfinished work from earlier days`}>
                    <p>We can move it forward without overloading you (at most 25% above your daily time).</p>
                    <Button className="mt-2" icon="refresh" busy={a.busy} onClick={() => void generate(missed)}>Re-plan from today</Button>
                  </Notice>
                </div>
              ) : null}
              <div className="mb-3 flex items-center justify-between gap-2">
                <h2 id="week-h" className="text-lg font-semibold">Week of {formatDay(weekStart, { day: 'numeric', month: 'short' })}</h2>
                <div className="flex gap-1">
                  <button type="button" onClick={() => setWeekStart(addDays(weekStart, -7))} className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-line-strong bg-surface" aria-label="Previous week"><Icon name="left" /></button>
                  <button type="button" onClick={() => setWeekStart(today)} className="min-h-11 rounded-lg border border-line-strong bg-surface px-3 text-sm font-semibold">Today</button>
                  <button type="button" onClick={() => setWeekStart(addDays(weekStart, 7))} className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-line-strong bg-surface" aria-label="Next week"><Icon name="right" /></button>
                </div>
              </div>
              <ol className="grid gap-2 md:grid-cols-2 2xl:grid-cols-7">
                {week.map((d) => {
                  const over = d.minutes > cap
                  return (
                    <li key={d.date} className={`rounded-xl border bg-surface p-3 ${d.date === today ? 'border-accent' : 'border-line'}`}>
                      <div className="flex items-baseline justify-between gap-2">
                        <h3 className="font-semibold">{formatDay(d.date)}{d.date === today ? <span className="ml-1 text-xs font-semibold text-accent">Today</span> : null}</h3>
                        <span className={`text-xs ${over ? 'font-semibold text-warn' : 'text-muted'}`}>{d.minutes}/{cap} min{over ? ' · over' : ''}</span>
                      </div>
                      <div className="my-2 h-1.5 rounded-full bg-line" role="meter" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={d.minutes} aria-label={`Load ${d.minutes} of ${cap} minutes`}>
                        <div className={`h-1.5 rounded-full ${over ? 'bg-warn' : 'bg-accent'}`} style={{ width: `${Math.min(100, (d.minutes / cap) * 100)}%` }} />
                      </div>
                      {d.tasks.length ? (
                        <ul className="space-y-1">
                          {d.tasks.map((t) => {
                            const k = taskKey(t)
                            return (
                              <li key={k}>
                                <label className="flex min-h-11 cursor-pointer items-start gap-2 py-1 text-sm">
                                  <input type="checkbox" checked={done.has(k)} onChange={() => toggle(k)} className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" />
                                  <span className={done.has(k) ? 'text-muted line-through' : ''}><span className="font-semibold">{TASK_KIND_LABEL[t.kind]}</span> · {t.kind === 'review' ? 'Spaced revision' : t.conceptName} <span className="text-muted">({t.minutes} min)</span></span>
                                </label>
                              </li>
                            )
                          })}
                        </ul>
                      ) : <p className="text-sm text-muted">Free</p>}
                    </li>
                  )
                })}
              </ol>
              {plan.dropped.length ? (
                <div className="mt-4"><Notice tone="warn" title="Did not fit">{plan.dropped.length} concept{plan.dropped.length === 1 ? '' : 's'} could not be scheduled: {plan.dropped.map((d) => d.reason).filter((v, i, arr) => arr.indexOf(v) === i).join('; ')}.</Notice></div>
              ) : null}
              <details className="mt-4 rounded-xl border border-line bg-surface p-4">
                <summary className="cursor-pointer font-semibold">Why this plan</summary>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-fg-soft">{plan.rationale.map((r, i) => <li key={i}>{r}</li>)}</ul>
              </details>
            </>
          )}
        </section>
      </div>
    </>
  )
}
