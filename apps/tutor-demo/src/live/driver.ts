import { canEnter, STATE_ACTION, stateFor, type Action, type CharacterState, type Gaze } from './choreography.ts'
import { NEUTRAL, normDeg, solveArm, stepPose, targetPose, type Pose, type Vec } from './pose.ts'
import { RIG, type RigHandle } from './VidyaRig.tsx'
import { LevelFollower, MOUTH, mouthFromAudio, visemeAt, VoicedClock, type Viseme, type VisemeCue } from './visemes.ts'
import { classify, fuse, LipLatency, SilenceGate, type AudioFeatures, type SoundClass } from './lipsync.ts'

export interface SpeechFeed { cues: VisemeCue[]; clock: () => number; level: () => number | null; tilt?: () => number | null; features?: () => AudioFeatures | null }

/** The one animation loop: blends clips, gaze, blinks, breath, lip-sync and pointing into the rig. Never re-renders React. */
export class RigDriver {
  private pose: Pose = { ...NEUTRAL }
  private mouth = { open: 0, wide: 0, round: 0 }
  private raf = 0
  private last = 0
  private sinceDraw = 0
  private beat = 0
  private blinkT = 2.4
  private blinkLeft = 0
  private glanceT = 3
  private glance = { x: 0, y: 0 }
  private clock = 0
  private oneShot: { until: number; back: CharacterState } | null = null
  private pendingBeat: { action: Action; gaze: Gaze } | null = null
  private lipFeed: SpeechFeed | null = null
  private variant = 0
  private viseme: string = 'rest'
  /** which step of a list or worked example is being presented */
  count = 1
  private follower = new LevelFollower()
  private gate = new SilenceGate()
  /** what the lips are doing this frame (for the renderer and the lip-sync check) */
  lip: { viseme: Viseme; cls: SoundClass; level: number; open: number } = { viseme: 'rest', cls: 'silence', level: 0, open: 0 }
  readonly latency = new LipLatency()
  private voicedClock = new VoicedClock()
  state: CharacterState = 'idle'
  action: Action = STATE_ACTION.idle
  gaze: Gaze = 'audience'
  speech: SpeechFeed | null = null
  /** screen position of what she is pointing at (null = not pointing) */
  pointAt: (() => Vec | 'hold' | null) | null = null
  onFrame: ((tip: Vec | null, target: Vec | null) => void) | null = null
  readonly frameMs: number
  readonly reduced: boolean

  private rig: RigHandle

  constructor(rig: RigHandle, opts: { reduced: boolean; lowPower: boolean }) {
    this.rig = rig
    this.reduced = opts.reduced
    this.frameMs = opts.lowPower ? 1000 / 30 : 0
  }

  setState(next: CharacterState, ms?: number) {
    // the greeting is finished before anything else (a state asked for meanwhile follows it); only the student interrupts it
    if (this.state === 'greeting' && this.oneShot && next !== 'interrupted' && next !== 'listening' && next !== 'greeting') { this.oneShot.back = next; return true }
    if (!canEnter(this.state, next)) return false
    const back = this.oneShot?.back ?? (this.state === 'hover' ? 'idle' : this.state)
    this.state = next
    this.action = STATE_ACTION[next]
    this.gaze = next === 'thinking' ? 'away' : 'audience'
    this.oneShot = ms ? { until: this.clock + ms / 1000, back: back === next ? 'idle' : back } : null
    return true
  }
  /**
   * Raise Hand / the student speaks: the voice is already stopped by the player; the mouth closes and the gesture is
   * dropped in this same frame, then she listens. Only listening or thinking can follow, so nothing resumes by itself.
   */
  interrupt() {
    this.speech = null
    this.lipFeed = null
    this.mouth = { open: 0, wide: 0, round: 0 }
    this.lip = { viseme: 'rest', cls: 'silence', level: 0, open: 0 }
    this.state = 'interrupted'
    this.action = STATE_ACTION.interrupted
    this.gaze = 'audience'
    this.oneShot = { until: this.clock + 0.35, back: 'listening' }
  }
  /** a teaching beat chosen by the choreography (keeps the state in step with the action) */
  play(action: Action, gaze: Gaze, count?: number) {
    if (count) this.count = count
    if (this.state === 'interrupted') return
    if (action === this.action && gaze === this.gaze && this.state === stateFor(action)) return
    // a lesson that starts while she is still greeting: the greeting finishes, then this beat
    if (this.state === 'greeting' && this.oneShot) { this.oneShot.back = stateFor(action); this.pendingBeat = { action, gaze }; return }
    if (action !== this.action) this.variant++ // deterministic variety: the same lesson performs the same way
    this.action = action
    this.gaze = gaze
    this.state = stateFor(action)
    this.oneShot = null
  }

  start() {
    if (this.raf) return
    this.last = performance.now()
    const tick = (now: number) => {
      this.raf = requestAnimationFrame(tick)
      if (typeof document !== 'undefined' && document.hidden) { this.last = now; return }
      this.sinceDraw += now - this.last
      const dtMs = now - this.last
      this.last = now
      if (this.sinceDraw < this.frameMs) return
      const dt = Math.min(0.1, this.sinceDraw / 1000)
      this.sinceDraw = 0
      void dtMs
      this.frame(dt)
    }
    this.frame(0.016)
    this.raf = requestAnimationFrame(tick)
  }
  stop() { cancelAnimationFrame(this.raf); this.raf = 0 }

  private frame(dt: number) {
    this.clock += dt
    if (this.oneShot && this.clock >= this.oneShot.until) { const b = this.oneShot.back; this.oneShot = null; this.state = b; this.action = this.pendingBeat && stateFor(this.pendingBeat.action) === b ? this.pendingBeat.action : STATE_ACTION[b]; this.gaze = this.pendingBeat?.gaze ?? 'audience'; this.pendingBeat = null }
    this.beat = (this.beat + dt / 3.4) % 1
    // idle is a relaxed stance, not a gesture
    let target = this.state === 'idle' ? { ...NEUTRAL } : targetPose(this.action, this.beat, this.reduced)
    // the content is not on the board yet (or is scrolling in): keep teaching the student, never point at nothing
    const aim = this.gaze === 'board' ? this.pointAt?.() ?? null : null
    if (aim === 'hold') target = targetPose('explain_with_open_palms', this.beat, this.reduced)

    // natural gaze: mostly on the student with brief glances away, never a fixed stare
    this.glanceT -= dt
    if (this.glanceT <= 0) {
      const away = Math.random() < 0.3
      this.glance = away ? { x: (Math.random() - 0.5) * 0.5, y: (Math.random() - 0.4) * 0.3 } : { x: 0, y: 0 }
      this.glanceT = away ? 0.5 + Math.random() * 0.6 : 2.2 + Math.random() * 2.8
    }
    if ((this.gaze === 'audience' || aim === 'hold') && !this.reduced) { target.gazeX += this.glance.x; target.gazeY += this.glance.y }

    // pointing: solve the arm toward the real board element
    let tipTarget: Vec | null = null
    if (aim && aim !== 'hold') {
      const screen = aim
      tipTarget = screen
      const local = screen ? this.rig.toRig(screen) : null
      if (screen && local) {
        // the wrist stops one hand-length short, so the fingertip (not the palm) arrives at the content
        const away = Math.hypot(local.x - RIG.shoulderB.x, local.y - RIG.shoulderB.y) || 1
        const wristGoal = { x: local.x - ((local.x - RIG.shoulderB.x) / away) * RIG.hand, y: local.y - ((local.y - RIG.shoulderB.y) / away) * RIG.hand }
        const s = solveArm(RIG.shoulderB, wristGoal, RIG.upper, RIG.fore)
        target.bS = s.shoulder
        target.bE = s.elbow
        const a = ((s.shoulder + s.elbow) * Math.PI) / 180, u = (s.shoulder * Math.PI) / 180
        const wrist = { x: RIG.shoulderB.x - Math.sin(u) * RIG.upper - Math.sin(a) * RIG.fore, y: RIG.shoulderB.y + Math.cos(u) * RIG.upper + Math.cos(a) * RIG.fore }
        const wristAim = (Math.atan2(local.y - wrist.y, local.x - wrist.x) * 180) / Math.PI - 90
        target.bW = Math.max(-42, Math.min(42, normDeg(wristAim - (s.shoulder + s.elbow))))
        target.gazeY = Math.max(-0.6, Math.min(0.6, (local.y - 270) / 500))
      }
    }
    this.pose = this.reduced ? stepPose(this.pose, target, dt, 22) : stepPose(this.pose, target, dt, this.action === 'welcome_and_wave' ? 7 : 8.5)

    // lips: shape from the text, opening scaled by the real audio level when one exists
    let goal: { open: number; wide: number; round: number } = MOUTH.rest
    this.viseme = 'rest'
    if (this.speech !== this.lipFeed) { this.lipFeed = this.speech; this.follower = new LevelFollower(); this.voicedClock = new VoicedClock() }
    let cls: SoundClass = 'silence', level = 0
    if (this.speech) {
      const real = this.speech.clock(), lvl = this.speech.level()
      const feat = this.speech.features?.() ?? null
      if (feat) {
        // the real audio decides: its acoustic class (silence, closed lips, hiss, vowel) and, when clear, the vowel;
        // the spoken text supplies the likely sound at this moment
        const speaking = this.gate.update(feat.rms, dt)
        const loud = this.follower.update(feat.rms, dt)
        level = loud
        cls = classify(feat, speaking)
        const text = visemeAt(this.speech.cues, this.voicedClock.advance(real, speaking, dt))
        const v = fuse(text, cls, feat)
        this.viseme = v
        const shape = MOUTH[v]
        goal = cls === 'silence' ? MOUTH.rest : cls === 'closed' ? MOUTH.mbp : { open: Math.max(0.18, loud) * (0.5 + 0.5 * shape.open), wide: shape.wide, round: shape.round }
        this.latency.frame(performance.now(), speaking, this.mouth.open > 0.12)
      } else if (lvl === null) { this.viseme = visemeAt(this.speech.cues, real); goal = MOUTH[this.viseme as keyof typeof MOUTH] } // no audio signal (device voice or captions): the estimate alone
      else {
        const loud = this.follower.update(lvl, dt)
        const shape = visemeAt(this.speech.cues, this.voicedClock.advance(real, loud > 0.12, dt))
        this.viseme = loud > 0.08 ? shape : 'rest'
        goal = mouthFromAudio(MOUTH[shape], loud, this.speech.tilt?.() ?? null)
      }
    }
    const k = 1 - Math.exp(-(this.speech ? 38 : 14) * dt)
    const closing = 1 - Math.exp(-70 * dt) // lips close faster than they open, so pauses read as pauses
    this.mouth = { open: this.mouth.open + (goal.open - this.mouth.open) * (goal.open < this.mouth.open ? closing : k), wide: this.mouth.wide + (goal.wide - this.mouth.wide) * k, round: this.mouth.round + (goal.round - this.mouth.round) * k }
    this.lip = { viseme: this.viseme as Viseme, cls, level, open: this.mouth.open }

    // blinks
    this.blinkT -= dt
    if (this.blinkT <= 0) { this.blinkLeft = 0.15; this.blinkT = 2.2 + Math.random() * 3.6 }
    let blink = 0
    if (this.blinkLeft > 0) { this.blinkLeft -= dt; blink = Math.sin(Math.max(0, Math.min(1, 1 - this.blinkLeft / 0.15)) * Math.PI) }
    const breath = this.reduced ? 0 : Math.sin(this.clock * 1.25)
    // a slow weight shift, so she never stands perfectly still
    const sway = this.reduced ? 0 : Math.sin(this.clock * 0.31) * 0.7
    this.rig.apply({ ...this.pose, hip: this.pose.hip + sway }, this.mouth, breath, blink, { dt, action: this.action, gaze: this.gaze, state: this.state, beat: this.beat, aim: tipTarget, count: this.count, viseme: this.viseme, variant: this.variant })
    if (this.onFrame) this.onFrame(tipTarget ? this.rig.fingertip() : null, tipTarget)
  }
}
