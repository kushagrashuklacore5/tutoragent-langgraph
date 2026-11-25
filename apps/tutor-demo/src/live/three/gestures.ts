/**
 * Teaching gestures as body-space hand targets: where the wrist is, where the fingers point, which way the palm faces,
 * and how curled each finger is. Inverse kinematics turns them into shoulder, elbow, wrist and finger rotations.
 * Her right arm carries the books; her left arm (the Smart Board side) does most of the teaching.
 */
import type { Action } from '../choreography.ts'

export type Vec3 = readonly [number, number, number]
/** thumb, index, middle, ring, pinky: 0 open .. 1 closed */
export type Curl = readonly [number, number, number, number, number]
export interface HandPose { w: Vec3; f: Vec3; p: Vec3; curl: Curl }

const RELAXED: Curl = [0.25, 0.28, 0.34, 0.4, 0.46]
const OPEN: Curl = [0.06, 0.05, 0.08, 0.12, 0.16]
const SOFT: Curl = [0.15, 0.14, 0.2, 0.26, 0.32]
const POINT: Curl = [0.6, 0, 0.88, 0.94, 0.96]
const FIST: Curl = [0.55, 0.8, 0.9, 0.92, 0.94]
const PINCH: Curl = [0.52, 0.5, 0.42, 0.5, 0.58]
const THUMBS: Curl = [0, 1, 1, 1, 1]

export const REST_LEFT: HandPose = { w: [0.262, 0.925, 0.055], f: [0.1, -0.97, 0.22], p: [-0.92, -0.05, 0.38], curl: RELAXED }
/** cradling the books against her body, as in the reference */
export const CRADLE: HandPose = { w: [-0.095, 1.075, 0.178], f: [0.93, 0.26, -0.1], p: [-0.05, -0.08, -1], curl: [0.34, 0.5, 0.54, 0.58, 0.62] }

const at = (w: Vec3, f: Vec3, p: Vec3, curl: Curl): HandPose => ({ w, f, p, curl })
const POSES: Record<Action, HandPose[]> = {
  welcome_and_wave: [at([0.325, 1.405, 0.135], [0.22, 0.95, 0.12], [-0.12, -0.1, 1], OPEN)],
  audience_explanation: [
    at([0.285, 1.13, 0.205], [0.42, 0.26, 0.86], [-0.22, 0.95, -0.2], SOFT),
    at([0.245, 1.17, 0.235], [0.2, 0.34, 0.92], [-0.42, 0.86, -0.25], SOFT),
  ],
  turn_towards_board: [at([0.35, 1.205, 0.13], [0.86, 0.34, 0.36], [-0.3, 0.92, -0.12], SOFT)],
  point_to_board: [at([0.42, 1.27, 0.12], [0.95, 0.12, 0.25], [0, -1, 0], POINT)],
  trace_equation: [at([0.42, 1.27, 0.12], [0.95, 0.12, 0.25], [0, -1, 0], POINT)],
  explain_with_open_palms: [
    at([0.345, 1.215, 0.175], [0.74, 0.34, 0.58], [-0.3, 0.92, -0.2], OPEN), // the reference pose: an open, offering hand
    at([0.3, 1.14, 0.225], [0.5, 0.18, 0.85], [-0.2, 0.97, -0.05], OPEN),
  ],
  emphasize_important_point: [
    at([0.232, 1.235, 0.235], [0.08, 0.62, 0.78], [-0.94, 0.14, 0.3], PINCH),
    at([0.26, 1.2, 0.235], [0.12, 0.46, 0.88], [-0.9, 0.3, 0.2], FIST),
  ],
  compare_with_both_hands: [at([0.33, 1.16, 0.2], [0.62, 0.22, 0.75], [-0.14, 0.98, -0.1], OPEN), at([0.1, 1.17, 0.27], [-0.1, 0.22, 0.97], [-0.14, 0.98, -0.2], OPEN)],
  ask_student_question: [at([0.295, 1.205, 0.225], [0.34, 0.2, 0.92], [-0.1, 0.98, -0.2], OPEN)],
  attentive_listening: [at([0.232, 1.06, 0.145], [-0.18, 0.28, 0.94], [-0.74, 0.64, -0.2], RELAXED)],
  thoughtful_pause: [at([0.098, 1.322, 0.178], [-0.36, 0.84, -0.4], [-0.34, -0.5, -0.8], [0.42, 0.22, 0.74, 0.84, 0.9])], // fingers resting at the chin
  encouraging_response: [at([0.28, 1.135, 0.25], [0.26, 0.22, 0.94], [-0.08, 0.97, -0.2], OPEN)],
  celebrate_correct_answer: [at([0.285, 1.3, 0.215], [0.24, 0.22, 0.94], [-0.96, 0.1, 0.22], THUMBS)],
  supportive_wrong_answer: [at([0.095, 1.262, 0.16], [-0.86, 0.42, 0.08], [0.02, -0.05, -1], SOFT)],
  conclude_lesson: [at([0.195, 1.155, 0.232], [-0.24, 0.3, 0.92], [-0.54, 0.76, -0.32], SOFT)],
  count_on_fingers: [at([0.3, 1.27, 0.2], [0.16, 0.92, 0.32], [-0.1, -0.3, -0.95], FIST)],
}

/** how many fingers are showing for step n (1..5): index first, then middle, ring, pinky, thumb */
export function countCurl(n: number): Curl {
  const k = Math.max(1, Math.min(5, Math.round(n)))
  return [k >= 5 ? 0.02 : 0.72, 0, k >= 2 ? 0 : 0.94, k >= 3 ? 0.02 : 0.95, k >= 4 ? 0.04 : 0.96]
}
const shift = (w: Vec3, x: number, y: number, z: number): Vec3 => [w[0] + x, w[1] + y, w[2] + z]

/** The free hand for this moment. `variant` comes from the lesson position, so a replay looks the same and repeats differ. */
export function handFor(action: Action, beat: number, variant: number, count: number, reduced: boolean): HandPose {
  const list = POSES[action]
  if (action === 'compare_with_both_hands') {
    // weighing one idea against the other, hand moving between two places
    const t = 0.5 + 0.5 * Math.sin(beat * Math.PI * 2), a = list[0]!, b = list[1]!
    const mix = (x: Vec3, y: Vec3): Vec3 => [x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]
    return reduced ? a : { ...a, w: mix(a.w, b.w), f: mix(a.f, b.f) }
  }
  const base = list[Math.abs(variant) % list.length]!
  if (action === 'count_on_fingers') return { ...base, curl: countCurl(count), w: reduced ? base.w : shift(base.w, 0, Math.sin(beat * Math.PI * 4) * 0.004, 0) }
  if (reduced) return base
  const s = Math.sin(beat * Math.PI * 2)
  switch (action) {
    case 'welcome_and_wave': return { ...base, w: shift(base.w, Math.sin(beat * Math.PI * 4) * 0.018, 0, 0) } // one small, warm hello
    case 'emphasize_important_point': return { ...base, w: shift(base.w, 0, -Math.abs(Math.sin(beat * Math.PI * 3)) * 0.028, Math.abs(Math.sin(beat * Math.PI * 3)) * 0.012) }
    case 'audience_explanation': case 'explain_with_open_palms': return { ...base, w: shift(base.w, s * 0.012, Math.sin(beat * Math.PI * 2 + 1) * 0.012, s * 0.006) }
    case 'encouraging_response': case 'ask_student_question': return { ...base, w: shift(base.w, 0, s * 0.006, 0) }
    default: return base
  }
}
/** the book arm follows gently, so the body never moves in one piece */
export function bookHand(action: Action, beat: number, reduced: boolean): HandPose {
  const lift = action === 'thoughtful_pause' ? 0.012 : action === 'celebrate_correct_answer' ? 0.018 : 0
  return { ...CRADLE, w: shift(CRADLE.w, 0, lift + (reduced ? 0 : Math.sin(beat * Math.PI * 2 + 2) * 0.0028), 0) }
}
