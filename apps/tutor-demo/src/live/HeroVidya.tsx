import { useEffect, useRef } from 'react'
import { RigDriver } from './driver.ts'
import type { RigHandle } from './VidyaRig.tsx'
import { Vidya2D } from './cutout/Vidya2D.tsx'

/** The launch-page Vidya: greets on arrival, waves on hover, welcomes on click. Uses the same rig as Live Teaching. */
export function HeroVidya({ opening }: { opening: boolean }) {
  const rig = useRef<RigHandle>(null)
  const host = useRef<HTMLSpanElement>(null)
  const driver = useRef<RigDriver | null>(null)
  useEffect(() => {
    const d = new RigDriver(rig.current!, { reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, lowPower: matchMedia('(pointer: coarse)').matches })
    driver.current = d
    d.setState('greeting', 2400)
    d.start()
    const el = host.current?.closest('button')
    const enter = () => { if (d.state === 'idle') d.setState('hover', 2000) }
    el?.addEventListener('pointerenter', enter)
    el?.addEventListener('focus', enter)
    return () => { el?.removeEventListener('pointerenter', enter); el?.removeEventListener('focus', enter); d.stop(); driver.current = null }
  }, [])
  useEffect(() => { if (opening) driver.current?.setState('greeting', 1400) }, [opening])
  return <span ref={host} className="td-launch-rig"><Vidya2D ref={rig} label="Vidya, the Ek Bharat.AI Tutor" framing="hero" /></span>
}
