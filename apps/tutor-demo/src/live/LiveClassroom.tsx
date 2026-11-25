import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Block, Page } from '../../../web/src/lib/studio.ts'
import { DemoError, friendly, post, postAudio, S, TUTOR } from '../lib/client.ts'
import { Icon } from '../components/Icon.tsx'
import { Board } from './Board.tsx'
import { stepAt, type CharacterState } from './choreography.ts'
import { RigDriver } from './driver.ts'
import { LivePlayer, type Segment, type Status, type VoiceKind } from './player.ts'
import { MAX_RECORD_MS, MicError, MicRecorder } from './recorder.ts'
import type { RigHandle } from './VidyaRig.tsx'
import { Vidya2D } from './cutout/Vidya2D.tsx'

type Lang = 'hinglish' | 'en' | 'hi'
interface Script { language: Lang; title: string; scripted: boolean; complete?: boolean; segments: Segment[]; question: { text: string; token: string; speechToken: string } }
type Stage = 'loading' | 'ready' | 'teaching' | 'hand' | 'answering' | 'question' | 'done' | 'failed'
const VOICE_LABEL: Record<VoiceKind, string> = { sarvam: 'Sarvam voice', device: 'Device voice', captions: 'Captions only' }
/** the same section is taught from one script for this session: reopening costs no model call and starts at once */
const SCRIPTS = new Map<string, { at: number; script: Promise<Script> }>()
const SCRIPT_TTL = 90 * 60_000
function scriptFor(bookId: string, sectionId: string, language: Lang, blocks: Block[]) {
  const key = `${bookId}:${sectionId}:${language}:${blocks.map((b) => b.id).join(',')}`
  const have = SCRIPTS.get(key)
  if (have && Date.now() - have.at < SCRIPT_TTL) return have.script
  const script = post<Script>(`${S}/books/${bookId}/live/script`, { sectionId, language }, 90_000)
  SCRIPTS.set(key, { at: Date.now(), script })
  // only a fully translated script is reused; otherwise the next open tries again
  script.then((s) => { if (!s.complete) SCRIPTS.delete(key) }, () => SCRIPTS.delete(key))
  return script
}
const boardText = (b: Block) => [b.term, b.text, ...(b.items ?? []), b.figure?.caption].filter(Boolean).join(' ')

export function LiveClassroom({ bookId, courseId, sectionId, startPage, startBlock, pages, fail, onClose }: { bookId: string; courseId: string; sectionId: string; startPage?: number; startBlock?: string | null; pages: Page[]; fail: (e: unknown) => void; onClose: (reached: { pageNo: number; blockId: string } | null) => void }) {
  const blocks = useMemo(() => pages.filter((p) => p.sectionId === sectionId).flatMap((p) => p.blocks).filter((b) => b.type !== 'activity'), [pages, sectionId])
  const [language, setLanguage] = useState<Lang>('hinglish')
  const [script, setScript] = useState<Script | null>(null)
  const [stage, setStage] = useState<Stage>('loading')
  const [status, setStatus] = useState<Status>('idle')
  const [voice, setVoice] = useState<VoiceKind | null>(null)
  const [muted, setMuted] = useState(false)
  const [shown, setShown] = useState<Set<string>>(new Set())
  const [active, setActive] = useState<string | null>(null)
  const [caption, setCaption] = useState('')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [verdict, setVerdict] = useState<string | null>(null)
  const [mic, setMic] = useState<'off' | 'starting' | 'on' | 'reading'>('off')
  const recorder = useRef<MicRecorder | null>(null)
  const micTimer = useRef(0)
  const rig = useRef<RigHandle>(null)
  const [compact] = useState(() => matchMedia('(max-width: 640px)').matches)
  const driver = useRef<RigDriver | null>(null)
  const player = useRef<LivePlayer | null>(null)
  const board = useRef<HTMLDivElement>(null)
  const beam = useRef<SVGLineElement>(null)
  const stageEl = useRef<HTMLDivElement>(null)
  const capFill = useRef<HTMLSpanElement>(null)
  const position = useRef(0) // the lesson segment to come back to after a question
  const afterSpeech = useRef<(() => void) | null>(null)
  const busy = useRef(false)
  const loadRun = useRef(0)
  const scriptRef = useRef<Script | null>(null)
  scriptRef.current = script

  const pointTarget = useCallback(() => {
    // on phones she stands below the board: a compact gesture toward it, never an arm across her face
    if (matchMedia('(max-width: 640px)').matches) return null
    const id = active
    const root = id ? board.current?.querySelector(`[data-board="${CSS.escape(id)}"]`) : null
    const el = root?.querySelector('[data-step].is-on') ?? root?.querySelector('[data-point]') ?? root
    if (!root || !el || !board.current) return 'hold' as const
    // only something the student can already see: on the board, finished appearing, inside the visible area
    if (root.getAnimations().some((a) => a.playState === 'running')) return 'hold' as const
    const r = el.getBoundingClientRect(), view = board.current.getBoundingClientRect()
    if (r.top < view.top || r.top + Math.min(24, r.height) > view.bottom) return 'hold' as const
    return { x: r.left - 5, y: r.top + Math.min(16, r.height / 2) } // just before the content, so the hand never covers it
  }, [active])

  // the rig loop and the player live for as long as the classroom is open
  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    const lowPower = matchMedia('(pointer: coarse)').matches || (navigator.hardwareConcurrency ?? 8) <= 4
    const d = new RigDriver(rig.current!, { reduced, lowPower })
    driver.current = d
    d.onFrame = (tip, target) => {
      const l = beam.current, host = stageEl.current
      if (!l || !host) return
      if (!tip || !target) { l.style.opacity = '0'; return }
      const o = host.getBoundingClientRect()
      l.setAttribute('x1', String(tip.x - o.left)); l.setAttribute('y1', String(tip.y - o.top)); l.setAttribute('x2', String(target.x - o.left)); l.setAttribute('y2', String(target.y - o.top))
      l.style.opacity = '.75'
    }
    d.setState('greeting', 2600)
    d.start()
    let debugPanel: HTMLElement | null = null
    // ?debug=lipsync: a small panel with the live mouth class and the measured audio→mouth delay (for checking sync)
    if (new URLSearchParams(location.search).get('debug') === 'lipsync') {
      const panel = document.createElement('pre')
      panel.className = 'td-lipdebug'
      stageEl.current?.appendChild(panel)
      const show = () => { if (!driver.current) return; const l = d.lip; panel.textContent = `${l.cls.padEnd(9)} ${l.viseme.padEnd(4)} level ${l.level.toFixed(2)} open ${l.open.toFixed(2)}\nstate ${d.state}  ${JSON.stringify(d.latency.summary())}`; requestAnimationFrame(show) }
      requestAnimationFrame(show)
      ;(window as unknown as { __vidya?: RigDriver }).__vidya = d
      debugPanel = panel
    }
    const p = new LivePlayer(bookId, language, {
      segment: (seg) => {
        setCaption(seg.speech); setActive(seg.blockId || null)
        if (seg.blockId) setShown((s) => (s.has(seg.blockId) ? s : new Set(s).add(seg.blockId)))
        if (capFill.current) capFill.current.style.width = '0%'
      },
      frame: (seg, f, phase) => {
        if (capFill.current) capFill.current.style.width = `${(f * 100).toFixed(1)}%`
        const root = seg.blockId ? board.current?.querySelector(`[data-board="${CSS.escape(seg.blockId)}"]`) : null
        if (!root) return
        const steps = root.querySelectorAll('[data-step]')
        if (!steps.length) return
        const isExample = root.classList.contains('is-example') || root.classList.contains('is-list')
        // steps of a worked example unfold across the speech; a formula's terms light up while she traces it
        const span = phase.highlight ? (f - phase.from) / Math.max(0.01, phase.to - phase.from) : -1
        const on = isExample ? stepAt(steps.length, f) : phase.highlight ? stepAt(steps.length, span) : -1
        if (isExample && on >= 0) d.count = on + 1
        steps.forEach((el, i) => { el.classList.toggle('is-on', i === on); el.classList.toggle('is-past', isExample ? i < on : false); if (isExample) el.classList.toggle('is-shown', i <= on) })
      },
      beat: (action, gaze, count) => d.play(action, gaze, count),
      speech: (feed) => { d.speech = feed },
      status: setStatus,
      voice: setVoice,
      finished: () => { const next = afterSpeech.current; afterSpeech.current = null; next?.() },
    })
    player.current = p
    return () => { d.stop(); p.dispose(); debugPanel?.remove(); driver.current = null; player.current = null }
  }, [bookId, language])
  useEffect(() => { if (driver.current) driver.current.pointAt = pointTarget }, [pointTarget])
  useEffect(() => { if (active) board.current?.querySelector(`[data-board="${CSS.escape(active)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [active])

  const loadScript = useCallback(async () => {
    const run = ++loadRun.current // a late reply from an older request must never reset a lesson in progress
    setStage('loading'); setError(null); setScript(null); setShown(new Set()); setActive(null); setCaption(''); position.current = 0
    driver.current?.setState('thinking')
    try {
      const got = await scriptFor(bookId, sectionId, language, blocks as Block[])
      if (run !== loadRun.current) return
      const byId = new Map((blocks as Block[]).map((b) => [b.id, b]))
      const s = { ...got, segments: got.segments.map((x) => { const b = byId.get(x.blockId); return b ? { ...x, board: boardText(b) } : x }) }
      setScript(s); setStage('ready'); driver.current?.setState('idle')
    } catch (e) { if (run !== loadRun.current) return; fail(e); setError(friendly(e)); setStage('failed'); driver.current?.setState('idle') }
  }, [bookId, sectionId, language, fail, blocks])
  useEffect(() => { void loadScript(); return () => { loadRun.current++ } }, [loadScript])

  const askClosing = useCallback(() => {
    const s = scriptRef.current
    if (!s) return
    setStage('question'); setActive(null); setCaption(s.question.text)
    afterSpeech.current = () => driver.current?.setState('listening')
    void player.current?.play([{ id: 'closing', blockId: '', pageNo: 0, type: 'question', speech: s.question.text, token: s.question.speechToken }])
    driver.current?.play('ask_student_question', 'audience')
  }, [])
  const teach = useCallback((from: number) => {
    const s = scriptRef.current
    if (!s) return
    setStage('teaching'); setVerdict(null)
    afterSpeech.current = askClosing
    // keep segment index for "come back after a question"
    const list = s.segments
    void player.current?.play(list, from)
  }, [askClosing])
  useEffect(() => {
    if (stage !== 'teaching' || !active || !script) return
    const i = script.segments.findIndex((x) => x.blockId === active)
    if (i >= 0) position.current = i
  }, [active, stage, script])

  const start = useCallback((from = 0) => { player.current?.unlock(); setShown(new Set()); position.current = from; teach(from) }, [teach])
  // Vidya simply begins, at the part the student asked about: there is no mode or start screen
  useEffect(() => {
    if (stage !== 'ready' || !script) return
    let from = startBlock ? script.segments.findIndex((x) => x.blockId === startBlock) : -1
    if (from < 0 && startPage) from = script.segments.findIndex((x) => x.pageNo === startPage)
    start(Math.max(0, from))
  }, [stage, script, start, startBlock, startPage])
  const stopMic = () => { window.clearTimeout(micTimer.current); recorder.current?.cancel(); recorder.current = null; setMic('off') }
  useEffect(() => () => { window.clearTimeout(micTimer.current); recorder.current?.cancel() }, [])
  const finishMic = async () => {
    const r = recorder.current
    if (!r) return
    window.clearTimeout(micTimer.current)
    recorder.current = null
    setMic('reading')
    try {
      const audio = await r.stop()
      const lang = language === 'en' ? 'en' : 'hi'
      const t = await postAudio<{ text: string }>(`${TUTOR}/courses/${courseId}/voice/transcribe?language=${lang}`, audio)
      if (!t.text.trim()) setError('I could not hear any words. Please try again, or type your question.')
      else { setDraft((d) => `${d ? `${d} ` : ''}${t.text.trim()}`.slice(0, 1500)); setError(null); window.setTimeout(() => document.getElementById('td-live-input')?.focus(), 40) }
    } catch (x) {
      if (x instanceof DemoError) fail(x)
      setError(x instanceof MicError ? x.message : x instanceof DemoError && x.code !== 'session_expired' ? 'I could not turn that into text. Please try again, or type your question.' : friendly(x))
    } finally { setMic('off') }
  }
  const toggleMic = async () => {
    if (mic === 'on') { await finishMic(); return }
    if (mic !== 'off') return
    setError(null); setMic('starting'); player.current?.stop(); driver.current?.interrupt()
    const r = new MicRecorder()
    recorder.current = r
    try {
      await r.start()
      if (recorder.current !== r) return
      setMic('on')
      micTimer.current = window.setTimeout(() => void finishMic(), MAX_RECORD_MS)
    } catch (x) { recorder.current = null; setMic('off'); setError(x instanceof MicError ? x.message : friendly(x)) }
  }
  const raiseHand = () => { player.current?.unlock(); player.current?.stop(); afterSpeech.current = null; driver.current?.interrupt(); setStage('hand'); window.setTimeout(() => document.getElementById('td-live-input')?.focus(), 60) }
  const speakThen = (segs: Segment[], then: () => void) => { afterSpeech.current = then; void player.current?.play(segs) }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text || busy.current || !script || mic !== 'off') return
    busy.current = true
    const wasQuestion = stage === 'question'
    setDraft(''); setError(null); setStage('answering'); player.current?.stop(); driver.current?.setState('thinking')
    try {
      if (wasQuestion) {
        const r = await post<{ verdict: 'correct' | 'partial' | 'incorrect'; feedback: string; speechToken: string }>(`${S}/books/${bookId}/live/check`, { token: script.question.token, answer: text, language }, 60_000)
        setVerdict(r.verdict)
        const mood: CharacterState = r.verdict === 'correct' ? 'celebrating' : 'encouraging'
        driver.current?.setState(mood)
        setCaption(r.feedback); setStage('done')
        speakThen([{ id: 'feedback', blockId: '', pageNo: 0, type: r.verdict === 'correct' ? 'feedback_correct' : 'feedback_support', speech: r.feedback, token: r.speechToken }], () => driver.current?.setState('goodbye', 2600))
        driver.current?.play(r.verdict === 'correct' ? 'celebrate_correct_answer' : 'supportive_wrong_answer', 'audience')
      } else {
        const seg = script.segments[position.current]
        const r = await post<{ segments: Segment[] }>(`${S}/books/${bookId}/live/ask`, { question: text, pageNo: seg?.pageNo ?? pages.find((p) => p.sectionId === sectionId)?.pageNo ?? 1, blockId: seg?.blockId || null, language }, 90_000)
        setStage('teaching'); setActive(null)
        speakThen(r.segments.map((x) => ({ ...x, blockId: '' })), () => {
          void post(`${S}/books/${bookId}/live/resume`).catch(() => undefined)
          teach(position.current)
        })
      }
    } catch (x) { fail(x); setError(friendly(x)); setStage(wasQuestion ? 'question' : 'hand'); driver.current?.setState('listening') } finally { busy.current = false }
  }
  const toggleMute = () => { const m = !muted; setMuted(m); player.current?.setMuted(m); if (stage === 'teaching') { player.current?.unlock(); teach(position.current) } }
  const close = () => { stopMic(); player.current?.stop(); const seg = stage === 'loading' || stage === 'failed' ? null : scriptRef.current?.segments[position.current]; onClose(seg?.blockId ? { pageNo: seg.pageNo, blockId: seg.blockId } : null) }
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) })

  const playing = status === 'playing' || status === 'loading'
  const canHand = stage === 'teaching'
  const inputOpen = stage === 'hand' || stage === 'question'
  return createPortal(
    <div className="td-live" role="dialog" aria-modal="true" aria-label="Vidya Live Teaching">
      <header className="td-live-top">
        <span className="td-live-mark"><i aria-hidden />Live teaching</span>
        <strong>{script?.title ?? 'Preparing the lesson'}</strong>
        <label className="td-sr" htmlFor="td-live-lang">Teaching language</label>
        <select id="td-live-lang" value={language} onChange={(e) => setLanguage(e.target.value as Lang)}><option value="hinglish">Hinglish</option><option value="en">English</option><option value="hi">हिन्दी</option></select>
        {voice ? <span className="td-live-voice">{VOICE_LABEL[voice]}</span> : null}
        <button type="button" className="td-ghost" onClick={close}><Icon name="close" />Leave</button>
      </header>
      <div className="td-live-stage" ref={stageEl}>
        <div className="td-teacher" onPointerEnter={() => { if (driver.current?.state === 'idle') driver.current.setState('hover', 1900) }}>
          <Vidya2D ref={rig} label="Vidya, your teacher, standing beside the board" framing={compact ? 'compact' : 'stage'} />
        </div>
        <div className="td-board" ref={board}>
          <Board title={script?.title ?? ''} blocks={blocks as Block[]} shown={shown} active={active} />
          {stage === 'loading' ? <p className="td-board-note" role="status"><b className="td-spin" />Vidya is preparing to teach this section…</p> : null}
          {stage === 'failed' ? <div className="td-board-start"><p role="alert">{error}</p><button type="button" className="td-primary" onClick={() => void loadScript()}>Try again</button></div> : null}
        </div>
        <svg className="td-beam" aria-hidden><line ref={beam} /></svg>
      </div>
      <footer className="td-live-bar">
        <p className="td-caption" aria-live="off"><span>{caption || ' '}</span><span className="td-cap-track"><span ref={capFill} /></span></p>
        {script && !script.complete && language !== 'en' ? <p className="td-muted-note">{language === 'hi' ? 'Hindi' : 'Hinglish'} is busy right now, so some lines are in the book's language.</p> : null}
        {verdict ? <p className={`td-verdict is-${verdict}`}>{verdict === 'correct' ? 'Correct' : verdict === 'partial' ? 'Nearly there' : 'Let us look at it again'}</p> : null}
        {error && stage !== 'failed' ? <p role="alert" className="td-alert">{error}</p> : null}
        {inputOpen ? (
          <form className="td-live-form" onSubmit={(e) => void submit(e)}>
            <label className="td-sr" htmlFor="td-live-input">{stage === 'question' ? 'Your answer' : 'Your question'}</label>
            <input id="td-live-input" value={draft} maxLength={1500} autoComplete="off" onChange={(e) => setDraft(e.target.value)} onFocus={() => { if (stage === 'question') { player.current?.stop(); driver.current?.setState('listening') } }} placeholder={stage === 'question' ? 'Type your answer…' : 'Ask Vidya about this…'} />
            <button type="button" className={`td-mic${mic === 'on' ? ' is-on' : ''}`} onClick={() => void toggleMic()} disabled={mic === 'starting' || mic === 'reading'} aria-pressed={mic === 'on'}>{mic === 'on' ? 'Stop' : mic === 'reading' ? 'Writing it down…' : mic === 'starting' ? 'Allow mic…' : 'Speak'}</button>
            <span className="td-sr" role="status">{mic === 'on' ? 'Listening. Press stop when you finish.' : mic === 'reading' ? 'Turning your words into text.' : ''}</span>
            <button type="submit" className="td-primary" disabled={!draft.trim() || mic !== 'off'}>{stage === 'question' ? 'Answer' : 'Ask'}</button>
            {stage === 'hand' ? <button type="button" className="td-ghost" onClick={() => teach(position.current)}>Continue lesson</button> : null}
          </form>
        ) : (
          <div className="td-live-controls" role="toolbar" aria-label="Lesson controls">
            {stage === 'answering' ? <span className="td-live-wait" role="status"><b className="td-spin" />Vidya is thinking…</span> : null}
            {stage === 'teaching' ? <button type="button" className="td-ghost" onClick={() => (playing ? player.current?.pause() : player.current?.resume())} disabled={status === 'loading'}>{status === 'paused' ? 'Resume' : 'Pause'}</button> : null}
            {stage === 'teaching' || stage === 'done' ? <button type="button" className="td-ghost" onClick={() => start(0)}>Replay</button> : null}
            {stage === 'teaching' ? <button type="button" className="td-ghost" onClick={toggleMute} aria-pressed={muted}>{muted ? 'Unmute' : 'Mute'}</button> : null}
            {canHand ? <button type="button" className="td-primary" onClick={raiseHand}>Raise hand</button> : null}
            {stage === 'done' ? <button type="button" className="td-primary" onClick={close}>Back to the notebook</button> : null}
          </div>
        )}
      </footer>
    </div>,
    document.body,
  )
}
