import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { RigHandle } from './VidyaRig.tsx'
import { VidyaRig } from './VidyaRig.tsx'
import type { Framing, RigContext, VidyaCharacter } from './three/character.ts'

const canRender3D = () => { try { return !!document.createElement('canvas').getContext('webgl2') } catch { return false } }

/**
 * Vidya on screen: the real 3D character, loaded only when needed. The driver talks to one handle; if WebGL or the
 * model is unavailable the drawn character takes over, so teaching never depends on 3D.
 */
export const VidyaStage = forwardRef<RigHandle, { label: string; viewBox?: string; framing: Framing; className?: string }>(function VidyaStage({ label, viewBox, framing, className }, ref) {
  const flat = useRef<RigHandle>(null)
  const host = useRef<HTMLDivElement>(null)
  const three = useRef<VidyaCharacter | null>(null)
  const [mode, setMode] = useState<'loading' | '3d' | 'flat'>('loading')
  useEffect(() => {
    if (!canRender3D()) { setMode('flat'); return }
    let live = true, made: VidyaCharacter | null = null
    void (async () => {
      try {
        const { VidyaCharacter: Character } = await import('./three/character.ts')
        if (!live || !host.current) return
        const coarse = matchMedia('(pointer: coarse)').matches, cores = navigator.hardwareConcurrency ?? 8
        made = new Character(host.current, { framing, lowPower: coarse || cores <= 2, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches })
        host.current.appendChild(made.canvas)
        await made.load(`${import.meta.env.BASE_URL}vidya/vidya.glb`)
        if (!live) return
        three.current = made
        if (import.meta.env.DEV) (window as unknown as { __vidya?: VidyaCharacter }).__vidya = made // test probe, never in a build
        setMode('3d')
      } catch { made?.dispose(); made = null; if (live) setMode('flat') }
    })()
    return () => { live = false; three.current = null; made?.dispose() }
  }, [framing])

  useImperativeHandle(ref, () => ({
    apply(p, m, breath, blink, ctx) {
      if (three.current && ctx) three.current.update(p, m, breath, blink, ctx as RigContext)
      else flat.current?.apply(p, m, breath, blink, ctx)
    },
    toRig: (s) => flat.current?.toRig(s) ?? null,
    fingertip: () => three.current?.fingertip() ?? flat.current?.fingertip() ?? null,
  }), [])

  return (
    <div ref={host} className={`td-stage3d is-${mode}${className ? ` ${className}` : ''}`} data-vidya={mode} role="img" aria-label={label}>
      {mode === 'loading' ? <span className="td-stage3d-wait" aria-hidden><b className="td-spin" /></span> : null}
      <div className="td-stage3d-flat" aria-hidden={mode !== 'flat'}><VidyaRig ref={flat} label={label} viewBox={viewBox} /></div>
    </div>
  )
})
