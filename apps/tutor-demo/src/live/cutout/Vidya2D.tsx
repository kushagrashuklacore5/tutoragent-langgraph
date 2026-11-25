import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { Action, Gaze } from '../choreography.ts'
import type { Pose, Vec } from '../pose.ts'
import type { RigHandle } from '../VidyaRig.tsx'
import { armsFor, easeArms, REST, turn, type ArmPose } from './poses.ts'

export type Framing = 'stage' | 'hero' | 'compact'
interface Layer { file: string; x: number; y: number; w: number; h: number }
/** optional face artwork drawn over the body: mouth shapes per viseme, closed/half eyelids. Absent = the face stays exactly as drawn. */
interface Face { box: [number, number, number, number]; shapes: Partial<Record<string, string>> }
interface Rig { mouth?: Face; eyes?: Face; size: [number, number]; layers: Record<'body' | 'upperL' | 'upperR' | 'foreL' | 'foreR', Layer>; pivots: Record<'shoulderL' | 'shoulderR' | 'elbowL' | 'elbowR', [number, number]>; fingertips: { left: [number, number]; right: [number, number] }; figure: { top: number; bottom: number; centerX: number } }
interface Ctx { dt: number; action: Action; gaze: Gaze; state: string; beat: number; aim: Vec | null; variant: number; count?: number; viseme?: string }
/** whole-figure posture per state (degrees around the feet; she leans in to ask and listen, back a little to think) */
const LEAN: Record<string, number> = { greeting: 0.7, asking_question: 1.1, listening: 0.8, interrupted: 0.9, encouraging: 0.5, thinking: -0.7, summarising: 0.3 }
const BASE = `${import.meta.env.BASE_URL}vidya2d/`

/**
 * Vidya drawn from the supplied artwork itself: five transparent pieces cut from the original image, never repainted.
 * The arms turn at the shoulder and cuff; face, hands and clothing stay exactly as drawn. No mouth shapes exist in the
 * source, so the face does not lip-sync.
 */
export const Vidya2D = forwardRef<RigHandle, { label: string; framing: Framing; className?: string }>(function Vidya2D({ label, framing, className }, ref) {
  const host = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const art = useRef<{ rig: Rig; img: Record<string, HTMLImageElement> } | null>(null)
  const arms = useRef<ArmPose>({ ...REST })
  const view = useRef({ scale: 1, ox: 0, oy: 0, dpr: 1 })
  const clock = useRef(0)
  const lean = useRef(0)
  const nod = useRef(0)
  const mouthMix = useRef<Record<string, number>>({})
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let live = true
    void (async () => {
      const rig = (await (await fetch(`${BASE}rig.json`)).json()) as Rig
      const img: Record<string, HTMLImageElement> = {}
      await Promise.all(Object.entries(rig.layers).map(([k, l]) => new Promise<void>((ok, no) => { const i = new Image(); i.onload = () => ok(); i.onerror = no; i.src = BASE + l.file; img[k] = i })))
      // face artwork is optional: each shape is used only if its file really exists
      for (const [part, face] of [['mouth', rig.mouth], ['eyes', rig.eyes]] as const) for (const [shape, file] of Object.entries(face?.shapes ?? {})) if (file) await new Promise<void>((ok) => { const i = new Image(); i.onload = () => { img[`${part}:${shape}`] = i; ok() }; i.onerror = () => ok(); i.src = BASE + file })
      if (!live) return
      art.current = { rig, img }
      setReady(true)
    })().catch(() => undefined)
    return () => { live = false }
  }, [])

  // fit the figure: the canvas reaches past her column on the stage, so a pointing arm is never cut off
  useEffect(() => {
    const el = host.current, c = canvas.current
    if (!el || !c || !ready) return
    const fit = () => {
      const r = el.getBoundingClientRect(), a = art.current!.rig, dpr = Math.min(2, window.devicePixelRatio || 1)
      const w = framing === 'stage' ? r.width * 1.75 : r.width, h = r.height
      c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.width = `${w}px`; c.style.height = `${h}px`
      const top = a.figure.top - 6, bottom = framing === 'compact' ? 760 : a.figure.bottom + 4
      const scale = Math.min(h / (bottom - top), (r.width * (framing === 'compact' ? 0.92 : 0.98)) / 640)
      view.current = { scale, dpr, ox: r.width / 2 - a.figure.centerX * scale, oy: framing === 'compact' ? 4 - top * scale : (h - (bottom - top) * scale) - top * scale }
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ready, framing])

  useImperativeHandle(ref, () => {
    const toScreen = (p: [number, number]): Vec => {
      const r = canvas.current!.getBoundingClientRect(), v = view.current
      return { x: r.left + v.ox + p[0] * v.scale, y: r.top + v.oy + p[1] * v.scale }
    }
    const aimDeg = (aim: Vec | null) => {
      if (!aim || !art.current || !canvas.current) return null
      const s = toScreen(art.current.rig.pivots.shoulderR)
      return (Math.atan2(aim.y - s.y, aim.x - s.x) * 180) / Math.PI
    }
    return {
      apply(p: Pose, m: { open: number; wide: number; round: number }, breath: number, blink: number, raw?: unknown) {
        const a = art.current, c = canvas.current
        if (!a || !c) return
        const ctx = (raw ?? { dt: 1 / 60, action: 'audience_explanation', gaze: 'audience', state: 'idle', beat: 0, aim: null, variant: 0 }) as Ctx
        const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
        clock.current += ctx.dt
        // Raise Hand: the gesture drops at once (fast ease), never finishes its move first
        arms.current = easeArms(arms.current, armsFor(ctx.action, ctx.state, ctx.beat, ctx.variant, aimDeg(ctx.aim), reduced, ctx.count ?? 1), ctx.dt, ctx.state === 'interrupted' ? 16 : ctx.aim ? 9 : 5.5)
        lean.current += ((LEAN[ctx.state] ?? 0) - lean.current) * (1 - Math.exp(-3 * ctx.dt))
        const g = c.getContext('2d')!, v = view.current, { rig, img } = a, P = rig.pivots, A = arms.current
        g.setTransform(1, 0, 0, 1, 0, 0)
        g.clearRect(0, 0, c.width, c.height)
        g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'
        // the whole figure breathes and shifts weight very slightly, turning with her when she faces the board
        const sway = reduced ? 0 : Math.sin(clock.current * 0.5) * 0.25 + p.torsoYaw * 1.2 + lean.current
        const lift = reduced ? 0 : breath * 0.9
        const feet: [number, number] = [rig.figure.centerX, rig.figure.bottom]
        g.setTransform(v.dpr * v.scale, 0, 0, v.dpr * v.scale, v.dpr * v.ox, v.dpr * v.oy)
        // a gentle nod of the whole figure when greeting or encouraging (the artwork has no separate head)
        const nodding = !reduced && (ctx.state === 'greeting' || ctx.state === 'encouraging' || ctx.state === 'celebrating')
        nod.current += ((nodding ? 1 : 0) - nod.current) * (1 - Math.exp(-4 * ctx.dt))
        const bob = nod.current * Math.max(0, Math.sin(clock.current * 5.2)) * 2.2
        g.translate(feet[0], feet[1]); g.rotate((sway * Math.PI) / 180); g.translate(-feet[0], -feet[1]); g.translate(0, -lift + bob)
        const draw = (k: keyof Rig['layers']) => { const l = rig.layers[k]; g.drawImage(img[k]!, l.x, l.y, l.w, l.h) }
        const arm = (side: 'L' | 'R') => {
          const sh = P[side === 'L' ? 'shoulderL' : 'shoulderR'], el = P[side === 'L' ? 'elbowL' : 'elbowR']
          g.save(); g.translate(sh[0], sh[1]); g.rotate(((side === 'L' ? A.upL : A.upR) * Math.PI) / 180); g.translate(-sh[0], -sh[1])
          g.save(); g.translate(el[0], el[1]); g.rotate(((side === 'L' ? A.foL : A.foR) * Math.PI) / 180); g.translate(-el[0], -el[1]); draw(side === 'L' ? 'foreL' : 'foreR'); g.restore()
          draw(side === 'L' ? 'upperL' : 'upperR'); g.restore()
        }
        arm('L'); arm('R'); draw('body')
        // face: mouth shapes made from her own lips (tools/vidya2d/face.py), eyelids for blinks. The drawn mouth is
        // the audio-classified viseme; neighbouring shapes crossfade over ~25 ms so fast speech never flickers, and
        // in silence every shape fades out, leaving her original face.
        const face = (part: 'mouth' | 'eyes', shape: string, alpha = 1) => { const f = rig[part], i = img[`${part}:${shape}`]; if (f && i && alpha > 0.02) { g.globalAlpha = Math.min(1, alpha); g.drawImage(i, f.box[0], f.box[1], f.box[2], f.box[3]); g.globalAlpha = 1 } }
        if (rig.mouth) {
          const want = ctx.viseme && ctx.viseme !== 'rest' ? ctx.viseme : null
          // open shapes follow how open the lips are this frame; closed shapes (m, b, p, f, v) are drawn fully
          const strength = want === 'mbp' || want === 'fv' ? 1 : Math.min(1, Math.max(0, (m.open - 0.04) / 0.22))
          const k = ctx.state === 'interrupted' ? 1 : 1 - Math.exp(-40 * ctx.dt) // Raise Hand: the mouth closes on this frame
          for (const v of Object.keys(rig.mouth.shapes)) { const goal = v === want ? strength : 0; mouthMix.current[v] = (mouthMix.current[v] ?? 0) + (goal - (mouthMix.current[v] ?? 0)) * k }
          for (const [v, alpha] of Object.entries(mouthMix.current)) face('mouth', v, alpha)
        }
        if (rig.eyes && blink > 0.5) face('eyes', 'closed'); else if (rig.eyes && blink > 0.15) face('eyes', 'half')
      },
      toRig: () => null,
      fingertip() {
        const a = art.current
        if (!a || !canvas.current) return null
        const { pivots: P, fingertips } = a.rig, A = arms.current
        return toScreen(turn(turn(fingertips.right, P.elbowR, A.foR), P.shoulderR, A.upR))
      },
    }
  }, [])

  return (
    <div ref={host} className={`td-stage2d is-${framing}${className ? ` ${className}` : ''}`} role="img" aria-label={label}>
      <canvas ref={canvas} className="td-rig2d" aria-hidden />
      {!ready ? <span className="td-stage3d-wait" aria-hidden><b className="td-spin" /></span> : null}
    </div>
  )
})
