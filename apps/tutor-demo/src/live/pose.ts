/** Skeleton pose and authored clips for the 2D rig. Angles in degrees; every clip is data, blended by one spring. */
import type { Action } from './choreography.ts'

export interface Pose {
  yaw: number; headRoll: number; headPitch: number; torsoLean: number; torsoYaw: number; hip: number
  // viewer-left arm (near the student) and viewer-right arm (board side)
  aS: number; aE: number; aW: number; aCurl: number; aThumb: number
  bS: number; bE: number; bW: number; bCurl: number; bIndex: number; bThumb: number
  smile: number; browUp: number; browIn: number; lid: number; gazeX: number; gazeY: number
}

export const NEUTRAL: Pose = { yaw: 0, headRoll: 0, headPitch: 0, torsoLean: 0, torsoYaw: 0, hip: 0, aS: 10, aE: 14, aW: 0, aCurl: 0.35, aThumb: 0, bS: -10, bE: -14, bW: 0, bCurl: 0.35, bIndex: 0.35, bThumb: 0, smile: 0.35, browUp: 0, browIn: 0, lid: 0, gazeX: 0, gazeY: 0 }
export const POSE_KEYS = Object.keys(NEUTRAL) as (keyof Pose)[]

const toBoard: Partial<Pose> = { yaw: 0.72, torsoYaw: 0.5, torsoLean: 1.5, hip: 3, gazeX: 0.85, gazeY: -0.1, headRoll: 1.5, headPitch: -2 }

/** key pose + a slow beat (0..1 phase) so a held gesture stays alive without looping visibly */
export const CLIPS: Record<Action, { pose: Partial<Pose>; beat?: (b: number) => Partial<Pose> }> = {
  welcome_and_wave: { pose: { bS: -128, bE: -52, bCurl: 0, bIndex: 0, smile: 1, browUp: 0.5, headRoll: -3 }, beat: (b) => ({ bE: -52 + Math.sin(b * Math.PI * 4) * 20, bW: Math.sin(b * Math.PI * 4) * 12 }) },
  audience_explanation: { pose: { aS: 12, aE: 40, aCurl: 0.2, smile: 0.5 }, beat: (b) => ({ aE: 40 + Math.sin(b * Math.PI * 2) * 12, headRoll: Math.sin(b * Math.PI * 2) * 1.6 }) },
  turn_towards_board: { pose: { ...toBoard, bS: -62, bE: -18, bCurl: 0.5, bIndex: 0.2, smile: 0.4 } },
  point_to_board: { pose: { ...toBoard, bS: -78, bE: -22, bCurl: 0.92, bIndex: 0, bThumb: 0.4, smile: 0.45, browUp: 0.15 } },
  trace_equation: { pose: { ...toBoard, bS: -78, bE: -22, bCurl: 0.92, bIndex: 0, bThumb: 0.4, smile: 0.35, browUp: 0.1, browIn: 0.15 } },
  explain_with_open_palms: { pose: { aS: 14, aE: 50, aW: -12, aCurl: 0.05, bS: -14, bE: -50, bW: 12, bCurl: 0.05, bIndex: 0.05, smile: 0.55, browUp: 0.2 }, beat: (b) => ({ aE: 50 + Math.sin(b * Math.PI * 2) * 10, bE: -50 - Math.sin(b * Math.PI * 2 + 0.7) * 10 }) },
  emphasize_important_point: { pose: { bS: -48, bE: -96, bCurl: 0.9, bIndex: 0, bThumb: 0.4, browUp: 0.55, smile: 0.3, headPitch: 2 }, beat: (b) => ({ bE: -96 + Math.abs(Math.sin(b * Math.PI * 3)) * 16, headPitch: 2 + Math.abs(Math.sin(b * Math.PI * 3)) * 2.4 }) },
  compare_with_both_hands: { pose: { aS: 22, aE: 44, aCurl: 0.08, bS: -22, bE: -44, bCurl: 0.08, bIndex: 0.08, smile: 0.4, browUp: 0.25 }, beat: (b) => { const s = Math.sin(b * Math.PI * 2); return { aS: 22 + s * 9, bS: -22 + s * 9, headRoll: s * 3, yaw: s * 0.12 } } },
  ask_student_question: { pose: { headRoll: 6, aS: 16, aE: 58, aW: -18, aCurl: 0.05, smile: 0.6, browUp: 0.8, headPitch: -1 } },
  attentive_listening: { pose: { headRoll: 4, headPitch: 2, torsoLean: -1.5, aS: 14, aE: 34, bS: -14, bE: -34, smile: 0.45, browUp: 0.25 }, beat: (b) => ({ headPitch: 2 + Math.max(0, Math.sin(b * Math.PI * 2)) * 2.6 }) },
  thoughtful_pause: { pose: { aS: 18, aE: -165, aW: 12, aCurl: 0.6, headRoll: -3, smile: 0.12, browIn: 0.5, gazeX: -0.35, gazeY: -0.55, lid: 0.12 } },
  encouraging_response: { pose: { aS: 15, aE: 48, aCurl: 0.05, bS: -15, bE: -48, bCurl: 0.05, bIndex: 0.05, smile: 0.75, browUp: 0.45, headRoll: 3 }, beat: (b) => ({ headPitch: Math.max(0, Math.sin(b * Math.PI * 2)) * 2.2 }) },
  celebrate_correct_answer: { pose: { bS: -112, bE: -46, bCurl: 1, bIndex: 1, bThumb: -1, smile: 1, browUp: 0.7 }, beat: (b) => ({ headPitch: Math.max(0, Math.sin(b * Math.PI * 4)) * 3, bE: -46 + Math.sin(b * Math.PI * 4) * 7 }) },
  supportive_wrong_answer: { pose: { aS: 14, aE: 58, aW: -8, aCurl: 0.1, smile: 0.5, browUp: 0.35, browIn: 0.3, headRoll: 3.5, headPitch: 1.5 } },
  count_on_fingers: { pose: { bS: -40, bE: -112, bCurl: 0.6, bIndex: 0, smile: 0.5, browUp: 0.25 } },
  conclude_lesson: { pose: { aS: 12, aE: 62, aW: -22, aCurl: 0.15, bS: -12, bE: -62, bW: 22, bCurl: 0.15, bIndex: 0.15, smile: 0.8, browUp: 0.15, headPitch: 2 } },
}

export function targetPose(action: Action, beat: number, reduced: boolean): Pose {
  const c = CLIPS[action]
  return { ...NEUTRAL, ...c.pose, ...(!reduced && c.beat ? c.beat(beat) : {}) }
}

/** critically damped step toward the target, frame-rate independent */
export function stepPose(cur: Pose, to: Pose, dtSec: number, rate = 9): Pose {
  const k = 1 - Math.exp(-rate * dtSec)
  const out = { ...cur }
  for (const key of POSE_KEYS) out[key] = cur[key] + (to[key] - cur[key]) * k
  return out
}

export interface Vec { x: number; y: number }
/** Two-bone inverse kinematics: shoulder and elbow angles that put the wrist on the target, or as near as the arm reaches. */
export function solveArm(shoulder: Vec, target: Vec, upper: number, fore: number): { shoulder: number; elbow: number; reach: Vec; wristAim: number } {
  const dx = target.x - shoulder.x, dy = target.y - shoulder.y
  const dist = Math.hypot(dx, dy) || 1
  const max = (upper + fore) * 0.985, min = Math.abs(upper - fore) + 1
  const d = Math.min(max, Math.max(min, dist))
  const aim = Math.atan2(dy, dx)
  const cosA = (upper * upper + d * d - fore * fore) / (2 * upper * d)
  const cosB = (upper * upper + fore * fore - d * d) / (2 * upper * fore)
  const a = Math.acos(Math.min(1, Math.max(-1, cosA)))
  const b = Math.acos(Math.min(1, Math.max(-1, cosB)))
  // bones hang straight down at 0 degrees; the elbow bends downward, as a person's does when pointing
  const upperAngle = aim + a
  const shoulderDeg = ((upperAngle - Math.PI / 2) * 180) / Math.PI
  const elbowDeg = -((Math.PI - b) * 180) / Math.PI
  return { shoulder: normDeg(shoulderDeg), elbow: elbowDeg, reach: { x: shoulder.x + (Math.cos(aim) * d), y: shoulder.y + (Math.sin(aim) * d) }, wristAim: (aim * 180) / Math.PI }
}
export const normDeg = (x: number) => ((x + 540) % 360) - 180
