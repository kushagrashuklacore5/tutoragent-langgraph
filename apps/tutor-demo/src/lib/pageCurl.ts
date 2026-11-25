/**
 * The physics of one sheet of paper, kept pure. `p` is how far the sheet has turned: 0 lying on the right, 1 on the left.
 * While held, the sheet follows the hand and never finishes by itself; only a release lets it settle.
 */
export interface Sheet { p: number; v: number }
const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x))

/** where the free edge must be for it to sit under the cursor (the sheet is a hinge at the spine) */
export const turnAtCursor = (cursorX: number, spineX: number, width: number) => Math.acos(clamp((cursorX - spineX) / width, -1, 1)) / Math.PI

/** held: closely tracks the hand, with no overshoot, and stays exactly still when the hand does */
export function followHand(s: Sheet, target: number, dt: number): Sheet {
  const d = Math.max(1e-3, dt), p = s.p + (clamp(target) - s.p) * (1 - Math.exp(-40 * d)), v = (p - s.p) / d
  return { p, v: s.v + (v - s.v) * (1 - Math.exp(-18 * d)) }
}

/** released: flicks win over position, so a fast small throw still turns the page and a slow one falls back */
export function releaseTarget(p: number, velocity: number): 0 | 1 {
  if (Math.abs(velocity) > 0.75) return velocity > 0 ? 1 : 0
  return p >= 0.5 ? 1 : 0
}

/** let go: the sheet keeps its momentum and eases down onto the stack */
export function settle(s: Sheet, target: 0 | 1, dt: number): Sheet & { done: boolean } {
  const d = Math.min(0.033, Math.max(1e-3, dt)), a = 64 * (target - s.p) - 15 * s.v
  let v = s.v + a * d, p = s.p + v * d
  if (p <= 0 || p >= 1) { p = clamp(p); v = 0 }
  return { p, v, done: Math.abs(target - p) < 0.003 && Math.abs(v) < 0.06 }
}

/**
 * The angle (degrees, 0 to 180) of each strip from spine to free edge. Paper sags under its own weight while upright and
 * its free edge trails the motion, more when it moves faster.
 */
export function bendProfile(p: number, v: number, strips: number): number[] {
  const t = clamp(p), theta = t * 180, lift = Math.sin(Math.PI * t), speed = clamp(v / 2.6, -1, 1)
  return Array.from({ length: strips }, (_, i) => {
    const along = (i + 0.5) / strips
    const sag = -24 * Math.cos(Math.PI * t) * lift * along ** 1.6
    const trail = -34 * speed * lift * along ** 1.25
    return clamp(theta + sag + trail, 0, 180)
  })
}
