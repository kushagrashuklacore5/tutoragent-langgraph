/** Development preview: vidya-preview.html?view=front|face|side|back|hands&action=<teaching action>&viseme=aa&count=3 */
import type { Action } from '../choreography.ts'
import { CLIPS, stepPose, targetPose, NEUTRAL } from '../pose.ts'
import { MOUTH, type Viseme } from '../visemes.ts'
import { VidyaCharacter } from './character.ts'

const q = new URLSearchParams(location.search)
let action = (q.get('action') ?? 'audience_explanation') as Action
let viseme = (q.get('viseme') ?? 'rest') as Viseme
let blink = Number(q.get('blink') ?? 0), count = Number(q.get('count') ?? 2), state = q.get('state') ?? 'speaking', aim: { x: number; y: number } | null = null
const views: Record<string, [[number, number, number], [number, number, number], number]> = {
  front: [[0, 0.98, 5.2], [0, 0.86, 0], 20], face: [[0, 1.57, 1.05], [0, 1.555, 0], 18], three: [[1.9, 1.15, 4.2], [0.02, 0.86, 0], 20], close: [[0.02, 1.57, 1.02], [0, 1.545, 0], 17],
  side: [[5.2, 0.98, 0], [0, 0.86, 0], 20], back: [[0, 0.98, -5.2], [0, 0.86, 0], 20], torso: [[0.15, 1.25, 2.6], [0.08, 1.2, 0], 20], hands: [[0.35, 1.2, 1.25], [0.25, 1.18, 0.1], 20],
}
const stage = document.getElementById('stage')!
const c = new VidyaCharacter(stage, { framing: 'hero', lowPower: false, reduced: false })
stage.appendChild(c.canvas)
await c.load('/vidya/vidya.glb')
const v = views[q.get('view') ?? 'front']!
c.lookFrom(v[0], v[1], v[2])
let pose = { ...NEUTRAL }, last = performance.now(), beat = 0.15
const hold = q.has('hold')
const frame = (now: number) => {
  const dt = Math.min(0.05, (now - last) / 1000); last = now
  if (!hold) beat = (beat + dt / 3.4) % 1
  pose = stepPose(pose, CLIPS[action] ? targetPose(action, beat, false) : NEUTRAL, dt)
  c.update(pose, MOUTH[viseme] ?? MOUTH.rest, Math.sin(now / 800), blink, { dt, action, gaze: aim ? 'board' : 'audience', state, beat, aim, count, viseme, variant: Number(q.get('variant') ?? 0) })
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
;(window as unknown as Record<string, unknown>).vidya = c
;(window as unknown as Record<string, unknown>).setPose = (o: { action?: Action; viseme?: Viseme; blink?: number; count?: number; view?: string; state?: string; aim?: { x: number; y: number } | null }) => { if (o.state) state = o.state; if (o.aim !== undefined) aim = o.aim; if (o.action) action = o.action; if (o.viseme) viseme = o.viseme; if (o.blink !== undefined) blink = o.blink; if (o.count) count = o.count; if (o.view) { const w = views[o.view]!; c.lookFrom(w[0], w[1], w[2]) } }
