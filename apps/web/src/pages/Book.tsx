import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { api, describeError } from '../lib/api.ts'
import { S, blockSpeech, flatBlocks, nextPosition, notebookMarkdown, prevPosition, searchBook, streamSection, type Annotation, type AnswerResult, type Block, type BookView, type Notebook, type Page, type Position, type StudioState, type StudyMode } from '../lib/studio.ts'
import { isPaused, pauseSpeaking, resumeSpeaking, speak, stopSpeaking, type VoiceLang } from '../lib/voice.ts'
import { Button, ErrorNote, Loading, inputCls, useAction, useLoad } from '../ui/kit.tsx'
import { UniversalChat } from '../chat/UniversalChat.tsx'

type Panel = 'tutor' | 'notes' | 'contents' | 'search'
const MODES: { v: StudyMode; label: string }[] = [{ v: 'read', label: 'Read' }, { v: 'listen', label: 'Listen' }, { v: 'read_listen', label: 'Read + listen' }, { v: 'conversation', label: 'Conversation' }]
const listens = (m: StudyMode) => m !== 'read'

function useWide() {
  const q = '(min-width: 1280px)'
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches)
  useEffect(() => { const m = window.matchMedia(q); const f = () => setWide(m.matches); m.addEventListener('change', f); return () => m.removeEventListener('change', f) }, [])
  return wide
}

/** The interactive book: the primary learning canvas, with the tutor and the notebook beside it. */
export default function Book() {
  const { bookId = '' } = useParams()
  const v = useLoad<BookView>(`book:${bookId}`, (sig) => api.get(`${S}/books/${bookId}`, sig))
  if (v.loading && !v.data) return <Loading label="Opening your book" />
  if (v.error || !v.data) return <ErrorNote error={v.error} retry={v.reload} feature="book" />
  return <BookDesk key={bookId} initial={v.data} />
}

function BookDesk({ initial }: { initial: BookView }) {
  const book = initial.book
  const wide = useWide()
  const [pages, setPages] = useState<Page[]>(() => lessonOnly(initial.pages))
  const [outline, setOutline] = useState(book.outline)
  const [state, setState] = useState<StudioState>(book.state)
  const [nb, setNb] = useState(initial.notebook)
  const [ann, setAnn] = useState<Annotation[]>(initial.annotations)
  const [cur, setCur] = useState(Math.max(1, book.state.view.pageNo || book.state.lecture.pageNo || 1))
  const [flip, setFlip] = useState<'' | 'flip-next' | 'flip-prev'>('')
  const [zoom, setZoom] = useState(1)
  const [panel, setPanel] = useState<Panel>('tutor')
  const [notice, setNotice] = useState<{ text: string; canResume: boolean } | null>(null)
  const [live, setLive] = useState<{ title: string; blocks: Block[]; files: string[] } | null>(null)
  const [playing, setPlaying] = useState(false)
  const [sel, setSel] = useState<{ text: string; pageNo: number; blockId: string | null; x: number; y: number } | null>(null)
  const [attached, setAttached] = useState<{ text: string; pageNo: number; blockId: string | null } | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const act = useAction()
  const deskRef = useRef<HTMLDivElement>(null)
  const [full, setFull] = useState(false)
  useEffect(() => { const on = () => setFull(!!document.fullscreenElement); document.addEventListener('fullscreenchange', on); return () => document.removeEventListener('fullscreenchange', on) }, [])
  const toggleFull = () => { if (document.fullscreenElement) void document.exitFullscreen(); else void deskRef.current?.requestFullscreen?.().catch(() => {}) }
  const gen = useAction()
  const stopRef = useRef<() => void>(() => {})
  const viewTimer = useRef<number | undefined>(undefined)
  const programmatic = useRef(false)
  const lang = book.language as VoiceLang
  const total = pages.length ? Math.max(...pages.map((p) => p.pageNo)) : 0
  const left = wide ? (cur % 2 === 1 ? cur : cur - 1) : cur
  const shown = (wide ? [left, left + 1] : [cur]).filter((n) => n >= 1)
  const byPage = useMemo(() => new Map(pages.map((p) => [p.pageNo, p])), [pages])
  const sectionOf = (pageNo: number) => outline.find((s) => s.id === byPage.get(pageNo)?.sectionId)
  const pending = outline.find((s) => s.status !== 'ready')
  const lecture = state.lecture
  // callbacks fired when speech ends must see the CURRENT lecture position, pages and mode (not a stale render)
  const now = useRef({ pages, lecture, mode: state.mode, pending })
  now.current = { pages, lecture, mode: state.mode, pending }
  const playingRef = useRef(false)
  const setPlay = (v: boolean) => { playingRef.current = v; setPlaying(v) }


  // ── page turning ──
  const goPage = useCallback((n: number, opts: { quiet?: boolean } = {}) => {
    if (n < 1 || (total && n > total)) return
    setFlip(n > cur ? 'flip-next' : n < cur ? 'flip-prev' : '')
    if (opts.quiet) programmatic.current = true
    setCur(n)
  }, [cur, total])
  useEffect(() => { if (!flip) return; const t = window.setTimeout(() => setFlip(''), 700); return () => window.clearTimeout(t) }, [flip, cur])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.closest('input, textarea, select, [contenteditable]')) return
      if (e.key === 'ArrowRight') goPage(cur + (wide ? 2 : 1))
      if (e.key === 'ArrowLeft') goPage(cur - (wide ? 2 : 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cur, wide, goPage])

  // the server keeps track of the open page; opening a page away from the lesson starts a detour
  useEffect(() => {
    window.clearTimeout(viewTimer.current)
    if (programmatic.current) { programmatic.current = false; return }
    viewTimer.current = window.setTimeout(() => {
      void api.post<{ state: StudioState; prompt: string | null }>(`${S}/books/${book.id}/events`, { kind: 'view', pageNo: cur }).then((r) => {
        setState(r.state)
        setNotice(r.prompt ? { text: r.prompt, canResume: !!r.state.interruption } : null)
        if (r.prompt) setPanel('tutor')
      }).catch(() => {})
    }, 1200)
    return () => window.clearTimeout(viewTimer.current)
  }, [cur, book.id])

  // ── lecture ──
  const show = (p: Position) => {
    const target = wide ? (p.pageNo % 2 === 1 ? p.pageNo : p.pageNo - 1) : p.pageNo
    if (!shown.includes(p.pageNo)) goPage(target, { quiet: true })
    if (p.blockId) window.setTimeout(() => document.getElementById(`blk-${p.blockId}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 80)
  }
  const advanceTo = async (p: Position) => {
    setState((s) => ({ ...s, lecture: p, view: p, interruption: s.interruption && p.pageNo === s.interruption.returnTo.pageNo ? null : s.interruption }))
    show(p)
    try { setState((await api.post<{ state: StudioState }>(`${S}/books/${book.id}/events`, { kind: 'advance', pageNo: p.pageNo, blockId: p.blockId })).state) } catch { /* autosaves on the next step */ }
  }
  const speakBlock = (p: Position, then?: () => void) => {
    const b = byPage.get(p.pageNo)?.blocks.find((x) => x.id === p.blockId)
    stopRef.current()
    if (!b) return then?.()
    stopRef.current = speak([blockSpeech(b)], lang, then)
  }
  const step = async (auto = false) => {
    const { pages: ps, lecture: lec, mode, pending: next } = now.current
    const nxt = nextPosition(ps, lec.blockId ? lec : { pageNo: lec.pageNo, blockId: null })
    if (!nxt) {
      setPlay(false)
      if (next) await writeSection(next.id, true)
      return
    }
    now.current = { ...now.current, lecture: nxt }
    await advanceTo(nxt)
    if (listens(mode) && (auto || playingRef.current)) {
      speakBlock(nxt, () => {
        if (now.current.mode === 'conversation') { setPlay(false); setNotice({ text: 'Any question about this part? Ask me here, or press Continue.', canResume: false }) }
        else if (playingRef.current) void step(true)
      })
    }
  }
  /** pause keeps the exact place in the sentence; play resumes there */
  const hold = () => { setPlay(false); pauseSpeaking() }
  const play = () => { if (isPaused()) { setPlay(true); resumeSpeaking(); return } setPlay(true); const lec = now.current.lecture; if (lec.blockId) speakBlock(lec, () => { if (playingRef.current) void step(true) }); else void step(true) }
  const pause = () => { setPlay(false); stopRef.current(); resumeSpeaking(); stopSpeaking() }
  const replay = () => { if (lecture.blockId) speakBlock(lecture) }
  const back = () => { const p = prevPosition(pages, lecture); if (p) { show(p); speakBlock(p) } }
  const setMode = (m: StudyMode) => { pause(); setState((s) => ({ ...s, mode: m })); void api.post(`${S}/books/${book.id}/events`, { kind: 'mode', mode: m }).catch(() => {}) }
  useEffect(() => () => stopSpeaking(), [])

  // ── writing sections (streamed) ──
  /** `teach`: the lesson reached this section (move the lecture there); otherwise just write it and show it */
  const writeSection = async (sectionId: string, teach = false) => {
    const s = outline.find((x) => x.id === sectionId)
    setLive({ title: s?.title ?? '', blocks: [], files: [] })
    setOutline((o) => o.map((x) => (x.id === sectionId ? { ...x, status: 'generating' } : x)))
    const streamed = await gen.run(() => streamSection(book.id, sectionId, (e) => {
      if (e.type === 'block' && e.block.type !== 'activity') setLive((l) => (l ? { ...l, blocks: [...l.blocks, e.block] } : l))
      if (e.type === 'sources') setLive((l) => (l ? { ...l, files: e.files } : l))
    }))
    setLive(null)
    const newPages = streamed ? lessonOnly(streamed) : null
    if (!newPages) { setOutline((o) => o.map((x) => (x.id === sectionId ? { ...x, status: 'pending' } : x))); return }
    const merged = [...pages.filter((p) => !newPages.some((n) => n.pageNo === p.pageNo)), ...newPages].sort((a, b) => a.pageNo - b.pageNo)
    setPages(merged)
    setOutline((o) => o.map((x) => (x.id === sectionId ? { ...x, status: 'ready', firstPage: newPages[0]!.pageNo, pages: newPages.length } : x)))
    void api.get<BookView>(`${S}/books/${book.id}`).then((r) => setNb(r.notebook)).catch(() => {})
    const first = { pageNo: newPages[0]!.pageNo, blockId: newPages[0]!.blocks[0]!.id }
    if (!teach) { show(first); return }
    await advanceTo(first)
    now.current = { ...now.current, pages: merged, lecture: first, pending: undefined }
    if (listens(now.current.mode)) { setPlay(true); speakBlock(first, () => { if (playingRef.current) void step(true) }) }
  }

  // ── asking ──
  // a doubt was answered by the universal tutor inside this book: refresh state + notebook, read it aloud
  const onAnswer = (text: string) => {
    pause()
    setNotice(null)
    void api.get<BookView>(`${S}/books/${book.id}`).then((r) => { setState(r.book.state); setNb(r.notebook) }).catch(() => {})
    if (listens(now.current.mode)) stopRef.current = speak([text], lang)
  }
  const resume = async () => {
    pause()
    const r = await act.run(() => api.post<{ state: StudioState; position: Position }>(`${S}/books/${book.id}/resume`))
    if (!r) return
    setState(r.state)
    show(r.position)
    if (r.position.blockId) { setFlash(r.position.blockId); window.setTimeout(() => setFlash(null), 1600) }
    setNotice({ text: `Back to page ${r.position.pageNo} — we continue right after the highlighted part.`, canResume: false })
  }

  // ── selection → Ask / Highlight / Note ──
  const onMouseUp = () => {
    const s = window.getSelection()
    const text = s?.toString().trim() ?? ''
    if (!s || text.length < 2 || !s.rangeCount) { setSel(null); return }
    const node = s.anchorNode instanceof Element ? s.anchorNode : s.anchorNode?.parentElement
    const blockEl = node?.closest<HTMLElement>('[data-block]')
    const pageEl = node?.closest<HTMLElement>('[data-page]')
    if (!pageEl) { setSel(null); return }
    const rect = s.getRangeAt(0).getBoundingClientRect()
    setSel({ text: text.slice(0, 1500), pageNo: Number(pageEl.dataset.page), blockId: blockEl?.dataset.block ?? null, x: rect.left + rect.width / 2, y: rect.top })
  }
  const annotate = async (kind: 'highlight' | 'bookmark' | 'note', pageNo: number, blockId: string | null, quote: string | null, note: string | null = null) => {
    const r = await act.run(() => api.post<{ id: string }>(`${S}/books/${book.id}/annotations`, { kind, pageNo, blockId, quote, note }))
    if (r) setAnn((a) => [...a, { id: r.id, pageNo, blockId, kind, color: kind === 'highlight' ? 'yellow' : null, quote, note }])
    setSel(null)
    window.getSelection()?.removeAllRanges()
  }
  const toggleBookmark = async (pageNo: number) => {
    const bm = ann.find((a) => a.kind === 'bookmark' && a.pageNo === pageNo)
    if (bm) { if (await act.run(() => api.del(`${S}/books/${book.id}/annotations/${bm.id}`)) !== undefined) setAnn((a) => a.filter((x) => x.id !== bm.id)) }
    else await annotate('bookmark', pageNo, null, null)
  }

  // practice opens OUTSIDE the book, offered once a section is finished (not mid-explanation)
  const practiceAfter = (n: number): string | null => {
    const sec = sectionOf(n)
    if (!sec || byPage.get(n + 1)?.sectionId === sec.id) return null
    return `/practice/${book.courseId}${sec.conceptId ? `?conceptId=${sec.conceptId}` : ''}`
  }
  const interrupted = state.interruption
  return (
    <>
    <BreakReminder />
    <div ref={deskRef} className="book-desk grid gap-4 xl:grid-cols-[minmax(0,1fr)_23rem]">
      <div className="min-w-0">
        <header className="mb-3 flex flex-wrap items-center gap-3">
          <Link to="/studio" className="text-sm text-accent">← Studio</Link>
          <h1 className="font-serif text-2xl leading-tight" tabIndex={-1}>{book.title}</h1>
          <span className="book-chip">{book.mode === 'source' ? 'From your material' : 'Built for you'}</span>
          <Link to={`/studio/${book.id}/package`} className="ml-auto text-sm font-semibold text-accent underline">Chapter package</Link>
          <Button onClick={toggleFull} aria-pressed={full}>{full ? 'Exit full screen' : 'Full screen'}</Button>
        </header>

        {/* lecture bar */}
        <div className="sticky top-0 z-20 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface/95 p-2 backdrop-blur" role="toolbar" aria-label="Lesson controls">
          <label className="sr-only" htmlFor="bk-mode">Study mode</label>
          <select id="bk-mode" value={state.mode} onChange={(e) => setMode(e.target.value as StudyMode)} className={`${inputCls} w-auto min-h-10 py-1`}>
            {MODES.map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
          </select>
          <Button onClick={back} aria-label="Previous part">◀</Button>
          {listens(state.mode) ? (playing ? <Button onClick={hold}>Pause</Button> : <Button variant="primary" onClick={play}>{lecture.blockId ? 'Play' : 'Start lesson'}</Button>) : null}
          <Button variant={listens(state.mode) ? 'secondary' : 'primary'} busy={gen.busy} onClick={() => void step()}>{lecture.blockId ? 'Continue' : 'Start lesson'}</Button>
          {listens(state.mode) ? <Button onClick={replay} disabled={!lecture.blockId}>Replay</Button> : null}
          <span className="mx-1 h-6 w-px bg-line" aria-hidden />
          <Button onClick={() => goPage(cur - (wide ? 2 : 1))} disabled={cur <= 1} aria-label="Previous page">‹</Button>
          <span className="text-sm tabular-nums" aria-live="polite">Page {shown.filter((n) => n <= Math.max(total, 1)).join('–') || 1} of {Math.max(total, 1)}</span>
          <Button onClick={() => goPage(cur + (wide ? 2 : 1))} disabled={!total || left + (wide ? 2 : 1) > total} aria-label="Next page">›</Button>
          <span className="mx-1 h-6 w-px bg-line" aria-hidden />
          <Button onClick={() => setZoom((z) => Math.max(0.8, +(z - 0.1).toFixed(2)))} aria-label="Zoom out">−</Button>
          <span className="w-12 text-center text-sm tabular-nums">{Math.round(zoom * 100)}%</span>
          <Button onClick={() => setZoom((z) => Math.min(1.6, +(z + 0.1).toFixed(2)))} aria-label="Zoom in">+</Button>
          {interrupted ? <Button className="ml-auto" onClick={() => void resume()}>Back to the lesson (p. {interrupted.returnTo.pageNo})</Button> : null}
        </div>
        {gen.error ? <ErrorNote error={gen.error} /> : null}

        <div className="book-stage overflow-x-auto" onMouseUp={onMouseUp}
          onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5; e.currentTarget.style.setProperty('--tilt-y', `${(x * 2.2).toFixed(2)}deg`); e.currentTarget.style.setProperty('--tilt-x', `${(-y * 1.6).toFixed(2)}deg`) }}
          onMouseLeave={(e) => { e.currentTarget.style.setProperty('--tilt-y', '0deg'); e.currentTarget.style.setProperty('--tilt-x', '0deg') }}>
          <div className="book-zoom origin-top" style={{ transform: zoom === 1 ? undefined : `scale(${zoom})`, width: zoom > 1 ? `${100 / zoom}%` : undefined }}>
            {!pages.length && !live ? (
              <div className="book-page grid place-items-center text-center">
                <div className="max-w-md">
                  <p className="font-serif text-2xl">{book.title}</p>
                  <p className="mt-2 text-sm" style={{ color: 'var(--paper-muted)' }}>{outline.length} sections planned{book.mode === 'source' ? ' from your material' : ''}. Press <b>Start lesson</b> and the first section will be written into the book as you watch.</p>
                  <ol className="mt-4 grid gap-1 text-left text-sm">{outline.map((s, i) => <li key={s.id}>{i + 1}. {s.title}{s.pageStart ? <span style={{ color: 'var(--paper-muted)' }}> · pp. {s.pageStart}{s.pageEnd && s.pageEnd !== s.pageStart ? `–${s.pageEnd}` : ''}</span> : null}</li>)}</ol>
                </div>
              </div>
            ) : (
              <div className={`book-spread ${wide ? 'two' : ''} ${flip}`} key={left}>
                {(live ? [...shown.filter((n) => byPage.has(n)).slice(0, wide ? 1 : 0), -1] : shown).map((n) => n === -1
                  ? <LivePage key="live" live={live!} />
                  : byPage.has(n)
                    ? <BookPage key={n} page={byPage.get(n)!} section={sectionOf(n)?.title ?? ''} courseId={book.courseId} bookId={book.id} lecture={lecture} flash={flash} ann={ann}
                        bookmarked={ann.some((a) => a.kind === 'bookmark' && a.pageNo === n)} onBookmark={() => void toggleBookmark(n)} practice={practiceAfter(n)}
                        onAskBlock={(b) => { setAttached({ text: b.term ? `${b.term}: ${b.text}` : b.text, pageNo: n, blockId: b.id }); setPanel('tutor'); window.setTimeout(() => document.getElementById('msg-dock')?.focus(), 50) }}
                        onGoto={(p) => { show(p); if (p.blockId) { setFlash(p.blockId); window.setTimeout(() => setFlash(null), 1600) } }} />
                    : <div key={n} className="book-page" aria-hidden />)}
              </div>
            )}
          </div>
        </div>

        {sel ? (
          <div className="book-select-pop flex gap-1 rounded-lg border border-line bg-surface p-1 shadow-lg" style={{ left: sel.x, top: sel.y }} role="toolbar" aria-label="Selected text">
            <Button variant="primary" onMouseDown={(e) => e.preventDefault()} onClick={() => { setAttached({ text: sel.text, pageNo: sel.pageNo, blockId: sel.blockId }); setSel(null); setPanel('tutor'); window.setTimeout(() => document.getElementById('msg-dock')?.focus(), 50) }}>Ask</Button>
            <Button onMouseDown={(e) => e.preventDefault()} onClick={() => void annotate('highlight', sel.pageNo, sel.blockId, sel.text)}>Highlight</Button>
            <Button onMouseDown={(e) => e.preventDefault()} onClick={() => { const note = window.prompt('Your note'); if (note) void annotate('note', sel.pageNo, sel.blockId, sel.text, note) }}>Note</Button>
          </div>
        ) : null}
      </div>

      {/* side panel: tutor, notebook, contents, search */}
      <aside className="flex min-h-[28rem] flex-col rounded-xl border border-line bg-surface xl:sticky xl:top-2 xl:h-[calc(100dvh-1rem)]" aria-label="Study panel">
        <div role="tablist" aria-label="Panel" className="flex border-b border-line">
          {(['tutor', 'notes', 'contents', 'search'] as Panel[]).map((p) => (
            <button key={p} role="tab" aria-selected={panel === p} onClick={() => setPanel(p)} className={`min-h-11 flex-1 text-sm font-semibold capitalize ${panel === p ? 'border-b-2 border-accent text-accent' : 'text-muted'}`}>{p === 'notes' ? 'Notebook' : p}</button>
          ))}
        </div>
        <div className={`min-h-0 flex-1 ${panel === 'tutor' ? 'flex flex-col' : 'overflow-y-auto p-3'}`} role="tabpanel">
          {panel === 'tutor' ? (
            <UniversalChat variant="dock" book={{ bookId: book.id, courseId: book.courseId, pageNo: attached?.pageNo ?? cur, blockId: attached?.blockId ?? null, selection: attached?.text ?? null,
              onClearSelection: () => setAttached(null), onAnswer, onResume: () => void resume(), notice }} />
          ) : panel === 'notes' ? (
            <NotebookPanel bookId={book.id} nb={nb} onSaved={setNb} />
          ) : panel === 'contents' ? (
            <ol className="grid gap-2">
              {outline.map((s, i) => (
                <li key={s.id} className="rounded-lg border border-line p-2 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <span><span className="text-muted">{i + 1}.</span> {s.title}</span>
                    {s.status === 'ready' ? <button className="shrink-0 text-accent underline" onClick={() => goPage(s.firstPage ?? 1)}>p. {s.firstPage}</button>
                      : s.status === 'generating' ? <span className="shrink-0 text-muted">writing…</span>
                        : <button className="shrink-0 text-accent underline" disabled={gen.busy} onClick={() => void writeSection(s.id)}>Write it</button>}
                  </div>
                </li>
              ))}
              {ann.some((a) => a.kind === 'bookmark') ? <li className="mt-2 text-sm"><p className="font-semibold">Bookmarks</p>{ann.filter((a) => a.kind === 'bookmark').map((a) => <button key={a.id} className="mr-2 text-accent underline" onClick={() => goPage(a.pageNo)}>p. {a.pageNo}</button>)}</li> : null}
            </ol>
          ) : (
            <SearchPanel pages={pages} onGo={(p) => { show(p); if (p.blockId) { setFlash(p.blockId); window.setTimeout(() => setFlash(null), 1600) } }} />
          )}
        </div>
      </aside>
    </div>
    </>
  )
}

/** A gentle, dismissible break suggestion after 45 minutes of continuous study (no streak or score pressure). */
function BreakReminder() {
  const [show, setShow] = useState(false)
  useEffect(() => {
    let since = Date.now()
    const t = window.setInterval(() => { if (Date.now() - since >= 45 * 60_000) { setShow(true); since = Date.now() } }, 60_000)
    return () => window.clearInterval(t)
  }, [])
  if (!show) return null
  return (
    <div role="status" className="fixed bottom-4 left-1/2 z-50 flex max-w-md -translate-x-1/2 items-center gap-3 rounded-xl border border-line bg-surface p-3 text-sm shadow-lg">
      <span>You have been studying for 45 minutes. A 5-minute break (water, a short walk) helps the last part stick.</span>
      <button type="button" className="font-semibold text-accent" onClick={() => setShow(false)}>OK</button>
    </div>
  )
}

function Label({ b, courseId }: { b: Block; courseId: string }) {
  if (b.label === 'source' && b.cites[0]) {
    const c = b.cites[0]
    return <Link to={`/app/education/tutor/courses/${courseId}/materials/${c.documentId}/${c.page}`} className="book-chip source" title="Open the original page">From {c.filename}, p. {c.page}</Link>
  }
  return <span className={`book-chip ${b.label === 'uncertain' ? 'uncertain' : ''}`}>{b.label === 'uncertain' ? 'Not certain — check' : 'AI explanation'}</span>
}

function marked(text: string, quotes: string[]): ReactNode {
  const q = quotes.find((x) => x && text.includes(x))
  if (!q) return text
  const i = text.indexOf(q)
  return <>{text.slice(0, i)}<mark>{q}</mark>{marked(text.slice(i + q.length), quotes.filter((x) => x !== q))}</>
}

function BlockBody({ b, quotes, courseId, bookId, onGoto }: { b: Block; quotes: string[]; courseId: string; bookId: string; onGoto: (p: Position) => void }) {
  const t = marked(b.text, quotes)
  switch (b.type) {
    case 'heading': return <h2>{b.text}</h2>
    case 'definition': return <p><dfn className="font-semibold not-italic">{b.term}</dfn> — {t}</p>
    case 'formula': return <p className="math-block whitespace-pre-wrap">{t}</p>
    case 'example': return <div><p className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--paper-muted)' }}>Example</p><p>{t}</p></div>
    case 'tip': return <p className="rounded-lg border border-dashed p-2" style={{ borderColor: 'var(--paper-edge)' }}><span aria-hidden>💡 </span><span className="font-semibold">Remember: </span>{t}</p>
    case 'exam': return <p className="rounded-lg p-2" style={{ background: 'var(--color-warn-bg)', color: 'var(--color-warn)' }}><span className="font-semibold">Exam point: </span>{t}</p>
    case 'summary': return <div className="rounded-lg p-3" style={{ background: 'color-mix(in srgb, var(--lecture) 10%, transparent)' }}><p className="font-semibold">In short</p><p>{t}</p></div>
    case 'excerpt': return <blockquote className="border-l-4 pl-3 italic" style={{ borderColor: 'var(--paper-edge)' }}>{t}</blockquote>
    case 'list': return <div>{b.text ? <p>{t}</p> : null}<ul className="list-disc pl-5">{(b.items ?? []).map((x, i) => <li key={i}>{marked(x, quotes)}</li>)}</ul></div>
    case 'figure': return b.figure?.thumb ? (
      <figure>
        <img src={b.figure.thumb} alt={b.figure.alt} width={b.figure.width || undefined} height={b.figure.height || undefined} loading="lazy" decoding="async" className="mx-auto max-h-80 w-auto rounded-md bg-white" />
        <figcaption className="mt-1 text-sm"><span className="font-semibold">{b.figure.caption}</span>{b.text && b.text !== b.figure.caption ? <span className="block">{b.text}</span> : null}<span className="block text-xs" style={{ color: 'var(--paper-muted)' }}>
          {b.figure.credit} · {b.figure.pageUrl ? <a href={b.figure.pageUrl} target="_blank" rel="noreferrer noopener" className="underline">source</a> : null}{b.figure.licenseUrl ? <> · <a href={b.figure.licenseUrl} target="_blank" rel="noreferrer noopener" className="underline">licence</a></> : null}
        </span></figcaption>
      </figure>
    ) : null
    case 'activity': return <ActivityBlock b={b} bookId={bookId} courseId={courseId} onGoto={onGoto} />
    default: return <p>{t}</p>
  }
}

function BookPage({ page, section, courseId, bookId, lecture, flash, ann, bookmarked, onBookmark, onAskBlock, onGoto, practice }: {
  practice: string | null
  page: Page; section: string; courseId: string; bookId: string; lecture: Position; flash: string | null; ann: Annotation[]
  bookmarked: boolean; onBookmark: () => void; onAskBlock: (b: Block) => void; onGoto: (p: Position) => void
}) {
  return (
    <article className="book-page" data-page={page.pageNo} aria-label={`Page ${page.pageNo}`}>
      <button type="button" className={`book-ribbon ${bookmarked ? 'on' : ''}`} aria-pressed={bookmarked} aria-label={bookmarked ? 'Remove bookmark' : 'Bookmark this page'} onClick={onBookmark} />
      <p className="mb-3 text-xs uppercase tracking-wide" style={{ color: 'var(--paper-muted)' }}>{section}</p>
      {page.blocks.map((b) => {
        const quotes = ann.filter((a) => a.blockId === b.id && a.quote && a.kind !== 'bookmark').map((a) => a.quote!)
        return (
          <section key={b.id} id={`blk-${b.id}`} data-block={b.id} data-type={b.type} className={`book-block group ${lecture.blockId === b.id ? 'is-lecture' : ''} ${flash === b.id ? 'flash' : ''}`}>
            <BlockBody b={b} quotes={quotes} courseId={courseId} bookId={bookId} onGoto={onGoto} />
            {b.type !== 'heading' ? (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <Label b={b} courseId={courseId} />
                {b.type !== 'activity' ? <button type="button" className="book-chip opacity-70 hover:opacity-100 focus:opacity-100" onClick={() => onAskBlock(b)}>Ask about this</button> : null}
                {ann.filter((a) => a.blockId === b.id && a.kind === 'note').map((a) => <span key={a.id} className="book-chip" title={a.quote ?? ''}>📝 {a.note}</span>)}
              </div>
            ) : null}
          </section>
        )
      })}
      {practice ? (
        <aside className="book-practice">
          <p className="font-serif text-lg">End of this part</p>
          <p className="text-sm" style={{ color: 'var(--paper-muted)' }}>When you feel ready, try a few questions — with step-by-step hints or the full solution, your choice.</p>
          <Link to={practice} className="uc-action mt-2 inline-flex">Practise this topic <span aria-hidden>→</span></Link>
        </aside>
      ) : null}
      <p className="absolute bottom-3 left-0 right-0 text-center text-xs tabular-nums" style={{ color: 'var(--paper-muted)' }}>{page.pageNo}</p>
    </article>
  )
}

function LivePage({ live }: { live: { title: string; blocks: Block[]; files: string[] } }) {
  return (
    <article className="book-page" aria-busy="true" aria-label="Page being written">
      <p className="mb-3 text-xs uppercase tracking-wide" style={{ color: 'var(--paper-muted)' }}>Writing: {live.title}{live.files.length ? ` · from ${live.files.join(', ')}` : ''}</p>
      {live.blocks.map((b) => <section key={b.id} className="book-block streamed"><BlockBody b={b} quotes={[]} courseId="" bookId="" onGoto={() => {}} /></section>)}
      <p role="status" className="text-sm" style={{ color: 'var(--paper-muted)' }}>✎ The tutor is writing this section…</p>
    </article>
  )
}

function ActivityBlock({ b, bookId, onGoto }: { b: Block; bookId: string; courseId: string; onGoto: (p: Position) => void }) {
  const a = b.activity!
  const [ans, setAns] = useState('')
  const [res, setRes] = useState<AnswerResult | null>(null)
  const run = useAction()
  const submit = async () => {
    const r = await run.run(() => api.post<AnswerResult>(`${S}/books/${bookId}/activities/${b.id}/answer`, { answer: a.kind === 'mcq' ? Number(ans) : ans }))
    if (r) setRes(r)
  }
  return (
    <div className="rounded-lg border p-3" style={{ borderColor: 'var(--paper-edge)' }}>
      <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--paper-muted)' }}>Quick check</p>
      <p className="mt-1 font-semibold">{a.prompt}</p>
      <form className="mt-2 grid gap-2" onSubmit={(e) => { e.preventDefault(); void submit() }}>
        {a.kind === 'mcq' ? (a.options ?? []).map((o, i) => (
          <label key={i} className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-1">
            <input type="radio" name={`q-${b.id}`} value={i} checked={ans === String(i)} onChange={() => setAns(String(i))} className="accent-[var(--color-accent)]" />
            <span>{String.fromCharCode(65 + i)}. {o}</span>
          </label>
        )) : a.kind === 'explain'
          ? <textarea aria-label="Your explanation" rows={3} value={ans} onChange={(e) => setAns(e.target.value)} className={inputCls} />
          : <span className="flex items-center gap-2"><input aria-label="Your answer" value={ans} onChange={(e) => setAns(e.target.value)} className={`${inputCls} w-48`} />{a.unit ? <span>{a.unit}</span> : null}</span>}
        <Button type="submit" variant="primary" busy={run.busy} disabled={!ans.trim()} className="justify-self-start">Check</Button>
      </form>
      {run.error ? <p className="mt-2 text-sm text-danger">{describeError(run.error)}</p> : null}
      {res ? (
        <div role="status" className="mt-2 grid gap-1 text-sm">
          <p className={`font-semibold ${res.verdict === 'correct' ? 'text-ok' : res.verdict === 'partial' ? 'text-warn' : 'text-danger'}`}>{res.verdict === 'correct' ? 'Correct!' : res.verdict === 'partial' ? 'Partly right.' : 'Not quite.'}</p>
          {res.feedback ? <p>{res.feedback}</p> : null}
          {res.hint ? <p><b>Hint:</b> {res.hint} <span className="text-muted">Try again.</span></p> : null}
          {res.correct ? <p><b>Answer:</b> {res.correct.option !== undefined ? `${String.fromCharCode(65 + res.correct.option)}. ${a.options?.[res.correct.option] ?? ''}` : res.correct.value !== undefined ? `${res.correct.value}${res.correct.unit ? ` ${res.correct.unit}` : ''}` : res.correct.text}</p> : null}
          {res.explanation ? <p>{res.explanation}</p> : null}
          {res.verdict !== 'correct' && res.refBlockId ? <button type="button" className="justify-self-start text-accent underline" onClick={() => onGoto({ pageNo: res.pageNo, blockId: res.refBlockId })}>Re-read the part that explains this</button> : null}
          {res.revisionCard ? <p className="text-muted">Added to your revision cards.</p> : null}
          {res.guidance.length ? <p className="flex flex-wrap gap-2">{res.guidance.map((g) => <Link key={g.href} to={g.href} className="text-accent underline">{g.label}</Link>)}</p> : null}
        </div>
      ) : null}
    </div>
  )
}

function NotebookPanel({ bookId, nb, onSaved }: { bookId: string; nb: { version: number; doc: Notebook }; onSaved: (n: { version: number; doc: Notebook }) => void }) {
  const [doc, setDoc] = useState(nb.doc)
  const [dirty, setDirty] = useState(false)
  const save = useAction()
  useEffect(() => { if (!dirty) setDoc(nb.doc) }, [nb, dirty])
  const edit = (i: number, field: 'myNotes' | 'summary', value: string) => { setDirty(true); setDoc((d) => ({ ...d, topics: d.topics.map((t, j) => (j === i ? { ...t, [field]: value } : t)) })) }
  const exportMd = () => {
    const blob = new Blob([notebookMarkdown(doc)], { type: 'text/markdown' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${doc.title.replace(/[^\w\- ]+/g, '').trim() || 'notebook'}.md`
    a.click()
    URL.revokeObjectURL(a.href)
  }
  const submit = async () => {
    const r = await save.run(() => api.put<{ version: number }>(`${S}/books/${bookId}/notebook`, { doc, version: nb.version }))
    if (r) { setDirty(false); onSaved({ version: r.version, doc }) }
  }
  const list = (h: string, xs: string[]) => (xs.length ? <><p className="mt-2 text-xs font-semibold uppercase tracking-wide text-muted">{h}</p><ul className="list-disc pl-5">{xs.map((x, i) => <li key={i}>{x}</li>)}</ul></> : null)
  return (
    <div className="grid gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-serif text-lg">{doc.title}</p>
        <span className="text-xs text-muted">v{nb.version}</span>
        <Button className="ml-auto" onClick={exportMd}>Export .md</Button>
        {dirty ? <Button variant="primary" busy={save.busy} onClick={() => void submit()}>Save</Button> : null}
      </div>
      {save.error ? <ErrorNote error={save.error} /> : null}
      {!doc.topics.length ? <p className="text-muted">Notes appear here as each section is taught: definitions, formulae, examples, memory tricks, exam points, your doubts and practice.</p> : null}
      {doc.topics.map((t, i) => (
        <section key={t.id} className="rounded-lg border border-line p-3">
          <h3 className="font-semibold">{t.title}</h3>
          {t.definitions.length ? <><p className="mt-2 text-xs font-semibold uppercase tracking-wide text-muted">Definitions</p><dl>{t.definitions.map((d) => <div key={d.term}><dt className="inline font-semibold">{d.term}: </dt><dd className="inline">{d.text}</dd></div>)}</dl></> : null}
          {list('Key points', t.keyPoints)}{list('Formulae', t.formulae)}{list('Examples', t.examples)}{list('Memory tricks', t.memoryTricks)}{list('Exam points', t.examPoints)}{list('Practice', t.practice)}
          {t.doubts.length ? <><p className="mt-2 text-xs font-semibold uppercase tracking-wide text-muted">My doubts</p><ul className="grid gap-1">{t.doubts.map((d, j) => <li key={j}><b>Q:</b> {d.q}<br /><span className="text-muted"><b>A:</b> {d.a}</span></li>)}</ul></> : null}
          {t.summary ? <p className="mt-2 italic">{t.summary}</p> : null}
          <label className="mt-2 block text-xs font-semibold uppercase tracking-wide text-muted" htmlFor={`mn-${t.id}`}>My notes</label>
          <textarea id={`mn-${t.id}`} rows={2} value={t.myNotes} onChange={(e) => edit(i, 'myNotes', e.target.value)} className={inputCls} />
        </section>
      ))}
    </div>
  )
}

function SearchPanel({ pages, onGo }: { pages: Page[]; onGo: (p: Position) => void }) {
  const [q, setQ] = useState('')
  const hits = useMemo(() => searchBook(pages, q), [pages, q])
  return (
    <div className="grid gap-2">
      <label htmlFor="bk-search" className="text-sm font-semibold">Search this book</label>
      <input id="bk-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} className={inputCls} placeholder="word or phrase" />
      <p className="text-xs text-muted" aria-live="polite">{q.trim().length >= 2 ? `${hits.length} result(s) in ${flatBlocks(pages).length} paragraphs` : ''}</p>
      <ul className="grid gap-1">{hits.map((h) => <li key={h.blockId}><button type="button" className="w-full rounded-md p-2 text-left text-sm hover:bg-surface-2" onClick={() => onGo({ pageNo: h.pageNo, blockId: h.blockId })}><span className="text-muted">p. {h.pageNo}</span> {h.snippet}</button></li>)}</ul>
    </div>
  )
}

/** The book teaches; questions live in the practice space (formative checks are not shown inside the book). */
function lessonOnly(ps: Page[]): Page[] { return ps.map((p) => ({ ...p, blocks: p.blocks.filter((b) => b.type !== 'activity') })) }
