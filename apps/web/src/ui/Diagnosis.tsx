import { useState, type KeyboardEvent } from 'react'
import { TUTOR, api } from '../lib/api.ts'
import { prefs } from '../lib/storage.ts'
import { Icon } from './icons.tsx'
import { Button, ErrorNote, Notice, inputCls, useAction } from './kit.tsx'
import { Markdown } from './Markdown.tsx'

export interface FollowupView { stem: string; gradable: boolean; result?: { correct: boolean; yourAnswer: string; answer: string } }
export interface DiagnosisView {
  id: string; errorType: string; careless: boolean; recurring: boolean; misconception: string
  whyWrong: string; repair: string; diagnosticQuestion: string | null; similar?: FollowupView; transfer?: FollowupView
}

export const ERROR_LABEL: Record<string, string> = {
  conceptual: 'A misunderstanding of the idea', procedural: 'Right idea, wrong steps', calculation: 'A calculation slip', interpretation: 'The question was read differently',
  prerequisite: 'A gap in an earlier topic', careless: 'Looks like a slip — you have shown you know this', unknown: 'Hard to tell from this answer',
}

/**
 * "Why was this wrong?" — diagnosis of one wrong practice answer, then a similar problem and a transfer
 * problem. Rendered inside the practice form, so it uses buttons/Enter handling rather than a nested form.
 */
export function DiagnosisPanel({ attemptId }: { attemptId: string }) {
  const [d, setD] = useState<DiagnosisView | null>(null)
  const a = useAction()
  const load = async () => {
    const r = await a.run(() => api.post<DiagnosisView>(`${TUTOR}/attempts/${attemptId}/diagnose`, { language: prefs.language() }))
    if (r) setD(r)
  }
  if (!d) {
    return (
      <div className="rounded-xl border border-line bg-surface p-4">
        <p className="text-sm text-fg-soft">Find out what went wrong, fix the idea behind it, and check it sticks with two short problems.</p>
        {a.error ? <div className="mt-2"><ErrorNote error={a.error} retry={() => void load()} /></div> : null}
        <Button type="button" className="mt-3" icon="search" busy={a.busy} onClick={() => void load()}>Why was this wrong?</Button>
      </div>
    )
  }
  return (
    <section aria-labelledby={`dg-${d.id}`} className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <div>
        <h2 id={`dg-${d.id}`} className="text-base font-semibold">{ERROR_LABEL[d.errorType] ?? 'What went wrong'}</h2>
        {d.recurring ? <p className="mt-1 text-sm font-semibold text-warn">This has come up before — worth fixing properly now.</p> : null}
        {d.misconception ? <p className="mt-1 text-sm text-fg-soft">Likely idea behind it: <span className="italic">{d.misconception}</span></p> : null}
      </div>
      <div><h3 className="text-sm font-semibold text-fg-soft">Where your reasoning went off</h3><Markdown text={d.whyWrong} /></div>
      <div><h3 className="text-sm font-semibold text-fg-soft">Another way to see it</h3><Markdown text={d.repair} /></div>
      {d.diagnosticQuestion ? <Notice tone="info" icon="question" title="Think about this">{d.diagnosticQuestion}</Notice> : null}
      {d.similar ? <Followup diagnosisId={d.id} which="similar" title="Try a similar one" f={d.similar} /> : null}
      {d.transfer ? <Followup diagnosisId={d.id} which="transfer" title="Now in a different situation" f={d.transfer} /> : null}
      <p className="text-xs text-muted">Explanations are AI-generated. Only problems whose answers were checked by the maths engine count towards your progress.</p>
    </section>
  )
}

function Followup({ diagnosisId, which, title, f }: { diagnosisId: string; which: 'similar' | 'transfer'; title: string; f: FollowupView }) {
  const [value, setValue] = useState('')
  const [result, setResult] = useState(f.result ?? null)
  const a = useAction()
  const id = `fu-${diagnosisId}-${which}`
  const submit = async () => {
    if (!value.trim() || result) return
    const r = await a.run(() => api.post<{ correct: boolean; answer: string }>(`${TUTOR}/diagnoses/${diagnosisId}/followups/${which}`, { response: value.trim() }))
    if (r) setResult({ correct: r.correct, yourAnswer: value.trim(), answer: r.answer })
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') { e.preventDefault(); void submit() } }
  return (
    <div className="rounded-lg border border-line p-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-1"><Markdown text={f.stem} /></div>
      {!f.gradable ? <p className="mt-2 text-xs text-muted">Practice only: this problem's answer couldn't be verified, so it isn't graded.</p> : result ? (
        <p className={`mt-2 flex items-center gap-1 text-sm font-semibold ${result.correct ? 'text-ok' : 'text-warn'}`} role="status">
          <Icon name={result.correct ? 'check' : 'x'} size={16} />{result.correct ? 'Correct' : `Not quite — the answer is ${result.answer}`}
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label htmlFor={id} className="sr-only">Your answer to: {title}</label>
          <input id={id} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={onKey} autoComplete="off" spellCheck={false} maxLength={300} placeholder="Your answer" className={`${inputCls} w-48 font-mono`} />
          <Button type="button" busy={a.busy} disabled={!value.trim()} onClick={() => void submit()}>Check</Button>
        </div>
      )}
      {a.error ? <div className="mt-2"><ErrorNote error={a.error} /></div> : null}
    </div>
  )
}
