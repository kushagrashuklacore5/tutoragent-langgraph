/**
 * Arm poses for the 2D Vidya made from the supplied artwork. Only rotations of whole original pieces at the shoulder
 * and the cuff: hands, fingers and face are never reshaped. Angles in degrees, canvas convention (positive = clockwise).
 * L is her right arm (viewer's left); R is her left arm (viewer's right, the Smart Board side).
 */
import type { Action } from '../choreography.ts'

export interface ArmPose { upL: number; foL: number; upR: number; foR: number }
export const REST: ArmPose = { upL: -76, foL: -6, upR: 76, foR: 6 }
const restL = { upL: REST.upL, foL: REST.foL }
const POSES: Partial<Record<Action, ArmPose[]>> = {
  audience_explanation: [{ ...restL, upR: 58, foR: -66 }, { ...restL, upR: 64, foR: -52 }],
  // open palms with BOTH hands (the arms the artwork has), varied by sentence so explanations do not loop one move
  explain_with_open_palms: [{ upL: -62, foL: 56, upR: 54, foR: -74 }, { ...restL, upR: 60, foR: -60 }, { upL: -58, foL: 64, upR: 62, foR: -52 }],
  turn_towards_board: [{ ...restL, upR: 36, foR: -18 }],
  // the greeting needs a palm-facing hand, which the artwork does not have (its hands are side-on, palm down): raising
  // that hand reads as a blessing, so the greeting keeps the arms relaxed and greets with posture, a nod and her smile
  welcome_and_wave: [REST],
  emphasize_important_point: [{ ...restL, upR: 60, foR: -82 }],
  compare_with_both_hands: [{ upL: -56, foL: 70, upR: 56, foR: -70 }],
  // a question: the board-side palm offered forward and held still (an invitation to answer)
  ask_student_question: [{ ...restL, upR: 48, foR: -58 }],
  // reassurance: both hands low and open, close to the body
  encouraging_response: [{ upL: -70, foL: 34, upR: 70, foR: -34 }],
  attentive_listening: [REST],
  celebrate_correct_answer: [{ upL: -66, foL: 40, upR: 66, foR: -40 }],
  conclude_lesson: [{ upL: -62, foL: 58, upR: 62, foR: -58 }],
  count_on_fingers: [{ ...restL, upR: 56, foR: -70 }],
}

/** the arms for this moment; `aimDeg` points her board-side arm straight at the content (the source's own pose is 0°) */
/** counting: each step has its OWN arm height (1 high, 2 middle, 3 low-forward), with a short tap when the step begins */
const COUNT: ArmPose[] = [{ ...restL, upR: 40, foR: -104 }, { ...restL, upR: 50, foR: -86 }, { ...restL, upR: 60, foR: -68 }]
export function armsFor(action: Action, state: string, beat: number, variant: number, aimDeg: number | null, reduced: boolean, count = 1): ArmPose {
  if (aimDeg !== null) return { ...REST, upR: Math.max(-30, Math.min(35, aimDeg)), foR: 0 }
  if (state === 'idle' || state === 'listening' || state === 'thinking' || state === 'interrupted') return REST
  if (action === 'count_on_fingers') { const c = COUNT[Math.min(COUNT.length, Math.max(1, count)) - 1]!; return reduced ? c : { ...c, foR: c.foR - Math.max(0, Math.sin(beat * Math.PI * 6)) * 5 } }
  // comparison: one side, then the other ("this … and that …"), never both waving at once
  if (action === 'compare_with_both_hands' && !reduced) { const left = Math.sin(beat * Math.PI * 2) > 0; return left ? { upL: -50, foL: 74, upR: 70, foR: -30 } : { upL: -70, foL: 30, upR: 50, foR: -74 } }
  const list = POSES[action]
  if (!list) return REST
  const base = list[Math.abs(variant) % list.length]!
  if (reduced) return base
  const s = Math.sin(beat * Math.PI * 2)
  if (action === 'welcome_and_wave') return { ...base, foR: base.foR + Math.sin(beat * Math.PI * 4) * 7 }
  if (action === 'emphasize_important_point') return { ...base, foR: base.foR + Math.abs(Math.sin(beat * Math.PI * 3)) * 9 }
  return { ...base, upR: base.upR + s * 2.5, foR: base.foR + Math.sin(beat * Math.PI * 2 + 1) * 4 }
}

/** frame-rate independent easing toward a pose (no overshoot) */
export function easeArms(cur: ArmPose, to: ArmPose, dt: number, rate = 6): ArmPose {
  const k = 1 - Math.exp(-rate * dt)
  return { upL: cur.upL + (to.upL - cur.upL) * k, foL: cur.foL + (to.foL - cur.foL) * k, upR: cur.upR + (to.upR - cur.upR) * k, foR: cur.foR + (to.foR - cur.foR) * k }
}

/** rotate point p around c by deg (canvas convention) */
export function turn(p: readonly [number, number], c: readonly [number, number], deg: number): [number, number] {
  const a = (deg * Math.PI) / 180, x = p[0] - c[0], y = p[1] - c[1]
  return [c[0] + x * Math.cos(a) - y * Math.sin(a), c[1] + x * Math.sin(a) + y * Math.cos(a)]
}
