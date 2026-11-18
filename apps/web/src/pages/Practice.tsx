import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { TUTOR, api } from '../lib/api.ts'
import { masteryView, type AttemptResult, type Confidence, type ConceptMastery, type PracticeNext } from '../lib/tutor.ts'
import { Icon } from '../ui/icons.tsx'
import { Button, Card, EmptyState, ErrorNote, Notice, PageHeader, Skeleton, inputCls, useAction, useLoad } from '../ui/kit.tsx'
import { Markdown } from '../ui/Markdown.tsx'
import { MasteryChip } from '../ui/Mastery.tsx'
import { DiagnosisPanel } from '../ui/Diagnosis.tsx'
import { useCourse } from './CourseLayout.tsx'

const ROUND = 10
const CONF: { v: Confidence; label: string }[] = [{ v: 'sure', label: 'Sure' }, { v: 'unsure', label: 'Not sure' }, { v: 'guess', label: 'Guessing' }]

export default function Practice() {
  const course = useCourse()
  const [params, setParams] = useSearchParams()
  const conceptId = params.get('conceptId') ?? ''
  const [n, setN] = useState(0)
  const [round, setRound] = useState(0)
  const mastery = useLoad(`m:${course.id}:${round}`, (sig) => api.get<ConceptMastery[]>(`${TUTOR}/courses/${course.id}/mastery`, sig))
  const next = useLoad(`p:${course.id}:${conceptId}:${round}`, async (sig) => {
    const url = (id?: string) => `${TUTOR}/courses/${course.id}/practice/next${id ? `?conceptId=${id}` : ''}`
    const first = await api.get<PracticeNext>(url(conceptId || undefined), sig)
    if (first.item || conceptId) return first
    // "Recommended" picked a concept with no unseen items: try the next-weakest concepts instead of stopping
    const ms = await api.get<ConceptMastery[]>(`${TUTOR}/courses/${course.id}/mastery`, sig)
    for (const m of [...ms].sort((a, b) => a.pMastery - b.pMastery)) {
      if (m.conceptId === first.conceptId) continue
      const r = await api.get<PracticeNext>(url(m.conceptId), sig)
      if (r.item) return r
    }
    return first
  })
  const concept = mastery.data?.find((m) => m.conceptId === (next.data?.conceptId ?? conceptId))

  return (
    <>
      <PageHeader title="Practice" eyebrow={concept ? `${course.code} · ${concept.name}` : course.code}>
        <label htmlFor="pc" className="sr-only">Concept</label>
        <select id="pc" value={conceptId} onChange={(e) => { setParams(e.target.value ? { conceptId: e.target.value } : {}); setN(0) }} className="min-h-11 max-w-[16rem] rounded-lg border border-line-strong bg-surface px-2 text-sm">
          <option value="">Recommended</option>
          {mastery.data?.map((m) => <option key={m.conceptId} value={m.conceptId}>{m.name}</option>)}
        </select>
      </PageHeader>
      <div className="mx-auto max-w-2xl">
        <p className="mb-2 text-sm text-muted" aria-live="polite">Question {Math.min(n + 1, ROUND)} of {ROUND}</p>
        <div className="mb-4 h-1.5 rounded-full bg-line" aria-hidden><div className="anim h-1.5 rounded-full bg-accent" style={{ width: `${(Math.min(n, ROUND) / ROUND) * 100}%` }} /></div>
        {n >= ROUND ? (
          <EmptyState icon="check" title="Round complete" action={<div className="flex gap-2"><Button variant="primary" onClick={() => { setN(0); setRound((r) => r + 1) }}>Another round</Button><Link to={`/app/education/tutor/courses/${course.id}`} className="inline-flex min-h-11 items-center px-3 font-semibold text-accent underline">See your concepts</Link></div>}>
            Ten answers recorded. Your estimates have been updated from them.
          </EmptyState>
        ) : next.loading ? <Card><Skeleton lines={4} /></Card> : next.error ? <ErrorNote error={next.error} retry={next.reload} /> : !next.data!.item ? (
          <EmptyState icon="target" title="No new questions right now">{next.data!.message ?? 'You have seen every question for this concept today.'} Try another concept, or come back tomorrow.</EmptyState>
        ) : (
          <ItemCard key={next.data!.item.id} data={next.data!} before={concept} onNext={() => { setN((x) => x + 1); setRound((r) => r + 1) }} />
        )}
      </div>
    </>
  )
}

function ItemCard({ data, before, onNext }: { data: PracticeNext; before?: ConceptMastery; onNext: () => void }) {
  const item = data.item!
  const [confidence, setConfidence] = useState<Confidence | null>(null)
  const [chosen, setChosen] = useState<string[]>([])
  const [value, setValue] = useState('')
  const [result, setResult] = useState<AttemptResult | null>(null)
  const a = useAction()
  const ready = !!confidence && (item.type === 'mcq' ? chosen.length > 0 : value.trim() !== '')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!ready || result) return
    const r = await a.run(() => api.post<AttemptResult>(`${TUTOR}/attempts`, { itemId: item.id, response: item.type === 'mcq' ? (item.multiple ? chosen : chosen[0]) : value.trim(), confidence }))
    if (r) setResult(r)
  }

  const delta = result && before ? Math.round((result.mastery.pMastery - before.pMastery) * 100) : null
  return (
    <form onSubmit={submit}>
      <Card>
        <div className="mb-4 text-[1.08rem]"><Markdown text={item.stem} /></div>
        <fieldset className="mb-4" disabled={!!result}>
          <legend className="mb-2 text-sm font-semibold text-fg-soft">1 · How sure are you, before answering?</legend>
          <div className="grid grid-cols-3 gap-2">
            {CONF.map((c) => (
              <label key={c.v} className={`flex min-h-11 cursor-pointer items-center justify-center rounded-lg border text-sm font-semibold ${confidence === c.v ? 'border-accent bg-src-course-bg text-src-course' : 'border-line-strong'}`}>
                <input type="radio" name="conf" className="sr-only" checked={confidence === c.v} onChange={() => setConfidence(c.v)} />{c.label}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset disabled={!confidence || !!result} className="disabled:opacity-60">
          <legend className="mb-2 text-sm font-semibold text-fg-soft">2 · Your answer{item.multiple ? ' (choose all that apply)' : ''}</legend>
          {item.type === 'mcq' ? (
            <div className="grid gap-2">
              {item.options!.map((o) => (
                <label key={o} className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-3 ${chosen.includes(o) ? 'border-accent bg-src-course-bg' : 'border-line'}`}>
                  <input type={item.multiple ? 'checkbox' : 'radio'} name="opt" className="h-4 w-4 accent-[var(--color-accent)]" checked={chosen.includes(o)}
                    onChange={(e) => setChosen(item.multiple ? (e.target.checked ? [...chosen, o] : chosen.filter((x) => x !== o)) : [o])} />
                  <span className="min-w-0"><Markdown text={o} /></span>
                </label>
              ))}
            </div>
          ) : (
            item.type === 'expression' ? (
              <><label htmlFor="expr" className="text-sm font-semibold text-fg-soft">Your answer (an expression)</label>
                <input id="expr" autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={500} value={value} onChange={(e) => setValue(e.target.value)} className={`${inputCls} mt-1 font-mono`} placeholder="e.g. 2*x + 2" aria-describedby="expr-hint" />
                <p id="expr-hint" className="mt-1 text-xs text-muted">Use * for multiply and ^ for powers, e.g. 3*x^2 - 1 or sqrt(2)/2. Any equivalent form is accepted — it is checked mathematically.</p></>
            ) : (
              <><label htmlFor="num" className="sr-only">Numeric answer</label>
                <input id="num" inputMode="decimal" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} className={`${inputCls} font-mono`} placeholder="Your number" /></>
            )
          )}
        </fieldset>
        {a.error ? <div className="mt-3"><ErrorNote error={a.error} /></div> : null}
        {!result ? <HintLadder itemId={item.id} /> : null}
        {!result ? <Button type="submit" variant="primary" className="mt-4 w-full sm:w-auto" disabled={!ready} busy={a.busy}>Check answer</Button> : null}
      </Card>

      {result ? (
        <div className="mt-4 space-y-3" aria-live="polite">
          <Notice tone={result.correct ? 'ok' : 'warn'} icon={result.correct ? 'check' : 'x'} title={result.correct ? 'Correct' : result.outcome > 0 ? 'Partly correct' : 'Not quite'}>
            {result.explanation ? <Markdown text={result.explanation} /> : null}
          </Notice>
          {result.confidentAndWrong ? <Notice tone="info" icon="target" title="Worth noting">You were sure, but this was wrong — that is the most useful kind of mistake to revisit.</Notice> : null}
          {!result.correct && result.attemptId ? <DiagnosisPanel attemptId={result.attemptId} /> : null}
          <Card>
            <h2 className="mb-2 text-sm font-semibold text-fg-soft">What this changed</h2>
            <div className="flex flex-wrap items-center gap-2">
              {before ? <><MasteryChip m={before} compact /><Icon name="right" size={16} className="text-muted" /></> : null}
              <MasteryChip m={result.mastery} />
              {delta !== null && masteryView(result.mastery).percent !== null ? <span className="text-sm text-muted">{delta >= 0 ? '+' : ''}{delta} points</span> : null}
            </div>
            <p className="mt-2 text-sm text-muted">{result.mastery.explanation}</p>
          </Card>
          <Button variant="primary" onClick={onNext} className="w-full sm:w-auto" icon="right">Next question</Button>
        </div>
      ) : null}
    </form>
  )
}

const RUNG = ['What do you know?', 'A small nudge', 'The key principle', 'Break it into steps', 'A similar example', 'Full solution']
interface HintStep { level: number; hint: string; source: { filename: string; page: number; href: string } | null; next: number | null }

/** Graduated hints, one rung at a time (the server enforces the order and counts the hints you used). */
function HintLadder({ itemId }: { itemId: string }) {
  const [steps, setSteps] = useState<HintStep[]>([])
  const h = useAction()
  const next = steps.length ? steps.at(-1)!.next : 1
  const ask = async () => { if (!next) return; const r = await h.run(() => api.post<HintStep>(`${TUTOR}/items/${itemId}/hints`, { level: next })); if (r) setSteps((s) => [...s, r]) }
  return (
    <div className="mt-4 rounded-lg border border-dashed border-line-strong p-3">
      {steps.length ? (
        <ol className="grid gap-2 text-sm">
          {steps.map((s) => (
            <li key={s.level}>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Hint {s.level} · {RUNG[s.level - 1]}</p>
              <div className="whitespace-pre-wrap">{s.hint}</div>
              {s.source ? <Link to={s.source.href} className="text-xs font-semibold text-accent underline">Where this is explained: {s.source.filename}, p. {s.source.page}</Link> : null}
            </li>
          ))}
        </ol>
      ) : <p className="text-sm text-muted">Stuck? Hints come one small step at a time — try each before the next.</p>}
      {h.error ? <div className="mt-2"><ErrorNote error={h.error} /></div> : null}
      {next ? <Button type="button" className="mt-2" busy={h.busy} onClick={() => void ask()}>{next === 6 ? 'Show the full solution' : `Hint ${next}: ${RUNG[next - 1]}`}</Button> : null}
    </div>
  )
}
