import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { AttemptResult, ConceptGraph, Confidence, PracticeNext } from '../../../web/src/lib/tutor.ts'
import { friendly, get, post, TUTOR } from '../lib/client.ts'
import type { Destination, View } from '../lib/logic.ts'
import type { Tutor } from '../lib/useTutor.ts'
import { Icon } from './Icon.tsx'
import { MathText, RichText } from './RichText.tsx'

interface HintStep { level: number; hint: string; next: number | null }
const RUNGS = ['What do you know?', 'A small nudge', 'The key principle', 'Break it into steps', 'A similar example', 'Full solution']

export function PracticeStudio({ tutor, target, go }: { tutor: Tutor; target: Extract<Destination, { view: 'practice' }> | null; go: (v: View) => void }) {
  const courses = tutor.view?.courses ?? []
  const [courseId, setCourseId] = useState(target?.courseId ?? tutor.view?.profile.courseId ?? courses[0]?.id ?? '')
  const [graph, setGraph] = useState<ConceptGraph | null>(null)
  const [conceptId, setConceptId] = useState(target?.conceptId ?? '')
  const [started, setStarted] = useState(false)
  const [next, setNext] = useState<PracticeNext | null>(null)
  const [loading, setLoading] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const preparingNow = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [answered, setAnswered] = useState({ total: 0, correct: 0 })
  const { fail } = tutor

  useEffect(() => {
    if (!courseId) return
    const ctl = new AbortController()
    setGraph(null)
    get<ConceptGraph>(`${TUTOR}/courses/${courseId}/concepts`, ctl.signal).then((g) => {
      setGraph(g)
      setConceptId((c) => (g.concepts.some((x) => x.id === c) ? c : g.concepts[0]?.id ?? ''))
    }, (e) => { if (!ctl.signal.aborted) { fail(e); setError(friendly(e)) } })
    return () => ctl.abort()
  }, [courseId, fail])

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try { setNext(await get<PracticeNext>(`${TUTOR}/courses/${courseId}/practice/next?conceptId=${conceptId}`)) }
    catch (e) { fail(e); setError(friendly(e)) } finally { setLoading(false) }
  }, [courseId, conceptId, fail])
  const start = () => { setStarted(true); setAnswered({ total: 0, correct: 0 }); void load() }
  const prepare = async () => {
    if (preparingNow.current) return
    preparingNow.current = true
    setPreparing(true); setError(null)
    try {
      const r = await post<{ added: number; rejected: number }>(`${TUTOR}/courses/${courseId}/practice/prepare`, { conceptId })
      if (!r.added) setError('No question passed the automatic checks this time, so none was added. You can try again.')
      await load()
    } catch (e) { fail(e); setError(friendly(e)) } finally { preparingNow.current = false; setPreparing(false) }
  }
  const conceptName = graph?.concepts.find((c) => c.id === conceptId)?.name

  if (!courses.length) return (
    <div className="td-view"><header className="td-view-head"><p className="td-eyebrow">Practice studio</p><h1>Set a goal first</h1></header>
      <div className="td-empty"><Icon name="target" /><h2>No course yet</h2><p>Practice uses the topics of your course. Start with a document or tell the Tutor what you want to learn.</p><div className="td-row"><button type="button" className="td-primary" onClick={() => go('document')}>Start from a document</button><button type="button" className="td-ghost" onClick={() => go('home')}>See the journey</button></div></div></div>
  )
  return (
    <div className="td-view td-practice">
      <header className="td-view-head"><p className="td-eyebrow">Practice studio</p><h1>{started && conceptName ? conceptName : 'Practise when you are ready'}</h1>{started ? <p>{answered.total ? `${answered.correct} of ${answered.total} correct in this round` : 'Answer, or ask for guided hints.'}</p> : <p>Nothing starts until you press the button. Answers are checked by the existing assessment engine.</p>}</header>
      {!started ? (
        <section className="td-card td-setup">
          <label>Course<select value={courseId} onChange={(e) => { setCourseId(e.target.value); setConceptId('') }}>{courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label>
          <label>Topic<select value={conceptId} onChange={(e) => setConceptId(e.target.value)} disabled={!graph}>{graph?.concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <button type="button" className="td-primary" onClick={start} disabled={!conceptId}>Start practice</button>
        </section>
      ) : null}
      {error ? <p role="alert" className="td-alert">{error}</p> : null}
      {started && loading ? <div className="td-skeleton" aria-label="Loading question"><i /><i /><i /></div> : null}
      {started && !loading && next && !next.item ? (
        <div className="td-empty"><Icon name="target" /><h2>No new question here</h2><p>{next.message} I can prepare a checked set for this topic. It uses one AI request.</p><div className="td-row"><button type="button" className="td-primary" onClick={() => void prepare()} disabled={preparing}>{preparing ? 'Preparing and checking…' : 'Prepare questions'}</button><button type="button" className="td-ghost" onClick={() => setStarted(false)}>Choose another topic</button></div></div>
      ) : null}
      {started && !loading && next?.item ? <Question key={next.item.id} data={next} onAnswered={(ok) => setAnswered((a) => ({ total: a.total + 1, correct: a.correct + (ok ? 1 : 0) }))} onNext={() => void load()} onStop={() => setStarted(false)} fail={fail} /> : null}
    </div>
  )
}

function Question({ data, onAnswered, onNext, onStop, fail }: { data: PracticeNext; onAnswered: (ok: boolean) => void; onNext: () => void; onStop: () => void; fail: (e: unknown) => void }) {
  const item = data.item!
  const [chosen, setChosen] = useState<number[]>([])
  const [value, setValue] = useState('')
  const [confidence, setConfidence] = useState<Confidence | null>(null)
  const [result, setResult] = useState<AttemptResult | null>(null)
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const hinting = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [hints, setHints] = useState<HintStep[]>([])
  const [hintBusy, setHintBusy] = useState(false)
  const nextRung = hints.length ? hints.at(-1)!.next : 1
  const ready = item.type === 'mcq' ? chosen.length > 0 : !!value.trim()
  const pick = (i: number) => setChosen((c) => (item.multiple ? (c.includes(i) ? c.filter((x) => x !== i) : [...c, i]) : [i]))
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    // a ref, not state: two clicks in one frame both see the old state, and the API records every attempt it receives
    if (submitting.current || result || !ready) return
    submitting.current = true
    setBusy(true); setError(null)
    try {
      const r = await post<AttemptResult>(`${TUTOR}/attempts`, { itemId: item.id, response: item.type === 'mcq' ? (item.multiple ? chosen.map((i) => item.options![i]) : item.options![chosen[0]!]) : value.trim(), confidence: confidence ?? undefined })
      setResult(r); onAnswered(r.correct)
    } catch (x) { fail(x); setError(friendly(x)) } finally { submitting.current = false; setBusy(false) }
  }
  const hint = async (direct: boolean) => {
    const level = direct ? 6 : nextRung
    if (!level || hinting.current) return
    hinting.current = true
    setHintBusy(true); setError(null)
    try {
      const r = await post<HintStep>(`${TUTOR}/items/${item.id}/hints`, { level, direct })
      setHints((h) => [...h.filter((x) => x.level !== r.level), r])
    } catch (x) { fail(x); setError(friendly(x)) } finally { hinting.current = false; setHintBusy(false) }
  }
  return (
    <form className="td-question" onSubmit={(e) => void submit(e)}>
      {data.source ? <p className="td-origin is-source">{data.source.kind === 'lesson' ? 'From your lesson' : 'From your material'}: {data.source.filename}{data.source.page ? `, p. ${data.source.page}` : ''}</p> : null}
      <div className="td-stem"><RichText text={item.stem} /></div>
      <fieldset className="td-confidence" disabled={!!result}><legend>How sure are you? (optional)</legend>{(['sure', 'unsure', 'guess'] as const).map((c) => <label key={c} className={confidence === c ? 'is-on' : ''}><input type="radio" name="td-conf" checked={confidence === c} onChange={() => setConfidence(c)} />{c === 'sure' ? 'Sure' : c === 'unsure' ? 'Not sure' : 'Guessing'}</label>)}</fieldset>
      {item.type === 'mcq' ? (
        <fieldset className="td-options" disabled={!!result}><legend className="td-sr">Your answer</legend>{item.options?.map((o, i) => <label key={o} className={chosen.includes(i) ? 'is-on' : ''}><input type={item.multiple ? 'checkbox' : 'radio'} name="td-opt" checked={chosen.includes(i)} onChange={() => pick(i)} /><span>{String.fromCharCode(65 + i)}</span><MathText text={o} /></label>)}</fieldset>
      ) : <label className="td-answer">Your answer<input value={value} onChange={(e) => setValue(e.target.value)} disabled={!!result} autoComplete="off" inputMode={item.type === 'numeric' ? 'decimal' : 'text'} /></label>}
      {!result ? (
        <div className="td-hints">
          {hints.map((h) => <div key={h.level}><p className="td-label">Hint {h.level} · {RUNGS[h.level - 1]}</p><RichText text={h.hint} /></div>)}
          <div className="td-row">
            {nextRung && nextRung < 6 ? <button type="button" className="td-ghost" onClick={() => void hint(false)} disabled={hintBusy}>{hintBusy ? 'Thinking…' : hints.length ? `Next hint: ${RUNGS[nextRung - 1]}` : 'Guided solve'}</button> : null}
            {nextRung ? <button type="button" className="td-ghost" onClick={() => void hint(true)} disabled={hintBusy}>Show complete solution</button> : null}
          </div>
          {hints.length === 0 ? <small>A complete solution counts as a helped answer, not towards mastery.</small> : null}
        </div>
      ) : null}
      {error ? <p role="alert" className="td-alert">{error}</p> : null}
      {result ? (
        <div className={`td-result ${result.correct ? 'is-right' : 'is-wrong'}`} role="status">
          <strong>{result.correct ? 'Correct' : 'Not quite'}</strong>
          <RichText text={result.explanation} />
          <small>{result.mastery.explanation}</small>
          <div className="td-row"><button type="button" className="td-primary" onClick={onNext}>Next question</button><button type="button" className="td-ghost" onClick={onStop}>Finish</button></div>
        </div>
      ) : <button type="submit" className="td-primary" disabled={!ready || busy}>{busy ? 'Checking…' : 'Check answer'}</button>}
    </form>
  )
}
