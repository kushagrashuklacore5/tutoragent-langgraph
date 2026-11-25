import { forwardRef, useId, useImperativeHandle, useRef } from 'react'
import type { Pose, Vec } from './pose.ts'

/** Skeleton constants (SVG units). The choreography's inverse kinematics reads the same numbers the drawing uses. */
export const RIG = { shoulderA: { x: 196, y: 446 }, shoulderB: { x: 364, y: 446 }, upper: 132, fore: 122, hand: 66 }

export interface RigHandle {
  apply(p: Pose, mouth: { open: number; wide: number; round: number }, breath: number, blink: number, ctx?: unknown): void
  /** a point on the page converted into rig coordinates */
  toRig(screen: Vec): Vec | null
  /** screen position of the index fingertip */
  fingertip(): Vec | null
}

const EYE = 'M186 266 Q214 236 252 258 Q232 284 202 282 Q192 278 186 266Z'
const rot = (a: number) => `rotate(${a.toFixed(2)})`

function Finger({ x, len, cls, w = 8.4 }: { x: number; len: number; cls: string; w?: number }) {
  return <g transform={`translate(${x} 30)`}><path className={cls} d={`M${-w / 2} 0 V${len - w / 2} a${w / 2} ${w / 2} 0 0 0 ${w} 0 V0Z`} fill="#f3c9ae" stroke="#c9937f" strokeWidth=".7" /></g>
}
function Hand({ side }: { side: 'a' | 'b' }) {
  const m = side === 'a' ? -1 : 1
  return (
    <g data-j={`${side}W`}>
      <path d="M-13 -4 C-19 10 -19 24 -16 34 H16 C19 24 19 10 13 -4Z" fill="#f3c9ae" stroke="#c9937f" strokeWidth=".8" />
      <Finger x={-12.4 * m} len={22} cls={`j-${side}f`} w={7.4} />
      <Finger x={-4 * m} len={29} cls={`j-${side}f`} />
      <Finger x={4.6 * m} len={27} cls={`j-${side}f`} />
      <Finger x={13 * m} len={side === 'b' ? 30 : 25} cls={side === 'b' ? 'j-bi' : 'j-af'} />
      {side === 'b' ? <circle data-j="tip" cx={13} cy={60} r=".5" fill="none" /> : null}
      <g data-j={`${side}T`} transform={`translate(${17 * m} 10)`}><path d={`M-4.6 0 C${6 * m} 6 ${12 * m} 16 ${11 * m} 26 a4.8 4.8 0 0 ${m > 0 ? 1 : 0} ${-9 * m} 1 C${2 * m} 18 ${-3 * m} 12 -5 8Z`} fill="#f0c3a7" stroke="#c9937f" strokeWidth=".7" /></g>
    </g>
  )
}
function Arm({ side, sleeve }: { side: 'a' | 'b'; sleeve: string }) {
  const s = side === 'a' ? RIG.shoulderA : RIG.shoulderB
  return (
    <g transform={`translate(${s.x} ${s.y})`}>
      <g data-j={`${side}S`}>
        <path d={`M-29 -14 C-31 40 -26 96 -21 ${RIG.upper + 8} H21 C26 96 31 40 29 -14 C22 -30 -22 -30 -29 -14Z`} fill={sleeve} />
        <path d={`M${side === 'a' ? -24 : 24} 8 C${side === 'a' ? -24 : 24} 50 ${side === 'a' ? -20 : 20} 90 ${side === 'a' ? -18 : 18} ${RIG.upper - 4}`} stroke="#45dcea" strokeOpacity=".3" fill="none" />
        <g transform={`translate(0 ${RIG.upper})`}>
          <g data-j={`${side}E`}>
            <path d={`M-22 -12 C-24 40 -20 86 -16 ${RIG.fore - 4} H16 C20 86 24 40 22 -12 C14 -24 -14 -24 -22 -12Z`} fill={sleeve} />
            <rect x="-18" y={RIG.fore - 12} width="36" height="10" rx="4" fill="#0d1540" stroke="#45dcea" strokeOpacity=".75" />
            <g transform={`translate(0 ${RIG.fore})`}><Hand side={side} /></g>
          </g>
        </g>
      </g>
    </g>
  )
}

/**
 * Vidya as a real 2D skeletal puppet: hips, torso, neck, head, two three-joint arms, individually posed fingers, eyes,
 * lids, brows and a parametric mouth. Keeps her established look (navy hair, blue-cyan eyes, headset, circuit coat).
 * All motion goes through `apply`, which writes attributes directly so React never re-renders per frame.
 */
export const VidyaRig = forwardRef<RigHandle, { label: string; className?: string; viewBox?: string }>(function VidyaRig({ label, className, viewBox = '0 0 560 1000' }, ref) {
  const id = useId().replace(/:/g, '')
  const u = (n: string) => `url(#${id}-${n})`
  const root = useRef<SVGSVGElement>(null)
  const cache = useRef<Map<string, Element> | null>(null)
  const fingers = useRef<{ a: Element[]; b: Element[]; i: Element[] } | null>(null)

  useImperativeHandle(ref, () => {
    const el = (n: string) => {
      if (!cache.current) { cache.current = new Map(); root.current!.querySelectorAll('[data-j]').forEach((x) => cache.current!.set(x.getAttribute('data-j')!, x)) }
      return cache.current.get(n)!
    }
    const set = (n: string, v: string) => el(n)?.setAttribute('transform', v)
    return {
      apply(p, m, breath, blink) {
        if (!root.current) return
        if (!fingers.current) fingers.current = { a: [...root.current.querySelectorAll('.j-af')], b: [...root.current.querySelectorAll('.j-bf')], i: [...root.current.querySelectorAll('.j-bi')] }
        set('body', `translate(${(p.hip * 1.4).toFixed(2)} 0) rotate(${(p.torsoLean + p.hip * 0.12).toFixed(2)} 280 860)`)
        set('chest', `translate(280 640) scale(${(1 + breath * 0.008 - Math.abs(p.torsoYaw) * 0.05).toFixed(4)} ${(1 + breath * 0.012).toFixed(4)}) translate(-280 -640)`)
        set('front', `translate(${(p.torsoYaw * 26).toFixed(2)} 0)`)
        set('head', `translate(${(p.yaw * 6).toFixed(2)} ${(p.headPitch * 0.9 + breath * 0.9).toFixed(2)}) rotate(${p.headRoll.toFixed(2)} 280 372)`)
        set('hairF', `translate(${(p.yaw * 14).toFixed(2)} 0)`)
        set('hairB', `translate(${(-p.yaw * 8).toFixed(2)} 0)`)
        set('face', `translate(${(p.yaw * 25).toFixed(2)} ${(p.headPitch * 0.7).toFixed(2)})`)
        // the far eye narrows as she turns
        set('eyeL', `translate(218 262) scale(${(1 + Math.max(0, p.yaw) * 0.06 - Math.max(0, -p.yaw) * 0.26).toFixed(3)} 1) translate(-218 -262)`)
        set('eyeR', `translate(302 262) scale(${(1 + Math.max(0, -p.yaw) * 0.06 - Math.max(0, p.yaw) * 0.26).toFixed(3)} 1) translate(-302 -262)`)
        const gx = (p.gazeX * 11).toFixed(2), gy = (p.gazeY * 7).toFixed(2)
        set('irisL', `translate(${gx} ${gy})`)
        set('irisR', `translate(${(-p.gazeX * 11).toFixed(2)} ${gy})`) // this eye is drawn mirrored
        const lid = Math.min(1, Math.max(p.lid, blink))
        for (const n of ['lidL', 'lidR']) set(n, `translate(0 236) scale(1 ${lid.toFixed(3)}) translate(0 -236)`)
        const by = -(p.browUp * 9) + p.browIn * 3, ba = p.browIn * 7 - p.browUp * 2
        set('browL', `translate(0 ${by.toFixed(2)}) rotate(${ba.toFixed(2)} 217 218)`)
        set('browR', `translate(0 ${by.toFixed(2)}) rotate(${ba.toFixed(2)} 217 218)`)
        // parametric mouth
        const cx = 261, cy = 345, w = 21 + m.wide * 10 - m.round * 7 + p.smile * 4, o = m.open * 17, lift = p.smile * 7
        const upper = cy - 1 - o * 0.22 + (m.round * 2)
        const lower = cy + 2 + o + p.smile * 3
        el('mouthIn')?.setAttribute('d', o < 0.8 ? '' : `M${cx - w} ${cy - lift} Q${cx} ${upper} ${cx + w} ${cy - lift} Q${cx} ${lower} ${cx - w} ${cy - lift}Z`)
        el('teeth')?.setAttribute('d', o < 3 ? '' : `M${cx - w * 0.68} ${cy - lift * 0.6} Q${cx} ${upper + 1} ${cx + w * 0.68} ${cy - lift * 0.6} Q${cx} ${upper + 3 + o * 0.22} ${cx - w * 0.68} ${cy - lift * 0.6}Z`)
        el('lipU')?.setAttribute('d', `M${cx - w} ${cy - lift} Q${cx - w * 0.4} ${upper - 2.6} ${cx} ${upper - 0.8} Q${cx + w * 0.4} ${upper - 2.6} ${cx + w} ${cy - lift}`)
        el('lipL')?.setAttribute('d', `M${cx - w * 0.92} ${cy - lift * 0.9} Q${cx} ${lower + 2.2} ${cx + w * 0.92} ${cy - lift * 0.9}`)
        el('chin')?.setAttribute('transform', `translate(0 ${(o * 0.2).toFixed(2)})`)
        set('aS', rot(p.aS)); set('aE', rot(p.aE)); set('aW', rot(p.aW))
        set('bS', rot(p.bS)); set('bE', rot(p.bE)); set('bW', rot(p.bW))
        const curl = (c: number) => `scale(1 ${(1 - Math.min(1, Math.max(0, c)) * 0.72).toFixed(3)})`
        for (const f of fingers.current.a) f.setAttribute('transform', curl(p.aCurl))
        for (const f of fingers.current.b) f.setAttribute('transform', curl(p.bCurl))
        for (const f of fingers.current.i) f.setAttribute('transform', curl(p.bIndex))
        set('aT', `translate(-17 10) rotate(${(p.aCurl * 22 + p.aThumb * 90).toFixed(1)})`)
        set('bT', `translate(17 10) rotate(${(-p.bCurl * 22 + p.bThumb * 118).toFixed(1)})`)
      },
      toRig(s) {
        const m = root.current?.getScreenCTM()
        if (!m) return null
        const pt = new DOMPoint(s.x, s.y).matrixTransform(m.inverse())
        return { x: pt.x, y: pt.y }
      },
      fingertip() {
        const r = (el('tip') as Element | undefined)?.getBoundingClientRect()
        return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
      },
    }
  }, [])

  const eye = (side: 'L' | 'R') => (
    <g>
      <path d={EYE} fill="#f6f8ff" />
      <g clipPath={u('eye')}>
        <g data-j={`iris${side}`}>
          <ellipse cx="222" cy="262" rx="17" ry="22" fill={u('iris')} />
          <ellipse cx="222" cy="264" rx="8" ry="11" fill="#071029" />
          <ellipse cx="222" cy="275" rx="11" ry="5" fill="#59e6f2" opacity=".55" />
          <circle cx="216" cy="253" r="5.2" fill="#fff" />
          <circle cx="229" cy="270" r="2" fill="#fff" opacity=".85" />
        </g>
        <path d="M184 240 H256 V256 Q218 240 186 268Z" fill="#0b1030" opacity=".2" />
        <rect data-j={`lid${side}`} x="176" y="232" width="86" height="58" fill={u('skin')} transform="translate(0 236) scale(1 0) translate(0 -236)" />
      </g>
      <path d="M180 270 Q190 250 208 243 Q232 234 256 257 Q234 245 212 249 Q195 254 186 270 L180 276Z" fill="#10163a" />
      <path d="M204 283 Q222 287 238 277" stroke="#8f6f73" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      <path data-j={`brow${side}`} d="M186 226 Q214 208 248 222" stroke="#1a2152" strokeWidth="4.4" fill="none" strokeLinecap="round" />
      <ellipse cx="205" cy="304" rx="20" ry="8" fill="#f08f97" opacity=".22" />
    </g>
  )

  return (
    <svg ref={root} className={`td-rig${className ? ` ${className}` : ''}`} viewBox={viewBox} role="img" aria-label={label}>
      <defs>
        <linearGradient id={`${id}-skin`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ffe3cf" /><stop offset=".62" stopColor="#f3c5a8" /><stop offset="1" stopColor="#cf9a8c" /></linearGradient>
        <linearGradient id={`${id}-neck`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#b98284" /><stop offset=".45" stopColor="#e7b79e" /><stop offset="1" stopColor="#f0c6ad" /></linearGradient>
        <linearGradient id={`${id}-hair`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#2a3f96" /><stop offset=".42" stopColor="#141b4d" /><stop offset="1" stopColor="#0a0d28" /></linearGradient>
        <linearGradient id={`${id}-shine`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#6fb5ff" stopOpacity="0" /><stop offset=".5" stopColor="#8fd6ff" stopOpacity=".7" /><stop offset="1" stopColor="#6fb5ff" stopOpacity="0" /></linearGradient>
        <linearGradient id={`${id}-coat`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#2c3b80" /><stop offset=".5" stopColor="#182152" /><stop offset="1" stopColor="#0c1233" /></linearGradient>
        <linearGradient id={`${id}-sleeve`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#1c2660" /><stop offset=".5" stopColor="#2b3a80" /><stop offset="1" stopColor="#172052" /></linearGradient>
        <linearGradient id={`${id}-shirt`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#e9f1ff" /><stop offset="1" stopColor="#9fb4e6" /></linearGradient>
        <radialGradient id={`${id}-iris`} cx="50%" cy="35%" r="70%"><stop offset="0" stopColor="#1b3f9e" /><stop offset=".6" stopColor="#2b7fe8" /><stop offset="1" stopColor="#3fe0ee" /></radialGradient>
        <radialGradient id={`${id}-floor`}><stop offset="0" stopColor="#000" stopOpacity=".6" /><stop offset="1" stopColor="#000" stopOpacity="0" /></radialGradient>
        <clipPath id={`${id}-eye`}><path d={EYE} /></clipPath>
      </defs>
      <ellipse cx="280" cy="976" rx="190" ry="20" fill={u('floor')} />
      <g data-j="body">
        {/* legs and shoes */}
        <path d="M226 800 L222 950 H262 L274 800Z" fill="#232f6e" /><path d="M334 800 L338 950 H298 L286 800Z" fill="#1c2760" />
        <path d="M216 950 H264 V972 H200 C200 960 208 952 216 950Z" fill="#2a3a86" stroke="#45dcea" strokeOpacity=".5" />
        <path d="M344 950 H296 V972 H360 C360 960 352 952 344 950Z" fill="#26347b" stroke="#45dcea" strokeOpacity=".5" />
        {/* hair falls behind the shoulders */}
        <g data-j="hairB"><g transform="translate(20 124) scale(1 1)"><path d="M148 232 C136 118 206 66 262 66 C334 66 388 120 374 236 C382 332 396 400 414 462 C378 486 344 462 332 424 L188 424 C176 462 142 486 106 462 C124 400 140 326 148 232Z" fill={u('hair')} /></g></g>
        <g data-j="chest">
          <path d="M164 450 C176 424 216 412 246 402 H314 C344 412 384 424 396 450 C404 560 392 640 386 700 L420 870 H140 L174 700 C168 640 156 560 164 450Z" fill={u('coat')} />
          <g data-j="front">
            <path d="M246 402 L280 520 L314 402 L296 384 H264Z" fill={u('shirt')} />
            <path d="M246 402 L222 420 L262 560 L250 870 H190 L208 700 C200 600 212 480 246 402Z" fill="#1f2b69" />
            <path d="M314 402 L338 420 L298 560 L310 870 H370 L352 700 C360 600 348 480 314 402Z" fill="#1a2358" />
            <g fill="none" stroke="#45dcea" strokeLinecap="round">
              <path d="M246 400 L280 524 L252 870" strokeOpacity=".8" strokeWidth="1.7" /><path d="M314 400 L280 524 L308 870" strokeOpacity=".8" strokeWidth="1.7" />
              <path d="M186 610 L212 584 H232 L242 572" strokeOpacity=".45" /><path d="M374 610 L348 584 H328 L318 572" strokeOpacity=".45" />
            </g>
            <g fill="#45dcea"><circle cx="242" cy="572" r="2.5" /><circle cx="318" cy="572" r="2.5" /></g>
            <g transform="translate(334 648)"><path d="M0-15 L13-7.5 V7.5 L0 15 L-13 7.5 V-7.5Z" fill="#0d1540" stroke="#6fa6ff" /><path d="M-5 5 L0-7 L5 5 M-3 1 H3" fill="none" stroke="#45dcea" strokeWidth="1.5" strokeLinecap="round" /></g>
          </g>
        </g>
        <path d="M256 340 L252 402 C260 420 300 420 308 402 L304 340Z" fill={u('neck')} />
        <g data-j="head">
          <g transform="translate(92.8 96.8) scale(.72)">
            <path d="M170 262 C160 258 156 276 164 292 C168 302 176 306 182 302Z" fill="#e7b79e" />
            <path d="M350 262 C360 258 364 276 356 292 C352 302 344 306 338 302Z" fill="#d9a690" />
            <g data-j="chin"><path d="M174 238 C174 172 214 128 260 128 C306 128 346 172 346 238 C346 290 324 332 288 362 C276 372 267 378 260 378 C253 378 244 372 232 362 C196 332 174 290 174 238Z" fill={u('skin')} /></g>
            <path d="M346 238 C346 290 324 332 288 362 C276 372 267 378 260 378 C300 340 326 300 330 220 C340 214 346 224 346 238Z" fill="#c98f85" opacity=".26" />
            <g data-j="face">
              <g data-j="eyeL">{eye('L')}</g>
              <g data-j="eyeR"><g transform="matrix(-1 0 0 1 520 0)">{eye('R')}</g></g>
              <path d="M261 296 Q266 314 258 320 Q262 323 267 320" fill="none" stroke="#b77f76" strokeWidth="1.7" strokeLinecap="round" />
              <path data-j="mouthIn" d="" fill="#6d2a3a" />
              <path data-j="teeth" d="" fill="#fbf7f4" />
              <path data-j="lipU" d="M240 344 Q250 342 261 343 Q272 342 282 344" fill="none" stroke="#a65c64" strokeWidth="2.6" strokeLinecap="round" />
              <path data-j="lipL" d="M242 345 Q261 352 280 345" fill="none" stroke="#dd9498" strokeWidth="2.2" strokeLinecap="round" />
            </g>
            <g data-j="hairF">
              <path d="M172 226 C156 290 164 356 142 420 C178 398 198 344 194 266Z" fill={u('hair')} />
              <path d="M348 226 C364 290 356 356 378 420 C342 398 322 344 326 266Z" fill={u('hair')} />
              <path d="M164 246 C152 150 208 86 262 86 C326 86 370 150 356 250 C348 222 336 196 320 176 C318 202 306 220 290 232 C296 204 288 180 276 158 C268 192 246 218 218 232 C228 210 230 190 226 170 C208 194 192 220 186 258 C178 254 170 250 164 246Z" fill={u('hair')} />
              <path d="M190 150 C216 116 252 106 296 116 C266 118 228 132 204 168Z" fill={u('shine')} />
              <path d="M152 244 C150 176 196 104 262 98" stroke="#45dcea" strokeOpacity=".75" strokeWidth="3" fill="none" strokeLinecap="round" />
              <rect x="143" y="240" width="22" height="48" rx="10" fill="#10183f" stroke="#6fa6ff" />
              <circle cx="154" cy="264" r="4" fill="#45dcea" />
            </g>
          </g>
        </g>
        <Arm side="a" sleeve={u('sleeve')} />
        <Arm side="b" sleeve={u('sleeve')} />
      </g>
    </svg>
  )
})
