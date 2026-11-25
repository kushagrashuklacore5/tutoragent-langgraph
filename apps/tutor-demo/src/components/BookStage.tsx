import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import { bendProfile, followHand, releaseTarget, settle, turnAtCursor, type Sheet } from '../lib/pageCurl.ts'
import { gestureDir, turnTarget, wheelStep, type TurnDir } from '../lib/pageTurn.ts'

interface Leaf { from: number; to: number; dir: TurnDir; external: boolean }
interface Motion extends Sheet { hand: number | null; goal: 0 | 1 | null; grabY: number }

/**
 * The physical book around the real lesson pages: a closed cover that opens by itself, and a flexible sheet that follows
 * the hand. The page number stays owned by the book system; only a finished turn changes it.
 */
export function BookStage({ cur, total, title, subtitle, onTurn, render, onSelectEnd }: { cur: number; total: number; title: string; subtitle: string; onTurn: (n: number) => void; render: (n: number, ghost: boolean) => ReactNode; onSelectEnd: () => void }) {
  const reduced = useRef(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches).current
  const strips = useRef(typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 7 : 12).current
  const [cover, setCover] = useState<'closed' | 'opening' | 'open'>(reduced ? 'open' : 'closed')
  const [leaf, setLeaf] = useState<Leaf | null>(null)
  const last = useRef(cur)
  const committed = useRef<number | null>(null)
  const host = useRef<HTMLDivElement>(null)
  const sheetEl = useRef<HTMLDivElement>(null)
  const template = useRef<HTMLDivElement>(null)
  const castEl = useRef<HTMLSpanElement>(null)
  const motion = useRef<Motion | null>(null)
  const parts = useRef<{ strip: HTMLElement; front: HTMLElement; back: HTMLElement }[]>([])
  const leafRef = useRef<Leaf | null>(null); leafRef.current = leaf
  const gesture = useRef<{ id: number; x: number; y: number; dir: TurnDir | null; touch: boolean; moved: boolean } | null>(null)
  const justDragged = useRef(false)
  const state = useRef({ cur, total, onTurn }); state.current = { cur, total, onTurn }

  useEffect(() => {
    if (cover === 'open') return
    const t = window.setTimeout(() => setCover(cover === 'closed' ? 'opening' : 'open'), cover === 'closed' ? 750 : 1050)
    return () => window.clearTimeout(t)
  }, [cover])

  // any page change from another control (buttons, contents, keys, trackpad) turns a sheet on its own
  useLayoutEffect(() => {
    const prev = last.current
    last.current = cur
    if (prev === cur) return
    if (committed.current === cur) { committed.current = null; return }
    if (reduced) return
    const dir: TurnDir = cur > prev ? 'next' : 'prev'
    motion.current = { p: dir === 'next' ? 0 : 1, v: dir === 'next' ? 1.1 : -1.1, hand: null, goal: dir === 'next' ? 1 : 0, grabY: 0.5 }
    setLeaf({ from: prev, to: cur, dir, external: true })
  }, [cur, reduced])

  // build the sheet once per turn: real page content cut into hinged strips
  useLayoutEffect(() => {
    const root = sheetEl.current, source = template.current?.firstElementChild
    if (!leaf || !root || !source || !host.current) return
    root.textContent = ''
    const W = host.current.clientWidth, w = W / strips, list: typeof parts.current = []
    let parent: HTMLElement = root
    for (let i = 0; i < strips; i++) {
      const strip = document.createElement('div'); strip.className = 'td-curl'; strip.style.left = `${i ? w : 0}px`; strip.style.width = `${w + 0.7}px`
      const front = document.createElement('div'); front.className = 'td-curl-face'
      const copy = source.cloneNode(true) as HTMLElement
      copy.style.width = `${W}px`; copy.style.transform = `translateX(${-i * w}px)`
      const fs = document.createElement('i'); fs.className = 'td-curl-shade'
      front.append(copy, fs)
      const back = document.createElement('div'); back.className = 'td-curl-face is-back'
      const bs = document.createElement('i'); bs.className = 'td-curl-shade'; back.append(bs)
      strip.append(front, back); parent.append(strip); parent = strip
      list.push({ strip, front: fs, back: bs })
    }
    parts.current = list
    paint()
    return () => { root.textContent = ''; parts.current = [] }
  }, [leaf]) // eslint-disable-line react-hooks/exhaustive-deps

  function paint() {
    const m = motion.current, root = sheetEl.current
    if (!m || !root) return
    const angles = bendProfile(m.p, m.v, strips)
    parts.current.forEach((x, i) => {
      x.strip.style.transform = `rotateY(${-(i ? angles[i]! - angles[i - 1]! : angles[0]!)}deg)`
      const facing = Math.cos((angles[i]! * Math.PI) / 180)
      x.front.style.opacity = String(Math.max(0, 0.42 * (1 - facing)))
      x.back.style.opacity = String(Math.max(0, 0.34 * (1 + facing)))
    })
    root.style.transform = `rotateZ(${((m.grabY - 0.5) * Math.sin(Math.PI * m.p) * -5).toFixed(2)}deg)`
    if (castEl.current) { castEl.current.style.opacity = String(0.5 * Math.sin(Math.PI * m.p)); castEl.current.style.transform = `scaleX(${Math.max(0.04, Math.cos(Math.PI * m.p) * 0.9 + 0.1)})` }
  }

  useEffect(() => {
    if (!leaf) return
    let raf = 0, then = performance.now()
    const tick = (now: number) => {
      const m = motion.current
      if (!m) return
      const dt = Math.min(0.05, (now - then) / 1000); then = now
      if (m.goal === null) Object.assign(m, followHand(m, m.hand ?? m.p, dt))
      else {
        const n = settle(m, m.goal, dt)
        m.p = n.p; m.v = n.v
        if (n.done) {
          const l = leaf, turned = (l.dir === 'next') === (m.goal === 1)
          motion.current = null
          setLeaf(null)
          if (turned && !l.external) { committed.current = l.to; state.current.onTurn(l.to) }
          return
        }
      }
      paint()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [leaf]) // eslint-disable-line react-hooks/exhaustive-deps

  // trackpad: horizontal two-finger swipes turn; vertical scrolling is left alone
  useEffect(() => {
    const el = host.current
    if (!el) return
    let acc = 0, quietUntil = 0
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 1.5) { acc = 0; return }
      e.preventDefault()
      if (performance.now() < quietUntil || leafRef.current) return
      const r = wheelStep(acc, e.deltaX, e.deltaY)
      acc = r.acc
      if (!r.dir) return
      quietUntil = performance.now() + 700
      const to = turnTarget(state.current.cur, state.current.total, r.dir)
      if (to) state.current.onTurn(to)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') || leafRef.current) return
      const t = e.target instanceof Element ? e.target : null
      if (t?.closest('input, textarea, select, [contenteditable]') || document.querySelector('.td-live, .td-modal')) return
      const to = turnTarget(state.current.cur, state.current.total, e.key === 'ArrowRight' ? 'next' : 'prev')
      if (to) state.current.onTurn(to)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const handAt = (e: RPointerEvent<HTMLDivElement>, dir: TurnDir, g: { x: number }) => {
    const r = e.currentTarget.getBoundingClientRect()
    return dir === 'next' ? turnAtCursor(e.clientX, r.left, r.width) : Math.max(0, Math.min(1, 1 - (e.clientX - g.x) / (r.width * 1.5)))
  }
  const down = (e: RPointerEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    if (cover !== 'open' || e.button !== 0 || (target.closest('a, input, select, textarea, button') && !target.closest('.td-bk-corner'))) return
    // a sheet already falling can be caught again
    if (leaf && motion.current && !leaf.external) { motion.current.goal = null; motion.current.hand = motion.current.p; gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, dir: leaf.dir, touch: false, moved: true }; e.currentTarget.setPointerCapture(e.pointerId); return }
    if (leaf) return
    const touch = e.pointerType === 'touch', r = e.currentTarget.getBoundingClientRect()
    // a mouse turns from the page edges and corners only, so selecting text inside the page always works
    const edge = e.clientX > r.right - 56 ? 'next' : e.clientX < r.left + 40 ? 'prev' : null
    if (!touch && !edge) return
    gesture.current = { id: e.pointerId, x: e.clientX, y: e.clientY, dir: touch ? null : edge, touch, moved: false }
  }
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    const g = gesture.current
    if (!g || g.id !== e.pointerId) return
    const dx = e.clientX - g.x, dy = e.clientY - g.y
    if (g.touch && !g.dir) {
      if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx)) { gesture.current = null; return } // reading: let it scroll
      g.dir = gestureDir(dx, dy)
      if (!g.dir) return
    }
    if (!g.moved && Math.hypot(dx, dy) < 3) return
    if (!g.moved) {
      const to = turnTarget(cur, total, g.dir!)
      if (!to) { gesture.current = null; return }
      g.moved = true
      e.currentTarget.setPointerCapture(e.pointerId)
      motion.current = { p: g.dir === 'next' ? 0 : 1, v: 0, hand: g.dir === 'next' ? 0 : 1, goal: null, grabY: 0.5 }
      setLeaf({ from: cur, to, dir: g.dir!, external: false })
    }
    const m = motion.current
    if (!m) return
    m.hand = handAt(e, g.dir!, g)
    const r = e.currentTarget.getBoundingClientRect()
    m.grabY = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))
  }
  const up = (e: RPointerEvent<HTMLDivElement>) => {
    const g = gesture.current
    gesture.current = null
    if (!g || g.id !== e.pointerId || !g.moved) return
    justDragged.current = true
    window.setTimeout(() => { justDragged.current = false }, 60)
    const m = motion.current
    if (!m) return
    const home: 0 | 1 = g.dir === 'next' ? 0 : 1
    m.goal = e.type === 'pointercancel' ? home : releaseTarget(m.p, m.v)
    m.hand = null
  }
  const corner = (to: number) => () => { if (!justDragged.current && !leafRef.current) onTurn(to) }

  // forward: the new page waits under the sheet. backward: the sheet brings the earlier page back over this one.
  const base = leaf ? (leaf.dir === 'next' ? leaf.to : leaf.from) : cur
  const face = leaf ? (leaf.dir === 'next' ? leaf.from : leaf.to) : null
  const canPrev = cur > 1, canNext = cur < total
  return (
    <div ref={host} className={`td-bk is-${cover}${leaf ? ' is-turning' : ''}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <span className="td-bk-board" aria-hidden />
      <span className="td-bk-edges" aria-hidden />
      <span className="td-bk-spine" aria-hidden />
      <article className="td-page td-bk-page" data-page={base} onMouseUp={onSelectEnd} onTouchEnd={onSelectEnd}>{render(base, false)}</article>
      <span ref={castEl} className="td-bk-cast" aria-hidden />
      {leaf && face !== null ? (
        <>
          <div ref={template} className="td-curl-template" aria-hidden inert><div className="td-page td-bk-front">{render(face, true)}</div></div>
          <div ref={sheetEl} className="td-curl-sheet" aria-hidden />
        </>
      ) : null}
      {canPrev ? <button type="button" className="td-bk-corner is-prev" aria-label="Turn to the previous page" onClick={corner(cur - 1)} /> : null}
      {canNext ? <button type="button" className="td-bk-corner is-next" aria-label="Turn to the next page" onClick={corner(cur + 1)} /> : null}
      {cover !== 'open' ? (
        <button type="button" className="td-bk-cover" onClick={() => setCover('open')} aria-label={`Open ${title}`}>
          <span className="td-bk-cover-frame"><small>Ek Bharat.AI</small><strong>{title}</strong><em>{subtitle}</em><i aria-hidden>ए</i></span>
        </button>
      ) : null}
    </div>
  )
}
