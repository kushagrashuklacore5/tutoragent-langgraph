/** Pure rules for turning book pages by drag, swipe and trackpad, kept apart from vertical reading. */
export type TurnDir = 'next' | 'prev'

/** A horizontal gesture only: anything mostly vertical stays normal page scrolling. */
export function gestureDir(dx: number, dy: number, min = 12): TurnDir | null {
  if (Math.abs(dx) < min || Math.abs(dx) < Math.abs(dy) * 1.4) return null
  return dx < 0 ? 'next' : 'prev'
}

/** The page a turn leads to, or null at either end of the book. */
export function turnTarget(cur: number, total: number, dir: TurnDir): number | null {
  const to = dir === 'next' ? cur + 1 : cur - 1
  return to < 1 || to > total ? null : to
}

/** How far a drag has turned the page, 0..1. */
export function dragProgress(dx: number, width: number, dir: TurnDir) {
  const moved = dir === 'next' ? -dx : dx
  return Math.max(0, Math.min(1, moved / Math.max(1, width * 0.8)))
}
export const commitsTurn = (progress: number) => progress >= 0.3

/** Trackpad two-finger swipe: adds up horizontal travel, ignores vertical scrolling, one turn per swipe. */
export function wheelStep(acc: number, dx: number, dy: number, threshold = 90): { acc: number; dir: TurnDir | null } {
  if (Math.abs(dx) <= Math.abs(dy) * 1.5) return { acc: 0, dir: null }
  const next = acc + dx
  if (Math.abs(next) < threshold) return { acc: next, dir: null }
  return { acc: 0, dir: next > 0 ? 'next' : 'prev' }
}
