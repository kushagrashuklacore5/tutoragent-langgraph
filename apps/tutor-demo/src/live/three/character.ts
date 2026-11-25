/** Vidya's real-time 3D body: loads the generated GLB and turns teaching state into bones and face morphs. Loaded lazily. */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import type { Action, Gaze } from '../choreography.ts'
import type { Pose, Vec } from '../pose.ts'
import { bookHand, CRADLE, handFor, REST_LEFT, type Curl, type HandPose, type Vec3 } from './gestures.ts'
import { frameRotation, solveElbow, twistAround } from './ik.ts'

export type Framing = 'stage' | 'hero' | 'compact'
export interface RigContext { dt: number; action: Action; gaze: Gaze; state: string; beat: number; aim: Vec | null; count: number; viseme: string; variant: number }
const FINGER_NAMES = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'] as const
type Side = 'Left' | 'Right'
interface Finger { bones: THREE.Bone[]; axis: THREE.Vector3; spread: number }
interface Arm {
  side: Side; shoulder: THREE.Bone; arm: THREE.Bone; fore: THREE.Bone; hand: THREE.Bone; fingers: Finger[]
  upper: number; lower: number; restU: THREE.Vector3; restL: THREE.Vector3; restF: THREE.Vector3; restP: THREE.Vector3
  w: THREE.Vector3; f: THREE.Vector3; p: THREE.Vector3; curl: number[]
}
const v3 = (x: Vec3) => new THREE.Vector3(x[0], x[1], x[2])
const tmp = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), d: new THREE.Vector3(), e: new THREE.Vector3(), f: new THREE.Vector3(), p: new THREE.Vector3(), q1: new THREE.Quaternion(), q2: new THREE.Quaternion(), q3: new THREE.Quaternion(), q4: new THREE.Quaternion(), eu: new THREE.Euler(), ray: new THREE.Raycaster(), n: new THREE.Vector2(), plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), -0.2) }
const CHEST_REST = new THREE.Vector3(0, 1.27, 0)

export class VidyaCharacter {
  readonly canvas: HTMLCanvasElement
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(20, 1, 0.4, 14)
  private bones = new Map<string, THREE.Bone>()
  private faces: THREE.Mesh[] = []
  private morph: Record<string, number> = {}
  private arms!: { Left: Arm; Right: Arm }
  private root!: THREE.Object3D
  private host: HTMLElement
  private framing: Framing
  private reduced: boolean
  private ro: ResizeObserver | null = null
  private env: THREE.Texture | null = null
  private weights = new Map<string, number>()
  private idle = 0
  private tipSeen = new THREE.Vector3()
  private disposed = false
  private lastCtx: RigContext | null = null

  constructor(host: HTMLElement, opts: { framing: Framing; lowPower: boolean; reduced: boolean }) {
    this.host = host
    this.framing = opts.framing
    this.reduced = opts.reduced
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'default' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.lowPower ? 1.6 : 1.75))
    this.renderer.toneMapping = THREE.NeutralToneMapping
    this.renderer.toneMappingExposure = 1.02
    this.canvas = this.renderer.domElement
    this.canvas.className = 'td-rig3d'
    this.canvas.setAttribute('aria-hidden', 'true')
    if (!opts.lowPower) {
      const pm = new THREE.PMREMGenerator(this.renderer)
      this.env = pm.fromScene(new RoomEnvironment(), 0.05).texture
      pm.dispose()
      this.scene.environment = this.env
      this.scene.environmentIntensity = 0.3
    }
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xd8cfc6, opts.lowPower ? 1.32 : 0.82))
    const key = new THREE.DirectionalLight(0xfffaf4, 1.28); key.position.set(-1.2, 2.4, 3.4); this.scene.add(key)
    const fill = new THREE.DirectionalLight(0xf2f0ff, 0.42); fill.position.set(2.2, 1.2, 2.4); this.scene.add(fill)
    const rim = new THREE.DirectionalLight(0xfff1e2, 0.5); rim.position.set(0.6, 2.2, -2.6); this.scene.add(rim)
  }

  async load(url: string) {
    const gltf = await new GLTFLoader().loadAsync(url)
    if (this.disposed) { this.free(gltf.scene); return }
    this.root = gltf.scene
    this.scene.add(this.root)
    this.root.traverse((o) => {
      if ((o as THREE.Bone).isBone) this.bones.set(o.name, o as THREE.Bone)
      const m = o as THREE.SkinnedMesh
      if (m.isMesh) {
        m.frustumCulled = false
        if (m.morphTargetDictionary && m.morphTargetInfluences) { this.faces.push(m); this.morph = m.morphTargetDictionary }
        const mat = m.material as THREE.MeshStandardMaterial
        if (mat.map) mat.map.anisotropy = 4
        if (mat.name === 'Hair') mat.envMapIntensity = 1.5
      }
    })
    const needed = ['Hips', 'Spine', 'Spine1', 'Chest', 'Neck', 'Head', 'LeftEye', 'RightEye', 'LeftHand', 'RightHand', 'LeftHandIndex4']
    for (const n of needed) if (!this.bones.has(n)) throw new Error(`Character is missing bone ${n}`)
    this.root.updateMatrixWorld(true)
    this.arms = { Left: this.makeArm('Left', REST_LEFT), Right: this.makeArm('Right', CRADLE) }
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.42, 32), new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, toneMapped: false }))
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.002; shadow.scale.set(1, 0.56, 1); this.scene.add(shadow)
    this.placeBooks()
    this.resize()
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(this.host)
  }

  private bone(n: string) { return this.bones.get(n)! }
  private restPos(b: THREE.Object3D) { return new THREE.Vector3().setFromMatrixPosition(b.matrixWorld) }
  private makeArm(side: Side, start: HandPose): Arm {
    const [shoulder, arm, fore, hand] = [`${side}Shoulder`, `${side}Arm`, `${side}ForeArm`, `${side}Hand`].map((n) => this.bone(n)) as [THREE.Bone, THREE.Bone, THREE.Bone, THREE.Bone]
    const A = this.restPos(arm), E = this.restPos(fore), W = this.restPos(hand), M = this.restPos(this.bone(`${side}HandMiddle1`)), I = this.restPos(this.bone(`${side}HandIndex1`)), P = this.restPos(this.bone(`${side}HandPinky1`))
    const s = side === 'Left' ? 1 : -1
    const restF = M.clone().sub(W).normalize(), across = I.clone().sub(P).normalize()
    const restP = new THREE.Vector3().crossVectors(restF, across).multiplyScalar(s).normalize()
    const fingers = FINGER_NAMES.map((name, i): Finger => {
      const list = [1, 2, 3].map((k) => this.bone(`${side}Hand${name}${k}`))
      const a = this.restPos(list[0]!), b = this.restPos(list[1]!)
      const dir = b.sub(a).normalize()
      const toward = name === 'Thumb' ? restP.clone().multiplyScalar(0.55).add(across.clone().multiplyScalar(-0.85)) : restP.clone()
      return { bones: list, axis: new THREE.Vector3().crossVectors(dir, toward).normalize(), spread: i }
    })
    return { side, shoulder, arm, fore, hand, fingers, upper: E.distanceTo(A), lower: W.distanceTo(E), restU: E.clone().sub(A).normalize(), restL: W.clone().sub(E).normalize(), restF, restP, w: v3(start.w), f: v3(start.f).normalize(), p: v3(start.p).normalize(), curl: [...start.curl] }
  }

  /** rests the prop in the cradle pose, then lets it ride on the hand */
  private placeBooks() {
    const books = this.root.getObjectByName('Books')
    if (!books) return
    this.solveArm(this.arms.Right, new THREE.Vector3(-0.72, -0.42, -0.55))
    this.root.updateMatrixWorld(true)
    const target = new THREE.Matrix4().compose(new THREE.Vector3(-0.098, 1.155, 0.142), new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.05, 0.08, -0.09)), new THREE.Vector3(1, 1, 1))
    new THREE.Matrix4().copy(books.parent!.matrixWorld).invert().multiply(target).decompose(books.position, books.quaternion, books.scale)
  }

  private resize() {
    const r = this.host.getBoundingClientRect()
    const hostW = Math.max(1, r.width), h = Math.max(1, r.height)
    // the canvas reaches past her column so a pointing arm is never cut off; she stays centred in her own column
    const w = this.framing === 'stage' ? hostW * 1.75 : hostW
    this.renderer.setSize(w, h)
    const c = this.camera
    c.aspect = w / h
    if (this.framing === 'compact') { c.fov = 16; c.position.set(0, 1.36, 2.55); c.lookAt(0, 1.26, 0) }
    else {
      const fit = Math.max(1.86 / (2 * 5.2 * Math.tan((20 * Math.PI) / 360)), (0.92 / (hostW / h)) / (2 * 5.2 * Math.tan((20 * Math.PI) / 360)))
      const dist = 5.2 * fit
      c.fov = 20; c.position.set(0, 0.98, dist); c.lookAt(0, 0.86, 0)
    }
    if (this.framing === 'stage') c.setViewOffset(w, h, (w - hostW) / 2, 0, w, h); else c.clearViewOffset()
    c.updateProjectionMatrix()
  }

  private solveArm(a: Arm, pole: THREE.Vector3, snapFingers = true) {
    const { a: S, b: elbow, c: wrist, d: wt, e: dirU } = tmp
    const chest = this.bone('Chest')
    a.arm.parent!.updateWorldMatrix(true, false)
    S.setFromMatrixPosition(a.arm.parent!.matrixWorld).add(a.arm.position.clone().applyQuaternion(tmp.q1.setFromRotationMatrix(a.arm.parent!.matrixWorld)))
    // targets are in body space, so gestures travel with the torso
    wt.copy(a.w).sub(CHEST_REST).applyMatrix4(chest.matrixWorld)
    solveElbow(S, wt, a.upper, a.lower, pole, elbow, wrist)
    const parentQ = a.arm.parent!.getWorldQuaternion(tmp.q1)
    dirU.copy(elbow).sub(S).normalize()
    const upperW = tmp.q2.setFromUnitVectors(a.restU, dirU)
    a.arm.quaternion.copy(parentQ).invert().multiply(upperW)
    const dirL = tmp.f.copy(wrist).sub(elbow).normalize()
    const from = tmp.p.copy(a.restL).applyQuaternion(upperW)
    const foreW = tmp.q3.setFromUnitVectors(from, dirL).multiply(upperW)
    const chestQ = chest.getWorldQuaternion(new THREE.Quaternion())
    const handW = frameRotation(a.restF, a.restP, a.f.clone().applyQuaternion(chestQ), a.p.clone().applyQuaternion(chestQ), tmp.q4)
    // most of the wrist's roll is carried by the forearm, as real arms do
    const rel = foreW.clone().invert().multiply(handW)
    const twist = twistAround(rel, a.restL, new THREE.Quaternion())
    const foreT = foreW.clone().multiply(new THREE.Quaternion().slerp(twist, 0.62))
    a.fore.quaternion.copy(upperW).invert().multiply(foreT)
    a.hand.quaternion.copy(foreT).invert().multiply(handW)
    if (snapFingers) this.poseFingers(a)
  }
  private poseFingers(a: Arm) {
    a.fingers.forEach((fg, i) => {
      const c = a.curl[i] ?? 0
      const k = i === 0 ? [0.5, 0.62, 0.72] : [1.18, 1.46, 0.92]
      fg.bones.forEach((b, j) => b.quaternion.setFromAxisAngle(fg.axis, c * k[j]!))
    })
  }
  private approach(a: Arm, to: HandPose, rate: number, dt: number) {
    const k = 1 - Math.exp(-rate * dt), kf = 1 - Math.exp(-rate * 1.45 * dt)
    a.w.lerp(tmp.a.set(to.w[0], to.w[1], to.w[2]), k)
    a.f.lerp(tmp.b.set(to.f[0], to.f[1], to.f[2]).normalize(), k).normalize()
    a.p.lerp(tmp.c.set(to.p[0], to.p[1], to.p[2]).normalize(), k).normalize()
    a.curl = a.curl.map((x, i) => x + ((to.curl as Curl)[i]! - x) * kf)
  }
  /** the screen point on the board, as a hand target */
  private aimHand(aim: Vec): HandPose {
    const r = this.canvas.getBoundingClientRect()
    tmp.n.set(((aim.x - r.left) / r.width) * 2 - 1, -((aim.y - r.top) / r.height) * 2 + 1)
    tmp.ray.setFromCamera(tmp.n, this.camera)
    const hit = tmp.ray.ray.intersectPlane(tmp.plane, new THREE.Vector3()) ?? new THREE.Vector3(0.9, 1.25, 0.2)
    const chest = this.bone('Chest')
    const body = chest.worldToLocal(hit.clone()).add(CHEST_REST)
    const S = this.arms.Left.arm.getWorldPosition(new THREE.Vector3()); const sBody = chest.worldToLocal(S).add(CHEST_REST)
    const dir = body.clone().sub(sBody).normalize()
    if (dir.x < 0.35) { dir.x = 0.35; dir.normalize() }
    const reach = (this.arms.Left.upper + this.arms.Left.lower) * 0.9
    const w = sBody.clone().addScaledVector(dir, reach)
    const palm = new THREE.Vector3(0, -1, 0).addScaledVector(dir, dir.y).normalize()
    return { w: [w.x, w.y, w.z], f: [dir.x, dir.y, dir.z], p: [palm.x, palm.y, palm.z], curl: [0.62, 0, 0.88, 0.94, 0.96] }
  }

  private setFace(name: string, value: number, rate: number, dt: number) {
    const cur = this.weights.get(name) ?? 0
    const next = cur + (value - cur) * (1 - Math.exp(-rate * dt))
    this.weights.set(name, next)
    const i = this.morph[name]
    if (i === undefined) return
    for (const m of this.faces) m.morphTargetInfluences![i] = next
  }

  update(p: Pose, mouth: { open: number; wide: number; round: number }, breath: number, blink: number, ctx: RigContext) {
    if (!this.arms || this.disposed) return
    this.lastCtx = ctx
    const dt = Math.min(0.1, ctx.dt)
    this.idle += dt
    const t = this.idle, still = this.reduced ? 0 : 1
    const sway = Math.sin(t * 0.47) * 0.5 + Math.sin(t * 0.23 + 1) * 0.5 // weight shifts slowly from foot to foot
    const turn = p.torsoYaw
    const e = tmp.eu
    const hips = this.bone('Hips')
    hips.position.set(0.012 * sway * still + p.hip * 0.0025, 0.97 + breath * 0.0012 * still, 0)
    hips.quaternion.setFromEuler(e.set(0, turn * 0.18, -0.012 * sway * still))
    this.bone('Spine').quaternion.setFromEuler(e.set(0.012 + p.torsoLean * 0.004, turn * 0.26, 0.009 * sway * still))
    this.bone('Spine1').quaternion.setFromEuler(e.set(breath * 0.004 * still, turn * 0.3, 0.006 * sway * still))
    this.bone('Chest').quaternion.setFromEuler(e.set(-0.012 - breath * 0.008 * still, turn * 0.36, 0))
    const nod = (p.headPitch * Math.PI) / 180, roll = (-p.headRoll * Math.PI) / 180
    const micro = still * Math.sin(t * 0.83) * 0.012
    this.bone('Neck').quaternion.setFromEuler(e.set(nod * 0.4, p.yaw * 0.22 + micro, roll * 0.4))
    this.bone('Head').quaternion.setFromEuler(e.set(nod * 0.6 - 0.018, p.yaw * 0.42 + micro * 0.6, roll * 0.6))
    // the eyes lead: they look at the student by default and at the board when she turns
    const gx = (p.gazeX * (ctx.gaze === 'board' ? 0.34 : 0.26)) - (ctx.gaze === 'audience' ? (p.yaw * 0.42 + turn * 0.3) * 0.5 : 0), gy = p.gazeY * 0.26
    // eyes rest very slightly apart, as real eyes do, so she never looks cross-eyed
    this.bone('LeftEye').quaternion.setFromEuler(e.set(gy, gx + 0.13, 0))
    this.bone('RightEye').quaternion.setFromEuler(e.set(gy, gx - 0.13, 0))
    for (const n of ['Braid1', 'Braid2', 'Braid3', 'Braid4', 'Braid5']) this.bone(n).quaternion.setFromEuler(e.set(0, 0, Math.sin(t * 0.8 + n.length) * 0.006 * still - p.hip * 0.002))
    ;['Dupatta1', 'Dupatta2', 'Dupatta3', 'Dupatta4'].forEach((n, i) => this.bone(n).quaternion.setFromEuler(e.set(Math.sin(t * 0.7 + i) * 0.006 * still, 0, (Math.sin(t * 0.5 + i * 0.8) * 0.008 - turn * 0.02) * still)))
    this.root.updateMatrixWorld(true)

    const idleBody = ctx.state === 'idle'
    const free = ctx.aim ? this.aimHand(ctx.aim) : idleBody ? REST_LEFT : handFor(ctx.action, ctx.beat, ctx.variant, ctx.count, this.reduced)
    this.approach(this.arms.Left, free, ctx.aim ? 10 : 6.2, dt)
    this.approach(this.arms.Right, bookHand(ctx.action, ctx.beat, this.reduced), 5, dt)
    this.solveArm(this.arms.Left, tmp.e.set(0.5, -0.32, -0.8))
    this.arms.Left.arm.updateWorldMatrix(false, false)
    this.solveArm(this.arms.Right, tmp.e.set(-0.72, -0.42, -0.55))

    // the face: speech shapes first, then what she is feeling
    const speaking = ctx.viseme !== 'rest' || mouth.open > 0.02
    const lip = 34
    this.setFace('jawOpen', Math.min(1, mouth.open * 0.95), lip, dt)
    this.setFace('mouthWide', Math.max(0, mouth.wide) * 0.75, lip, dt)
    this.setFace('mouthRound', Math.min(1, mouth.round), lip, dt)
    this.setFace('mouthClose', ctx.viseme === 'mbp' ? 0.9 : 0, 42, dt)
    this.setFace('lipBite', ctx.viseme === 'fv' ? 0.85 : 0, 42, dt)
    this.setFace('smile', Math.min(1, p.smile * (speaking ? 0.62 : 0.95)), 7, dt)
    this.setFace('browUp', Math.min(1, p.browUp), 8, dt)
    this.setFace('browIn', Math.min(1, p.browIn), 8, dt)
    this.setFace('squint', Math.min(1, p.smile * 0.34 + p.lid * 1.4), 7, dt)
    const b = this.weights.get('blink') ?? 0, want = Math.min(1, Math.max(blink, p.lid * 0.5))
    this.setFace('blink', want, want > b ? 60 : 22, dt)
    this.root.updateMatrixWorld(true)
    this.renderer.render(this.scene, this.camera)
  }

  /** a point on the page, for the existing pointer line */
  fingertip(): Vec | null {
    if (!this.arms) return null
    const r = this.canvas.getBoundingClientRect()
    this.bone('LeftHandIndex4').getWorldPosition(this.tipSeen).project(this.camera)
    return { x: r.left + ((this.tipSeen.x + 1) / 2) * r.width, y: r.top + ((1 - this.tipSeen.y) / 2) * r.height }
  }
  /** preview only: look at her from anywhere */
  lookFrom(pos: readonly [number, number, number], at: readonly [number, number, number], fov: number) { this.ro?.disconnect(); const c = this.camera; c.fov = fov; c.position.set(...pos); c.lookAt(...at); c.updateProjectionMatrix() }
  stats() { const i = this.renderer.info; return { calls: i.render.calls, triangles: i.render.triangles, textures: i.memory.textures, geometries: i.memory.geometries } }
  /** test hook: current morph values and joint rotations, read from the real rig */
  probe() { return { action: this.lastCtx?.action, gaze: this.lastCtx?.gaze, viseme: this.lastCtx?.viseme, count: this.lastCtx?.count, morphs: Object.fromEntries(this.weights), index1: this.bone('LeftHandIndex1').quaternion.toArray(), middle1: this.bone('LeftHandMiddle1').quaternion.toArray(), head: this.bone('Head').quaternion.toArray() } }

  private free(o: THREE.Object3D) {
    o.traverse((x) => {
      const m = x as THREE.Mesh
      if (!m.isMesh) return
      m.geometry.dispose()
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) { (mat as THREE.MeshStandardMaterial).map?.dispose(); mat.dispose() }
      ;(m as THREE.SkinnedMesh).skeleton?.dispose()
    })
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.ro?.disconnect()
    this.free(this.scene)
    this.env?.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.canvas.remove()
  }
}

function shadowTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const x = c.getContext('2d')!
  const g = x.createRadialGradient(64, 64, 4, 64, 64, 64)
  g.addColorStop(0, 'rgba(70,45,25,.42)'); g.addColorStop(0.55, 'rgba(70,45,25,.16)'); g.addColorStop(1, 'rgba(70,45,25,0)')
  x.fillStyle = g; x.fillRect(0, 0, 128, 128)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}
