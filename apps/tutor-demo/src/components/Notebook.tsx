import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { nextPosition, type Block, type BookView, type Page, type Position, type StudioState } from '../../../web/src/lib/studio.ts'
import type { ConceptGraph } from '../../../web/src/lib/tutor.ts'
import { DemoError, friendly, get, post, S, streamSection, TUTOR } from '../lib/client.ts'
import type { Destination, View } from '../lib/logic.ts'
import type { Tutor } from '../lib/useTutor.ts'
import { LiveClassroom } from '../live/LiveClassroom.tsx'
import { BookStage } from './BookStage.tsx'
import { Icon } from './Icon.tsx'
import { MathText } from './RichText.tsx'

interface BookRow { id: string; title: string; courseId: string; sections: number; ready: number }
const lessonOnly = (ps: Page[]) => ps.map((p) => ({ ...p, blocks: p.blocks.filter((b) => b.type !== 'activity') }))

export function Notebook({ tutor, target, open, askTutor, go }: { tutor: Tutor; target: Extract<Destination, { view: 'notebook' }> | null; open: (d: Destination) => void; askTutor: () => void; go: (v: View) => void }) {
  const [books, setBooks] = useState<BookRow[] | null>(null)
  const [bookId, setBookId] = useState<string | null>(target?.bookId ?? null)
  const [error, setError] = useState<string | null>(null)
  const { fail } = tutor
  useEffect(() => {
    const ctl = new AbortController()
    void (async () => {
      try {
        const list = await get<BookRow[]>(`${S}/books`, ctl.signal)
        setBooks(list)
        if (target?.bookId) { setBookId(target.bookId); return }
        if (target?.courseId && target.conceptId) {
          // a "lesson" link from the Tutor: open or create that topic's book
          const g = await get<ConceptGraph>(`${TUTOR}/courses/${target.courseId}/concepts`, ctl.signal)
          const name = g.concepts.find((c) => c.id === target.conceptId)?.name
          if (!name) throw new DemoError('not_found', 'That topic is no longer in the course.')
          const have = list.find((b) => b.courseId === target.courseId && b.title.trim().toLowerCase() === name.trim().toLowerCase())
          setBookId(have?.id ?? (await post<{ id: string }>(`${S}/books`, { courseId: target.courseId, title: name, language: tutor.language })).id)
          return
        }
        if (list.length === 1) setBookId(list[0]!.id)
      } catch (e) { if (!ctl.signal.aborted) { fail(e); setError(friendly(e)) } }
    })()
    return () => ctl.abort()
  }, [target, fail, tutor.language])

  if (bookId) return <BookDesk key={bookId} bookId={bookId} teach={!!target?.teach && target.bookId === bookId} tutor={tutor} open={open} askTutor={askTutor} back={books && books.length > 1 ? () => setBookId(null) : null} />
  return (
    <div className="td-view">
      <header className="td-view-head"><p className="td-eyebrow">Interactive notebook</p><h1>Your lessons</h1><p>Lessons are written section by section, and remember exactly where you stopped.</p></header>
      {error ? <p role="alert" className="td-alert">{error}</p> : null}
      {!books && !error ? <div className="td-skeleton" aria-label="Loading notebooks"><i /><i /><i /></div> : null}
      {books?.length === 0 ? <div className="td-empty"><Icon name="book" /><h2>No notebook yet</h2><p>A notebook opens after you approve a roadmap with the Tutor.</p><div className="td-row"><button type="button" className="td-primary" onClick={() => go('document')}>Start from a document</button><button type="button" className="td-ghost" onClick={askTutor}>Tell the Tutor your goal</button></div></div> : null}
      {books?.length ? <ul className="td-books">{books.map((b) => <li key={b.id}><button type="button" onClick={() => setBookId(b.id)}><strong>{b.title}</strong><small>{b.ready} of {b.sections} sections written</small><span className="td-bar"><i style={{ width: `${b.sections ? (b.ready / b.sections) * 100 : 0}%` }} /></span></button></li>)}</ul> : null}
    </div>
  )
}

function BookDesk({ bookId, teach, tutor, open, askTutor, back }: { bookId: string; teach: boolean; tutor: Tutor; open: (d: Destination) => void; askTutor: () => void; back: (() => void) | null }) {
  const [data, setData] = useState<BookView | null>(null)
  const [pages, setPages] = useState<Page[]>([])
  const [state, setState] = useState<StudioState | null>(null)
  const [cur, setCur] = useState(1)
  const [turn, setTurn] = useState<'next' | 'prev'>('next')
  const [live, setLive] = useState<{ title: string; blocks: Block[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selection, setSelection] = useState<{ text: string; pageNo: number; blockId: string | null; x: number; y: number } | null>(null)
  const [liveAt, setLiveAt] = useState<{ sectionId: string; pageNo: number; blockId: string | null } | null>(null)
  const abort = useRef<AbortController | null>(null)
  const { setBookContext, fail } = tutor

  const load = useCallback(async (signal?: AbortSignal) => {
    const v = await get<BookView>(`${S}/books/${bookId}`, signal)
    setData(v); setPages(lessonOnly(v.pages)); setState(v.book.state)
    setCur(Math.max(1, v.book.state.lecture.pageNo || 1))
  }, [bookId])
  useEffect(() => {
    const ctl = new AbortController()
    load(ctl.signal).catch((e) => { if (!ctl.signal.aborted) { fail(e); setError(friendly(e)) } })
    return () => { ctl.abort(); abort.current?.abort() }
  }, [load, fail])
  const hasPages = pages.length > 0
  useEffect(() => { setBookContext(hasPages ? { bookId, pageNo: cur, blockId: null, selection: null } : null) }, [bookId, cur, hasPages, setBookContext])
  // after a doubt is answered the server's lesson state (detour, way back) has changed
  const replies = tutor.messages.length
  useEffect(() => { if (data) void get<BookView>(`${S}/books/${bookId}`).then((v) => setState(v.book.state), () => undefined) }, [replies]) // eslint-disable-line react-hooks/exhaustive-deps

  const byPage = useMemo(() => new Map(pages.map((p) => [p.pageNo, p])), [pages])
  const total = pages.length ? Math.max(...pages.map((p) => p.pageNo)) : 0
  const outline = data?.book.outline ?? []
  const page = byPage.get(cur)
  const pendingSection = outline.find((s) => s.status !== 'ready')
  const goTo = (n: number) => { if (n < 1 || (total && n > total)) return; setTurn(n >= cur ? 'next' : 'prev'); setCur(n); setSelection(null); void post(`${S}/books/${bookId}/events`, { kind: 'view', pageNo: n }).then((r) => setState((r as { state: StudioState }).state), () => undefined) }

  const write = async (sectionId: string, teachAfter = false) => {
    if (live) return
    const s = outline.find((x) => x.id === sectionId)
    setError(null); setLive({ title: s?.title ?? 'Next section', blocks: [] })
    const ctl = new AbortController()
    abort.current = ctl
    try {
      const fresh = lessonOnly(await streamSection(bookId, sectionId, (b) => { if (b.type !== 'activity') setLive((l) => (l ? { ...l, blocks: [...l.blocks, b] } : l)) }, ctl.signal))
      await load()
      if (fresh[0]) { setTurn('next'); setCur(fresh[0].pageNo); if (teachAfter) setLiveAt({ sectionId, pageNo: fresh[0].pageNo, blockId: fresh[0].blocks[0]?.id ?? null }) }
    } catch (e) { if (!(e instanceof DemoError && e.code === 'cancelled')) { fail(e); setError(friendly(e)) } } finally { setLive(null) }
  }
  const advance = async () => {
    if (!state) return
    const n = nextPosition(pages, state.lecture.blockId ? state.lecture : { pageNo: state.lecture.pageNo, blockId: null })
    if (!n) { if (pendingSection) await write(pendingSection.id); return }
    try {
      const r = await post<{ state: StudioState }>(`${S}/books/${bookId}/events`, { kind: 'advance', pageNo: n.pageNo, blockId: n.blockId })
      setState(r.state)
      if (n.pageNo !== cur) { setTurn('next'); setCur(n.pageNo) }
      window.setTimeout(() => document.getElementById(`td-b-${n.blockId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60)
    } catch (e) { fail(e); setError(friendly(e)) }
  }
  /** the main way forward: Vidya teaches from exactly where the student is, and writes the next section if needed */
  const continueWithVidya = () => {
    if (!state || live) return
    const n = nextPosition(pages, state.lecture.blockId ? state.lecture : { pageNo: state.lecture.pageNo, blockId: null })
    if (!n) { if (pendingSection) void write(pendingSection.id, true); return }
    const sectionId = byPage.get(n.pageNo)?.sectionId
    if (!sectionId) return
    if (n.pageNo !== cur) { setTurn('next'); setCur(n.pageNo) }
    setLiveAt({ sectionId, pageNo: n.pageNo, blockId: n.blockId })
  }
  // the journey was just prepared: Vidya takes over once, writing the first section if it is not there yet
  const taught = useRef(false)
  useEffect(() => { if (teach && !taught.current && state && data) { taught.current = true; continueWithVidya() } }) // eslint-disable-line react-hooks/exhaustive-deps
  const closeVidya = (reached: { pageNo: number; blockId: string } | null) => {
    setLiveAt(null)
    // what she taught counts as the reading position, so Continue always picks up from there
    const saved = reached ? post(`${S}/books/${bookId}/events`, { kind: 'advance', pageNo: reached.pageNo, blockId: reached.blockId }).catch(() => undefined) : Promise.resolve()
    void saved.then(() => load()).catch(() => undefined)
  }
  const resume = async () => {
    try {
      const r = await post<{ state: StudioState; position: Position }>(`${S}/books/${bookId}/resume`)
      setState(r.state); setTurn('prev'); setCur(r.position.pageNo)
      window.setTimeout(() => document.getElementById(`td-b-${r.position.blockId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60)
    } catch (e) { fail(e); setError(friendly(e)) }
  }
  const askAbout = (text: string, pageNo: number, blockId: string | null) => { setBookContext({ bookId, pageNo, blockId, selection: text.slice(0, 1500) }); setSelection(null); askTutor(); window.setTimeout(() => document.getElementById('td-msg')?.focus(), 80) }
  const onSelect = () => {
    const s = window.getSelection()
    const text = s?.toString().trim() ?? ''
    if (!s || text.length < 2 || !s.rangeCount) { setSelection(null); return }
    const node = s.anchorNode instanceof Element ? s.anchorNode : s.anchorNode?.parentElement
    if (!node?.closest('[data-page]')) { setSelection(null); return }
    const rect = s.getRangeAt(0).getBoundingClientRect()
    setSelection({ text, pageNo: cur, blockId: node.closest<HTMLElement>('[data-block]')?.dataset.block ?? null, x: rect.left + rect.width / 2, y: rect.top })
  }

  if (error && !data) return <div className="td-view"><p role="alert" className="td-alert">{error}</p></div>
  if (!data || !state) return <div className="td-view"><div className="td-skeleton" aria-label="Opening notebook"><i /><i /><i /></div></div>
  return (
    <div className="td-notebook">
      <nav className="td-toc" aria-label="Sections">
        {back ? <button type="button" className="td-text-btn" onClick={back}>All notebooks</button> : null}
        <h1>{data.book.title}</h1>
        <small>{data.book.mode === 'source' ? 'From your document' : 'Prepared by the Tutor'}</small>
        <ol>{outline.map((s, i) => <li key={s.id} className={s.id === page?.sectionId ? 'is-active' : ''}>{s.status === 'ready' ? <button type="button" onClick={() => goTo(s.firstPage ?? 1)}><span>{i + 1}</span>{s.title}</button> : <button type="button" disabled={!!live} onClick={() => void write(s.id)}><span>{i + 1}</span>{s.title}<em>{live?.title === s.title ? 'Writing…' : 'Write'}</em></button>}</li>)}</ol>
      </nav>
      <div className="td-desk">
        <div className="td-lesson-bar" role="toolbar" aria-label="Lesson controls">
          <button type="button" className="td-icon-btn" onClick={() => goTo(cur - 1)} disabled={cur <= 1 || !!live} aria-label="Previous page">‹</button>
          <span aria-live="polite">{total ? `Page ${cur} of ${total}` : 'Not started'}</span>
          <button type="button" className="td-icon-btn" onClick={() => goTo(cur + 1)} disabled={!total || cur >= total || !!live} aria-label="Next page">›</button>
          {state.interruption ? <button type="button" className="td-ghost" onClick={() => void resume()}>Back to the lesson (p. {state.interruption.returnTo.pageNo})</button> : null}
          <button type="button" className="td-read" onClick={() => void advance()} disabled={!!live || (!total && !pendingSection)}>Read</button>
          <button type="button" className="td-primary td-continue" onClick={continueWithVidya} disabled={!!live || (!total && !pendingSection)}><Icon name="spark" />{live ? 'Writing…' : 'Continue'}</button>
        </div>
        {error ? <p role="alert" className="td-alert">{error}</p> : null}
        {live || !page ? (
          <article className={`td-page turn-${turn}`} key={live ? 'live' : cur} data-page={cur} onMouseUp={onSelect} onTouchEnd={onSelect}>
            {live ? <><p className="td-page-kicker">Writing now</p>{live.blocks[0]?.type === 'heading' ? null : <h2>{live.title}</h2>}{live.blocks.map((b) => <BlockView key={b.id} b={b} active={false} onAsk={null} />)}<p className="td-writing" role="status"><b className="td-spin" />The Tutor is writing this section…</p></>
              : <div className="td-cover"><p className="td-page-kicker">{outline.length} sections planned</p><h2>{data.book.title}</h2><p>Press <b>Continue</b> and Vidya will teach the first section.</p></div>}
          </article>
        ) : (
          <BookStage cur={cur} total={total} title={data.book.title} subtitle={data.book.mode === 'source' ? 'From your document' : 'Prepared by your Tutor'} onTurn={goTo} onSelectEnd={onSelect} render={(n, ghost) => {
            const pg = byPage.get(n)
            if (!pg) return null
            const sec = outline.find((s) => s.id === pg.sectionId)
            const ends = byPage.get(n + 1)?.sectionId !== pg.sectionId
            return <><p className="td-page-kicker">{sec?.title}</p>{pg.blocks.map((b) => <BlockView key={b.id} b={b} ghost={ghost} active={!ghost && state.lecture.blockId === b.id} onAsk={ghost ? null : () => askAbout(b.term ? `${b.term}: ${b.text}` : b.text, pg.pageNo, b.id)} />)}
              {ends ? <aside className="td-end"><strong>End of this part</strong><p>Practice stays outside the notebook. Open it when you feel ready.</p><button type="button" className="td-ghost" onClick={() => open({ view: 'practice', courseId: data.book.courseId, conceptId: sec?.conceptId ?? undefined })}>Go to practice</button></aside> : null}<span className="td-folio">{pg.pageNo}</span></>
          }} />
        )}
        {liveAt ? <LiveClassroom bookId={bookId} courseId={data.book.courseId} sectionId={liveAt.sectionId} startPage={liveAt.pageNo} startBlock={liveAt.blockId} pages={pages} fail={fail} onClose={closeVidya} /> : null}
        {selection ? <div className="td-pop" style={{ left: selection.x, top: selection.y }}><button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => askAbout(selection.text, selection.pageNo, selection.blockId)}><Icon name="spark" />Ask about this</button></div> : null}
      </div>
    </div>
  )
}

function BlockView({ b, active, onAsk, ghost = false }: { b: Block; active: boolean; onAsk: (() => void) | null; ghost?: boolean }) {
  const t = <MathText text={b.text} />
  const body = (() => {
    switch (b.type) {
      case 'heading': return <h2>{t}</h2>
      case 'definition': return <p><dfn>{b.term}</dfn> {t}</p>
      case 'formula': return <p className="td-formula">{t}</p>
      case 'example': return <><p className="td-label">Worked example</p><p>{t}</p></>
      case 'tip': return <><p className="td-label">Remember</p><p>{t}</p></>
      case 'exam': return <><p className="td-label">Exam point</p><p>{t}</p></>
      case 'summary': return <><p className="td-label">In short</p><p>{t}</p></>
      case 'excerpt': return <blockquote>{t}</blockquote>
      case 'list': return <>{b.text ? <p>{t}</p> : null}<ul>{(b.items ?? []).map((x, i) => <li key={i}><MathText text={x} /></li>)}</ul></>
      case 'figure': return b.figure?.thumb ? <figure><img src={b.figure.thumb} alt={b.figure.alt} loading="lazy" /><figcaption><strong>{b.figure.caption}</strong><small>{b.figure.credit}{b.figure.pageUrl ? <> · <a href={b.figure.pageUrl} target="_blank" rel="noreferrer noopener">source</a></> : null}</small></figcaption></figure> : null
      default: return <p>{t}</p>
    }
  })()
  if (!body) return null
  return (
    <section id={ghost ? undefined : `td-b-${b.id}`} data-block={ghost ? undefined : b.id} className={`td-block is-${b.type}${active ? ' is-active' : ''}`}>
      {body}
      {b.type !== 'heading' ? <div className="td-block-foot"><span className={`td-origin is-${b.label}`}>{b.label === 'source' ? `From your document${b.cites[0] ? `, p. ${b.cites[0].page}` : ''}` : b.label === 'uncertain' ? 'Not certain, please verify' : 'AI explanation'}</span>{onAsk ? <button type="button" onClick={onAsk}>Ask</button> : null}</div> : null}
    </section>
  )
}
