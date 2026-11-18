import { useState } from 'react'
import { useNavigate } from 'react-router'
import { TUTOR, api } from '../lib/api.ts'
import { prefs } from '../lib/storage.ts'
import { LANGUAGES, type Language, type Plan } from '../lib/tutor.ts'
import { useMe, useSession } from '../session.tsx'
import { Button, Card, EmptyState, ErrorNote, Field, PageHeader, inputCls, useAction } from '../ui/kit.tsx'

const STEPS = ['Your data', 'Course', 'Goal', 'Language']

export default function Onboarding() {
  const s = useSession()
  const me = useMe()
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [courseId, setCourseId] = useState(s.courses.find((c) => c.role === 'student')?.id ?? s.courses[0]?.id ?? '')
  const [examAt, setExamAt] = useState('')
  const [daily, setDaily] = useState(45)
  const [language, setLanguage] = useState<Language>(prefs.language())
  const a = useAction()

  const finish = async (withGoal: boolean) => {
    prefs.setLanguage(language)
    if (withGoal && courseId) {
      const ok = await a.run(async () => {
        await api.put(`${TUTOR}/courses/${courseId}/goal`, { examAt: examAt || null, dailyMinutes: daily })
        prefs.setGoal(me.userId, courseId, { examAt: examAt || null, dailyMinutes: daily })
        const plan = await api.post<Plan>(`${TUTOR}/courses/${courseId}/plan`, {})
        prefs.setPlan(me.userId, courseId, plan)
        return true
      })
      if (!ok) return
    }
    prefs.setOnboarded(me.userId)
    navigate('/', { replace: true })
  }

  const today = new Date().toISOString().slice(0, 10)
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Set up your study desk" eyebrow={`Step ${step + 1} of ${STEPS.length} · ${STEPS[step]}`} />
      <ol className="mb-6 grid grid-cols-4 gap-2" aria-label="Progress">
        {STEPS.map((n, i) => (
          <li key={n} className="flex flex-col gap-1">
            <span className={`h-1.5 rounded-full ${i <= step ? 'bg-accent' : 'bg-line-strong'}`} aria-hidden />
            <span className={`text-xs ${i === step ? 'font-semibold text-fg' : 'text-muted'}`}>{n}{i < step ? <span className="sr-only"> (done)</span> : i === step ? <span className="sr-only"> (current)</span> : null}</span>
          </li>
        ))}
      </ol>

      <Card>
        {step === 0 ? (
          <div className="space-y-3 text-fg-soft">
            <h2 className="text-lg font-semibold text-fg">What we store, in plain words</h2>
            <ul className="list-disc space-y-1.5 pl-5">
              <li>Your answers, tutor conversations, flashcards and plan — to estimate what you know and plan your study.</li>
              <li>Your institution can see course membership. Educators of a course you take can see your practice results, mastery and revision progress for that course, so they can support you. Your tutor conversations and your uploaded notes stay private to you.</li>
              <li>AI models process your messages to reply. Your data is not used to train models.</li>
              <li>You can download or delete your data from Settings at any time.</li>
            </ul>
            <p className="text-sm text-muted">Optional uses (research, model improvement) are off and stay off unless you turn them on.</p>
            <div className="flex flex-wrap gap-2 pt-2">
              <Button variant="primary" onClick={() => setStep(1)}>I understand, continue</Button>
            </div>
          </div>
        ) : step === 1 ? (
          s.courses.length ? (
            <fieldset className="space-y-2">
              <legend className="mb-2 text-lg font-semibold">Which course do you want to plan first?</legend>
              {s.courses.map((c) => (
                <label key={c.id} className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-3 ${courseId === c.id ? 'border-accent bg-src-course-bg' : 'border-line'}`}>
                  <input type="radio" name="course" value={c.id} checked={courseId === c.id} onChange={() => setCourseId(c.id)} className="h-4 w-4 accent-[var(--color-accent)]" />
                  <span><span className="font-mono text-sm text-muted">{c.code}</span> {c.title}{c.term ? <span className="text-muted"> · {c.term}</span> : null}</span>
                </label>
              ))}
              <div className="flex flex-wrap gap-2 pt-3"><Button variant="primary" onClick={() => setStep(2)} disabled={!courseId}>Continue</Button><Button variant="ghost" onClick={() => setStep(3)}>Skip, I'll plan later</Button></div>
            </fieldset>
          ) : (
            <EmptyState icon="book" title="No courses yet" action={<Button onClick={() => setStep(3)}>Continue</Button>}>Your institution has not enrolled you in a course yet. You can still set your language now; courses appear here once you are enrolled.</EmptyState>
          )
        ) : step === 2 ? (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Your goal</h2>
            <Field id="exam" label="Exam date (optional)" hint="We plan backwards from this date. Leave empty for a two-week plan.">
              <input id="exam" type="date" min={today} className={inputCls} value={examAt} onChange={(e) => setExamAt(e.target.value)} aria-describedby="exam-hint" />
            </Field>
            <Field id="daily" label={`Study time per day: ${daily} minutes`} hint="Be realistic — the plan never schedules more than this (except briefly after missed days, at most +25%).">
              <input id="daily" type="range" min={10} max={240} step={5} value={daily} onChange={(e) => setDaily(Number(e.target.value))} className="w-full accent-[var(--color-accent)]" aria-describedby="daily-hint" />
            </Field>
            <div className="flex flex-wrap gap-2"><Button variant="primary" onClick={() => setStep(3)}>Continue</Button><Button variant="ghost" onClick={() => setStep(1)}>Back</Button></div>
          </div>
        ) : (
          <div className="space-y-4">
            <fieldset>
              <legend className="mb-2 text-lg font-semibold">Preferred language for the tutor</legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {LANGUAGES.map((l) => (
                  <label key={l.value} className={`flex min-h-12 cursor-pointer items-center gap-2 rounded-lg border px-3 ${language === l.value ? 'border-accent bg-src-course-bg' : 'border-line'}`}>
                    <input type="radio" name="lang" checked={language === l.value} onChange={() => setLanguage(l.value)} className="h-4 w-4 accent-[var(--color-accent)]" />{l.label}
                  </label>
                ))}
              </div>
            </fieldset>
            {a.error ? <ErrorNote error={a.error} /> : null}
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" busy={a.busy} onClick={() => void finish(!!courseId)}>{courseId ? 'Make my plan' : 'Finish'}</Button>
              <Button variant="ghost" onClick={() => void finish(false)} disabled={a.busy}>Skip the plan for now</Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}
