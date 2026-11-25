import { test } from 'node:test'
import assert from 'node:assert/strict'
import { commitsTurn, dragProgress, gestureDir, turnTarget, wheelStep } from '../src/lib/pageTurn.ts'
import { micProblem, pickMime } from '../src/live/recorder.ts'
import { actionFor, audienceShare, canEnter, exampleSteps, firstReference, formulaTerms, phaseAt, phasesFor, stateFor, STATE_ACTION, stepAt, type CharacterState } from '../src/live/choreography.ts'
import { CLIPS, NEUTRAL, normDeg, solveArm, stepPose, targetPose } from '../src/live/pose.ts'
import { estimateSeconds, LevelFollower, MOUTH, mouthFromAudio, soundsOf, visemeAt, visemeTrack, VoicedClock } from '../src/live/visemes.ts'

const seg = (type: string, speech = 'plain sentence here', index = 1) => ({ type, speech, index, total: 8 })

test('every required state has an action and a hover never interrupts teaching', () => {
  const states: CharacterState[] = ['idle', 'hover', 'greeting', 'listening', 'thinking', 'speaking', 'explaining', 'emphasizing', 'happy', 'encouraging', 'confused', 'celebrating', 'asking_question', 'goodbye']
  for (const s of states) assert.ok(CLIPS[STATE_ACTION[s]], s)
  assert.equal(canEnter('speaking', 'hover'), false)
  assert.equal(canEnter('listening', 'hover'), false)
  assert.equal(canEnter('idle', 'hover'), true)
  assert.equal(canEnter('speaking', 'listening'), true, 'a student interruption always wins')
  assert.equal(stateFor('supportive_wrong_answer'), 'encouraging')
})

test('gestures follow the meaning of the lesson block, deterministically', () => {
  assert.equal(actionFor(seg('heading', 'Topic', 0)), 'audience_explanation', 'the greeting is its own state, never a lesson gesture')
  assert.equal(actionFor(seg('formula')), 'trace_equation')
  assert.equal(actionFor(seg('definition')), 'point_to_board')
  assert.equal(actionFor(seg('figure')), 'point_to_board')
  assert.equal(actionFor(seg('exam')), 'emphasize_important_point')
  assert.equal(actionFor(seg('summary')), 'conclude_lesson')
  assert.equal(actionFor(seg('question')), 'ask_student_question')
  assert.equal(actionFor(seg('feedback_correct')), 'celebrate_correct_answer')
  assert.equal(actionFor(seg('feedback_support')), 'supportive_wrong_answer')
  assert.equal(actionFor(seg('text', 'यह बात याद रखिए')), 'emphasize_important_point')
  assert.equal(actionFor(seg('text', 'mass versus weight')), 'compare_with_both_hands')
  assert.equal(actionFor(seg('text', 'hello', 3)), actionFor(seg('text', 'hello', 3)), 'a replay looks the same')
})

test('board segments turn to the board, highlight, then return to the student', () => {
  const p = phasesFor(seg('formula'))
  assert.deepEqual(p.map((x) => x.gaze), ['audience', 'board', 'board', 'audience'])
  assert.equal(p.at(-1)!.to, 1)
  assert.equal(phaseAt(p, 0.4).action, 'trace_equation')
  assert.equal(phaseAt(p, 0.4).highlight, true)
  assert.equal(phaseAt(p, 0.9).highlight, false)
  const share = audienceShare([seg('heading', 'x'.repeat(50), 0), seg('text', 'x'.repeat(200)), seg('formula', 'x'.repeat(120)), seg('example', 'x'.repeat(160)), seg('summary', 'x'.repeat(120))])
  assert.ok(share > 0.6 && share < 0.85, `audience share ${share}`)
})

test('board parts come only from the real text', () => {
  assert.deepEqual(formulaTerms('F = m a  (F: net force in N, m: mass in kg)'), ['F', 'm a'])
  assert.deepEqual(formulaTerms('x = (-b ± √D) / 2a').slice(0, 1), ['x'])
  assert.deepEqual(exampleSteps('Here a=2. Then D = 16. So x = 3.'), ['Here a=2.', 'Then D = 16.', 'So x = 3.'])
  assert.equal(stepAt(3, 0.5), 1)
  assert.equal(stepAt(3, 1), 2)
})

test('mouth shapes: real sounds in Latin and Devanagari, closed lips on m/b/p, silence on punctuation', () => {
  assert.equal(soundsOf('ma')[0]!.v, 'mbp')
  assert.equal(soundsOf('ma')[1]!.v, 'aa')
  assert.equal(soundsOf('मा')[0]!.v, 'mbp')
  assert.equal(soundsOf('मा')[1]!.v, 'aa')
  assert.equal(soundsOf('फूल')[1]!.v, 'oo')
  assert.equal(MOUTH.mbp.open, 0)
  const t = visemeTrack('ab. cd', 4)
  assert.equal(t.at(-1)!.t, 4)
  assert.ok(t.some((c) => c.v === 'rest' && c.t > 0 && c.t < 4), 'a pause at the full stop')
  for (let i = 1; i < t.length; i++) assert.ok(t[i]!.t >= t[i - 1]!.t)
  assert.equal(visemeAt(t, 0), 'aa')
  assert.equal(visemeAt(t, 99), 'rest')
  assert.ok(estimateSeconds('एक छोटा वाक्य है।') > 1)
})

test('two-bone arm solver reaches a target, and clamps one that is too far', () => {
  const s = { x: 0, y: 0 }
  const near = { x: 150, y: 60 }
  const r = solveArm(s, near, 132, 122)
  const u = (r.shoulder * Math.PI) / 180, f = ((r.shoulder + r.elbow) * Math.PI) / 180
  const wrist = { x: -Math.sin(u) * 132 - Math.sin(f) * 122, y: Math.cos(u) * 132 + Math.cos(f) * 122 }
  assert.ok(Math.hypot(wrist.x - near.x, wrist.y - near.y) < 1, JSON.stringify(wrist))
  const far = solveArm(s, { x: 2000, y: -100 }, 132, 122)
  const fu = (far.shoulder * Math.PI) / 180, ff = ((far.shoulder + far.elbow) * Math.PI) / 180
  const reach = Math.hypot(-Math.sin(fu) * 132 - Math.sin(ff) * 122, Math.cos(fu) * 132 + Math.cos(ff) * 122)
  assert.ok(reach <= 254 && reach > 240, `reach ${reach}`)
  assert.equal(normDeg(190), -170)
})

test('pose blending converges without overshoot and reduced motion drops the idle beats', () => {
  const to = targetPose('point_to_board', 0.3, true)
  let p = { ...NEUTRAL }
  for (let i = 0; i < 200; i++) { p = stepPose(p, to, 1 / 60); assert.ok(p.yaw <= to.yaw + 1e-9) }
  assert.ok(Math.abs(p.yaw - to.yaw) < 0.01)
  assert.deepEqual(targetPose('audience_explanation', 0.25, true).aE, CLIPS.audience_explanation.pose.aE)
})

test('she points only when her words reach what is on the board', () => {
  const board = 'Chlorophyll absorbs sunlight in the leaf'
  assert.equal(firstReference('Pehle sochiye, phir chlorophyll dekhiye', board)! > 0.3, true)
  assert.equal(firstReference('Ek chhota sa sawaal', board), null)
  const none = phasesFor({ type: 'definition', speech: 'Ek chhota sa sawaal sochiye', index: 1, total: 4, board })
  assert.ok(none.every((p) => p.gaze === 'audience' && !p.highlight), 'no reason to turn, so she does not')
  const speech = 'Pehle ek baat samajhte hain, phir dekhiye chlorophyll kya karta hai'
  const late = phasesFor({ type: 'definition', speech, index: 1, total: 4, board })
  const turn = late.find((p) => p.gaze === 'board')!
  assert.ok(turn.from > 0.4, `turns when the word arrives (${turn.from})`)
  assert.equal(late.at(-1)!.gaze, 'audience')
})

test('page turns: vertical reading never turns a page, and the ends of the book are respected', () => {
  assert.equal(gestureDir(-80, 10), 'next')
  assert.equal(gestureDir(80, 10), 'prev')
  assert.equal(gestureDir(30, 120), null)
  assert.equal(turnTarget(1, 5, 'prev'), null)
  assert.equal(turnTarget(5, 5, 'next'), null)
  assert.equal(turnTarget(2, 5, 'next'), 3)
  assert.equal(commitsTurn(dragProgress(-300, 500, 'next')), true)
  assert.equal(commitsTurn(dragProgress(-40, 500, 'next')), false)
  assert.equal(wheelStep(0, 2, 60).dir, null)
  assert.equal(wheelStep(70, 40, 0).dir, 'next')
})

test('voice input explains each microphone failure', () => {
  assert.equal(micProblem({ name: 'NotAllowedError' }), 'denied')
  assert.equal(micProblem({ name: 'NotFoundError' }), 'no_device')
  assert.equal(micProblem(new Error('x')), 'failed')
  assert.equal(pickMime((t) => t === 'audio/mp4'), 'audio/mp4')
  assert.equal(pickMime(() => false), '')
})

test('lip motion follows the real sound without pretending to know phonemes', () => {
  const f = new LevelFollower()
  let open = 0
  for (let i = 0; i < 20; i++) open = f.update(0.12, 1 / 60)
  assert.ok(open > 0.7, `opens on sound (${open})`)
  for (let i = 0; i < 20; i++) open = f.update(0.002, 1 / 60)
  assert.ok(open < 0.05, `closes in silence (${open})`)
  assert.ok(mouthFromAudio(MOUTH.mbp, 1, null).open < 0.15, 'm, b, p stay nearly closed')
  assert.ok(mouthFromAudio(MOUTH.aa, 1, null).open > mouthFromAudio(MOUTH.td, 1, null).open)
  assert.ok(mouthFromAudio(MOUTH.ee, 0.5, 0.7).wide > mouthFromAudio(MOUTH.ee, 0.5, 0.1).wide, 'brighter sound, wider lips')
  const c = new VoicedClock()
  let t = 0
  for (let i = 1; i <= 120; i++) { t = c.advance(i / 60, false, 1 / 60); assert.ok(Math.abs(t - i / 60) <= 0.2201) }
  for (let i = 121; i <= 240; i++) { t = c.advance(i / 60, true, 1 / 60); assert.ok(t <= i / 60 + 0.1001) }
})

test('3D gestures: every teaching action has a real hand pose, and counting shows the right fingers', async () => {
  const { bookHand, countCurl, handFor } = await import('../src/live/three/gestures.ts')
  const actions = Object.keys(CLIPS) as (keyof typeof CLIPS)[]
  assert.ok(actions.includes('count_on_fingers'))
  for (const a of actions) {
    const h = handFor(a, 0.3, 1, 2, false)
    assert.ok(h.w.every(Number.isFinite) && h.curl.length === 5, a)
    assert.deepEqual(handFor(a, 0.3, 1, 2, false), h, `${a} is deterministic`)
    assert.ok(bookHand(a, 0.3, false).w[0] < 0, 'the books stay in her right hand')
  }
  const open = (n: number) => countCurl(n).filter((c) => c < 0.3).length
  assert.deepEqual([1, 2, 3, 4, 5].map(open), [1, 2, 3, 4, 5])
  assert.notDeepEqual(handFor('explain_with_open_palms', 0, 0, 1, true), handFor('explain_with_open_palms', 0, 1, 1, true), 'a repeated gesture varies')
  assert.equal(actionFor(seg('list')), 'point_to_board')
  assert.equal(phasesFor(seg('list')).at(-1)!.action, 'count_on_fingers')
})

test('3D arm solver: the wrist reaches the target with correct bone lengths, and clamps out of reach', async () => {
  const { Vector3 } = await import('three')
  const { solveElbow } = await import('../src/live/three/ik.ts')
  const S = new Vector3(0.17, 1.37, 0), E = new Vector3(), W = new Vector3()
  solveElbow(S, new Vector3(0.4, 1.2, 0.2), 0.27, 0.25, new Vector3(1, -1, 0), E, W)
  assert.ok(W.distanceTo(new Vector3(0.4, 1.2, 0.2)) < 1e-6)
  assert.ok(Math.abs(E.distanceTo(S) - 0.27) < 1e-6 && Math.abs(E.distanceTo(W) - 0.25) < 1e-6)
  assert.ok(E.y < (S.y + W.y) / 2, 'the elbow bends downward')
  solveElbow(S, new Vector3(3, 1.3, 0), 0.27, 0.25, new Vector3(1, -1, 0), E, W)
  assert.ok(W.distanceTo(S) <= 0.52)
})

test('generated character: a real skinned GLB with finger joints and face morph targets', async () => {
  const { readFileSync } = await import('node:fs')
  const b = readFileSync(new URL('../public/vidya/vidya.glb', import.meta.url))
  assert.equal(b.readUInt32LE(0), 0x46546c67)
  const doc = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString()) as { nodes: { name: string }[]; skins: { joints: number[] }[]; meshes: { name: string; extras?: { targetNames?: string[] }; primitives: { attributes: Record<string, number>; targets?: unknown[]; indices: number }[] }[]; accessors: { count: number }[] }
  const names = new Set(doc.skins[0]!.joints.map((j) => doc.nodes[j]!.name))
  for (const side of ['Left', 'Right']) for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) for (const k of [1, 2, 3]) assert.ok(names.has(`${side}Hand${f}${k}`), `${side} ${f} ${k}`)
  for (const n of ['Spine', 'Neck', 'Head', 'LeftEye', 'RightEye', 'LeftForeArm', 'RightLeg', 'Braid3', 'Dupatta2']) assert.ok(names.has(n), n)
  const face = doc.meshes.find((m) => m.name === 'VidyaFace')!
  assert.deepEqual(face.extras!.targetNames!.slice(0, 2), ['jawOpen', 'mouthWide'])
  assert.ok(face.primitives.every((p) => p.targets?.length === 10))
  const tris = doc.meshes.flatMap((m) => m.primitives).reduce((n, p) => n + doc.accessors[p.indices]!.count / 3, 0)
  assert.ok(tris < 110_000, `${tris} triangles`)
  assert.ok(b.length < 6_000_000, `${b.length} bytes`)
  assert.ok(doc.meshes.some((m) => m.name === 'Books'))
})

test('page physics: a held page stays exactly where the hand is, can go back, and only a release finishes it', async () => {
  const { bendProfile, followHand, releaseTarget, settle, turnAtCursor } = await import('../src/lib/pageCurl.ts')
  let s = { p: 0, v: 0 }
  for (let i = 0; i < 90; i++) s = followHand(s, 0.5, 1 / 60)
  assert.ok(Math.abs(s.p - 0.5) < 1e-3)
  const held = s.p
  for (let i = 0; i < 600; i++) s = followHand(s, 0.5, 1 / 60)
  assert.ok(Math.abs(s.p - held) < 1e-3 && Math.abs(s.v) < 1e-3, 'holding never completes the turn')
  for (let i = 0; i < 60; i++) s = followHand(s, 0.2, 1 / 60)
  assert.ok(s.p < 0.21, 'it moves backwards with the hand')
  assert.equal(releaseTarget(0.2, 0), 0); assert.equal(releaseTarget(0.7, 0), 1)
  assert.equal(releaseTarget(0.2, 2), 1, 'a fast flick turns it'); assert.equal(releaseTarget(0.8, -2), 0)
  let f = { p: 0.6, v: 1.4, done: false }
  for (let i = 0; i < 300 && !f.done; i++) f = settle(f, 1, 1 / 60)
  assert.ok(f.done && f.p > 0.99)
  assert.ok(Math.abs(turnAtCursor(100, 0, 100)) < 1e-9); assert.ok(Math.abs(turnAtCursor(0, 0, 100) - 0.5) < 1e-9); assert.ok(Math.abs(turnAtCursor(-100, 0, 100) - 1) < 1e-9)
  assert.deepEqual(bendProfile(0, 0, 4), [0, 0, 0, 0]); assert.deepEqual(bendProfile(1, 0, 4), [180, 180, 180, 180])
  const curve = (a: number[]) => Math.abs(a.at(-1)! - a[0]!)
  assert.ok(curve(bendProfile(0.4, 2.5, 10)) > curve(bendProfile(0.4, 0.1, 10)), 'faster movement bends the paper more')
})

test('2D Vidya: only rotations of original pieces, resting by default, pointing straight at the board when asked', async () => {
  const { armsFor, easeArms, REST, turn } = await import('../src/live/cutout/poses.ts')
  assert.deepEqual(armsFor('audience_explanation', 'idle', 0, 0, null, false), REST)
  assert.deepEqual(armsFor('point_to_board', 'explaining', 0.3, 0, 12, false), { ...REST, upR: 12, foR: 0 })
  assert.equal(armsFor('point_to_board', 'explaining', 0, 0, 80, false).upR, 35, 'aim is limited to what the shoulder can do')
  assert.notDeepEqual(armsFor('explain_with_open_palms', 'speaking', 0.2, 0, null, true), REST)
  let a = { ...REST }
  for (let i = 0; i < 240; i++) a = easeArms(a, { upL: -76, foL: -6, upR: 30, foR: -90 }, 1 / 60)
  assert.ok(Math.abs(a.upR - 30) < 0.01 && Math.abs(a.foR + 90) < 0.01)
  const [x, y] = turn([10, 0], [0, 0], 90)
  assert.ok(Math.abs(x) < 1e-9 && Math.abs(y - 10) < 1e-9, 'positive angles turn clockwise on screen')
})

test('lip-sync: the sound class comes from the audio spectrum (silence, closed lips, hiss, vowels), not loudness alone', async () => {
  const { featuresFrom, classify, fuse, vowelFrom, SilenceGate, LipLatency } = await import('../src/live/lipsync.ts')
  const SR = 48000, N = 1024, hz = SR / N
  /** a byte spectrum with energy at these frequencies (Hz → 0..255 level) */
  const spectrum = (peaks: [number, number][]) => { const f = new Uint8Array(N / 2).fill(40); for (const [at, v] of peaks) for (let d = -2; d <= 2; d++) { const i = Math.round(at / hz) + d; if (i > 0 && i < f.length) f[i] = Math.max(f[i]!, v - Math.abs(d) * 6) } return f }
  const aa = featuresFrom(spectrum([[150, 200], [800, 250], [1250, 235]]), SR, N, 0.2)
  const ee = featuresFrom(spectrum([[150, 200], [300, 245], [2300, 240]]), SR, N, 0.2)
  const oo = featuresFrom(spectrum([[150, 200], [320, 245], [850, 230]]), SR, N, 0.2)
  const mm = featuresFrom(spectrum([[140, 245], [260, 225]]), SR, N, 0.08)
  const ss = featuresFrom(spectrum([[6000, 240], [7000, 235], [5200, 230]]), SR, N, 0.05)
  assert.equal(vowelFrom(aa), 'aa'); assert.equal(vowelFrom(ee), 'ee'); assert.equal(vowelFrom(oo), 'oo')
  assert.equal(classify(mm, true), 'closed')
  assert.equal(classify(ss, true), 'fricative')
  assert.equal(classify(aa, false), 'silence', 'a pause never moves the mouth')
  // audio decides the class; the text's sound is kept inside a vowel only when the formants are not clear
  assert.equal(fuse('aa', 'silence', aa), 'rest')
  assert.equal(fuse('ee', 'closed', mm), 'mbp')
  assert.equal(fuse('ee', 'vowel', aa), 'aa', 'a clear formant corrects the text estimate')
  assert.equal(fuse('td', 'fricative', ss), 'td')
  // the gate closes on the first silent frame after speech
  const g = new SilenceGate()
  for (let i = 0; i < 30; i++) g.update(0.15, 1 / 60)
  assert.equal(g.update(0.15, 1 / 60), true)
  assert.equal(g.update(0.004, 1 / 60), false)
  const lat = new LipLatency()
  lat.frame(0, false, false); lat.frame(16, true, false); lat.frame(33, true, true); lat.frame(50, false, true); lat.frame(66, false, false)
  assert.deepEqual(lat.summary(), { onsets: 1, onsetMedianMs: 17, onsetP95Ms: 17, offsets: 1, offsetMedianMs: 16, offsetP95Ms: 16 })
})

test('gestures follow what she says, sentence by sentence (steps, comparison, question, encouragement, summary)', async () => {
  const { phasesFor, sentenceAction } = await import('../src/live/choreography.ts')
  const seg = (speech: string, type = 'paragraph', index = 3) => ({ type, speech, index, total: 9 })
  const beats = phasesFor(seg('First, we cut the skin. Second, we lift the muscle. Finally, we look at the organs.'))
  assert.deepEqual(beats.map((b) => [b.action, b.count]), [['count_on_fingers', 1], ['count_on_fingers', 2], ['count_on_fingers', 3]])
  assert.deepEqual(phasesFor(seg('पहला, त्वचा काटते हैं। दूसरा, मांसपेशी उठाते हैं। तीसरा, अंग देखते हैं।')).map((b) => b.count), [1, 2, 3], 'Hindi steps count too')
  assert.equal(sentenceAction('Arteries carry blood away from the heart, whereas veins bring it back.', seg(''), 1).action, 'compare_with_both_hands')
  assert.equal(sentenceAction('Can you guess which organ this is?', seg(''), 1).action, 'ask_student_question')
  assert.equal(sentenceAction('बहुत अच्छा, आप सही दिशा में हैं।', seg(''), 1).action, 'encouraging_response')
  assert.equal(sentenceAction('Yaad rakhiye, this is very important for the exam.', seg(''), 1).action, 'emphasize_important_point')
  assert.equal(sentenceAction('So, in short, dissection shows us how the body is built.', seg(''), 1).action, 'conclude_lesson')
  // plain explanation varies by sentence but is deterministic (the same lesson performs the same way)
  const a = phasesFor(seg('Muscles move bones. They work in pairs. One pulls while the other relaxes.')).map((p) => p.action)
  assert.deepEqual(a, phasesFor(seg('Muscles move bones. They work in pairs. One pulls while the other relaxes.')).map((p) => p.action))
  assert.ok(new Set(a).size >= 2, 'not one repeated gesture')
})
