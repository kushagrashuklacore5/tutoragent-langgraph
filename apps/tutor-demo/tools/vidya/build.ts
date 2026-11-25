/**
 * Builds Vidya's 3D character (public/vidya/vidya.glb) from the supplied reference.
 *   python apps/tutor-demo/tools/vidya/prepare_textures.py "<reference image>"   (only when the reference changes)
 *   node apps/tutor-demo/tools/vidya/build.ts
 * Clean lofted garments and a face surface whose rows follow the real lip line, carrying the reference's own painting.
 * She faces +Z; her left is +X (the Smart Board side). Metres.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { add, blend, clamp, cross, ellipsoid, limb, merge, mix, mul, norm, segmentDistance, smax, smin, smooth, sphere, sub, surfaceNets, tube, type F, type Surface, type V } from './sdf.ts'
import { Glb, type Prim } from './glb.ts'

export const MORPHS = ['jawOpen', 'mouthWide', 'mouthRound', 'mouthClose', 'lipBite', 'smile', 'browUp', 'browIn', 'blink', 'squint'] as const
type MorphName = (typeof MORPHS)[number]
type Part = Surface & { uv?: Float32Array }
const HERE = dirname(fileURLToPath(import.meta.url))
const tex = (n: string) => readFileSync(join(HERE, 'textures', n))
const lin = (hex: number): [number, number, number] => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((c) => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }) as [number, number, number]

// ---------- reference measurements (levelled image pixels to head space) ----------
const HEAD: V = [0, 1.555, 0]
const q = (x: number, y: number, z: number): V => add(HEAD, [x, y, z])
const K = 0.00115, CX = 475
const fx = (px: number) => (px - CX) * K
const fy = (py: number) => 0.012 - (py - 134) * K
const faceU = (x: number) => (x / K + CX - 352) / 250
const faceV = (y: number) => (134 - (y - 0.012) / K - 19) / 250
const lipPx = (px: number) => 183.2 + 7.2 * clamp(1 - ((px - 476) / 27.5) ** 2)
const lipY = (x: number) => fy(lipPx(x / K + CX))
const MY = lipY(fx(476))

// ---------- skeleton ----------
interface Bone { name: string; parent: string | null; pos: V; end?: V }
const bones: Bone[] = []
const bone = (name: string, parent: string | null, pos: V, end?: V) => { bones.push({ name, parent, pos, end }); return pos }
const B = (n: string) => bones.find((b) => b.name === n)!
const EYE_R = 0.0205
const headF: F = (() => {
  const shape = blend(0.034,
    ellipsoid(q(0, 0.03, -0.012), [0.0785, 0.09, 0.096]),
    ellipsoid(q(-0.002, -0.026, 0.017), [0.0645, 0.071, 0.069]),
    sphere(q(0.002, -0.0765, 0.053), 0.0205),
    sphere(q(0.036, -0.016, 0.05), 0.0295), sphere(q(-0.042, -0.016, 0.05), 0.0295))
  const nose = blend(0.008, limb(q(0.001, 0.012, 0.0815), q(0.003, -0.015, 0.0935), 0.0046, 0.0058), sphere(q(0.004, -0.0205, 0.0965), 0.0078), sphere(q(0.0155, -0.0262, 0.0885), 0.0052), sphere(q(-0.0085, -0.0262, 0.0885), 0.0052))
  const ridge = blend(0.018, limb(q(0.012, 0.034, 0.083), q(0.054, 0.034, 0.058), 0.005, 0.0045), limb(q(-0.012, 0.034, 0.083), q(-0.058, 0.034, 0.058), 0.005, 0.0045))
  const lips = ellipsoid(q(0.001, MY - 0.001, 0.0775), [0.031, 0.0125, 0.0125])
  const ears = blend(0.006, ellipsoid(q(0.078, 0.0, -0.012), [0.0072, 0.0245, 0.0148]), ellipsoid(q(-0.078, 0.0, -0.012), [0.0072, 0.0245, 0.0148]))
  const dentL = sphere(q(fx(505), 0.0125, 0.102), 0.0215), dentR = sphere(q(fx(445.5), 0.0125, 0.102), 0.0215)
  return (x, y, z) => {
    let d = smin(smin(smin(shape(x, y, z), nose(x, y, z), 0.011), ridge(x, y, z), 0.018), lips(x, y, z), 0.012)
    d = smax(d, -Math.min(dentL(x, y, z), dentR(x, y, z)), 0.012)
    return smin(d, ears(x, y, z), 0.006)
  }
})()
const surfZ = (x: number, y: number): number | null => { let z = 0.14; for (let i = 0; i < 60; i++) { const d = headF(x, HEAD[1] + y, z + HEAD[2]); if (d < 2e-4) return z; z -= d; if (z < 0) return null } return null }
const EYE: Record<'L' | 'R', V> = { L: q(fx(505), fy(134), surfZ(fx(505), fy(134))! - EYE_R - 0.0018), R: q(fx(445.5), fy(134), surfZ(fx(445.5), fy(134))! - EYE_R - 0.0018) }

bone('Hips', null, [0, 0.97, 0], [0, 1.06, 0])
bone('Spine', 'Hips', [0, 1.06, 0], [0, 1.16, 0])
bone('Spine1', 'Spine', [0, 1.16, 0], [0, 1.27, 0])
bone('Chest', 'Spine1', [0, 1.27, 0], [0, 1.42, -0.008])
bone('Neck', 'Chest', [0, 1.432, -0.012], [0, 1.5, -0.006])
bone('Head', 'Neck', [0, 1.5, -0.006], [0, 1.66, 0])
bone('LeftEye', 'Head', EYE.L); bone('RightEye', 'Head', EYE.R)
interface HandFrame { d: V; t: V; n: V; wrist: V }
const FINGERS = [['Index', 0.0222, 0.0385, 0.0074], ['Middle', 0.0074, 0.0425, 0.0077], ['Ring', -0.008, 0.0395, 0.0071], ['Pinky', -0.0226, 0.031, 0.0062]] as const
const HAND: Partial<Record<'Left' | 'Right', { frame: HandFrame; fingers: { name: string; pts: V[]; r: number }[] }>> = {}
for (const [side, s] of [['Left', 1], ['Right', -1]] as const) {
  bone(`${side}Shoulder`, 'Chest', [s * 0.045, 1.392, -0.006])
  const arm: V = [s * 0.168, 1.368, -0.005], elbow: V = [s * 0.226, 1.102, -0.012], wrist: V = [s * 0.272, 0.858, 0.012]
  B(`${side}Shoulder`).end = arm
  bone(`${side}Arm`, `${side}Shoulder`, arm, elbow)
  bone(`${side}ForeArm`, `${side}Arm`, elbow, wrist)
  const d = norm(sub(wrist, elbow)), t = norm(sub([0, 0, 1], mul(d, d[2]))), n = mul(cross(d, t), s)
  bone(`${side}Hand`, `${side}ForeArm`, wrist, add(wrist, mul(d, 0.09)))
  const at = (a: number, b: number, c: number): V => add(add(add(wrist, mul(d, a)), mul(t, b)), mul(n, c))
  const fingers: { name: string; pts: V[]; r: number }[] = []
  for (const [nm, across, seg, r] of FINGERS) {
    const start = at(0.086 - Math.abs(across) * 0.2, across, 0.002)
    const pts = [start, add(start, mul(d, seg)), add(start, mul(d, seg * 1.62)), add(start, mul(d, seg * 2.05))].map((p, i) => add(p, mul(n, i * 0.0022)))
    fingers.push({ name: nm, pts, r })
    pts.slice(0, 3).forEach((p, i) => bone(`${side}Hand${nm}${i + 1}`, i ? `${side}Hand${nm}${i}` : `${side}Hand`, p, pts[i + 1]))
    bone(`${side}Hand${nm}4`, `${side}Hand${nm}3`, pts[3]!)
  }
  const th = [at(0.018, 0.025, 0.012), at(0.048, 0.047, 0.021), at(0.078, 0.056, 0.028), at(0.102, 0.062, 0.032)]
  fingers.push({ name: 'Thumb', pts: th, r: 0.0092 })
  th.slice(0, 3).forEach((p, i) => bone(`${side}HandThumb${i + 1}`, i ? `${side}HandThumb${i}` : `${side}Hand`, p, th[i + 1]))
  bone(`${side}HandThumb4`, `${side}HandThumb3`, th[3]!)
  HAND[side] = { frame: { d, t, n, wrist }, fingers }
  const hip: V = [s * 0.08, 0.925, 0], knee: V = [s * 0.082, 0.505, 0.012], ankle: V = [s * 0.084, 0.09, -0.012], toe: V = [s * 0.092, 0.025, 0.112]
  bone(`${side}UpLeg`, 'Hips', hip, knee); bone(`${side}Leg`, `${side}UpLeg`, knee, ankle); bone(`${side}Foot`, `${side}Leg`, ankle, toe)
}
const catmull = (P: V[], t: number): V => {
  const n = P.length - 1, x = clamp(t) * n, i = Math.min(n - 1, Math.floor(x)), f = x - i
  const a = P[Math.max(0, i - 1)]!, b = P[i]!, c = P[i + 1]!, d = P[Math.min(n, i + 2)]!
  const h = (k: 0 | 1 | 2) => 0.5 * (2 * b[k] + (c[k] - a[k]) * f + (2 * a[k] - 5 * b[k] + 4 * c[k] - d[k]) * f * f + (3 * b[k] - a[k] - 3 * c[k] + d[k]) * f * f * f)
  return [h(0), h(1), h(2)]
}
const BRAID: V[] = [[-0.07, 1.53, -0.05], [-0.112, 1.45, -0.012], [-0.136, 1.385, 0.074], [-0.142, 1.27, 0.116], [-0.137, 1.15, 0.122], [-0.13, 1.04, 0.118], [-0.122, 0.955, 0.122]]
for (let i = 0; i < 5; i++) bone(`Braid${i + 1}`, i ? `Braid${i}` : 'Head', catmull(BRAID, i / 5), catmull(BRAID, (i + 1) / 5))
const DUP: V[] = [[0.135, 1.39, 0.09], [0.145, 1.13, 0.14], [0.155, 0.88, 0.17], [0.16, 0.62, 0.195], [0.16, 0.3, 0.2]]
DUP.slice(0, 4).forEach((p, i) => bone(`Dupatta${i + 1}`, i ? `Dupatta${i}` : 'Chest', p, DUP[i + 1]))

// ---------- skinning ----------
function skin(s: Surface, names: string[], power = 6) {
  const list = names.map((n) => B(n)), jid = names.map((n) => bones.findIndex((b) => b.name === n))
  const count = s.pos.length / 3, joints = new Uint8Array(count * 4), weights = new Uint8Array(count * 4)
  for (let v = 0; v < count; v++) {
    const p: V = [s.pos[v * 3]!, s.pos[v * 3 + 1]!, s.pos[v * 3 + 2]!]
    const scored = list.map((b, i) => ({ j: jid[i]!, w: 1 / (segmentDistance(p, b.pos, b.end ?? b.pos) + 0.004) ** power })).sort((a, b) => b.w - a.w).slice(0, 4)
    const sum = scored.reduce((n, x) => n + x.w, 0)
    let left = 255
    scored.forEach((x, i) => { const w = i === scored.length - 1 ? left : Math.min(left, Math.round((x.w / sum) * 255)); joints[v * 4 + i] = x.j; weights[v * 4 + i] = w; left -= w })
  }
  return { joints, weights }
}
function rigid(s: Surface, name: string) {
  const c = s.pos.length / 3, j = bones.findIndex((b) => b.name === name), joints = new Uint8Array(c * 4), weights = new Uint8Array(c * 4)
  for (let v = 0; v < c; v++) { joints[v * 4] = j; weights[v * 4] = 255 }
  return { joints, weights }
}
function headWeights(s: Surface) {
  const c = s.pos.length / 3, joints = new Uint8Array(c * 4), weights = new Uint8Array(c * 4), H = bones.findIndex((b) => b.name === 'Head'), N = bones.findIndex((b) => b.name === 'Neck'), Ch = bones.findIndex((b) => b.name === 'Chest')
  for (let v = 0; v < c; v++) {
    const y = s.pos[v * 3 + 1]!, a = smooth(1.462, 1.512, y), b = smooth(1.388, 1.44, y), h = Math.round(a * 255), n = Math.round((1 - a) * b * 255)
    joints[v * 4] = H; weights[v * 4] = h; joints[v * 4 + 1] = N; weights[v * 4 + 1] = n; joints[v * 4 + 2] = Ch; weights[v * 4 + 2] = 255 - h - n
  }
  return { joints, weights }
}

// ---------- face controls ----------
function faceMove(name: MorphName, p: V, jaw?: 0 | 1): V {
  const [x, y, z] = sub(p, HEAD), ax = Math.abs(x), sx = Math.sign(x) || 1
  const near = (cx: number, cy: number, rx: number, ry: number) => Math.exp(-(((ax - cx) / rx) ** 2 + ((y - cy) / ry) ** 2))
  const front = smooth(0.005, 0.045, z), line = lipY(x), corner = 1 - smooth(0.0135, 0.0292, Math.abs(x - 0.001))
  const mouth = Math.exp(-((x / 0.034) ** 2 + ((y - MY) / 0.021) ** 2)) * front
  const lower = jaw === undefined ? smooth(line + 0.0012, line - 0.0028, y) : jaw * corner
  switch (name) {
    case 'jawOpen': { const fall = 1 - smooth(-0.104, -0.13, y) * 0.92, soft = jaw === undefined ? lower : Math.max(lower, smooth(line - 0.002, line - 0.012, y) * 0.92); const w = soft * front * (1 - smooth(0.054, 0.076, ax)) * fall; return [-x * 0.03 * w, -0.0125 * w + (jaw === 0 ? 0.0012 * mouth * corner : 0), -0.0034 * w] }
    case 'mouthWide': return [x * 0.2 * mouth, 0.0004 * mouth, -0.0014 * mouth * (ax / 0.026)]
    case 'mouthRound': return [-x * 0.3 * mouth, (lower > 0.5 ? -0.0009 : 0.0009) * mouth, 0.0048 * mouth]
    case 'mouthClose': return [0, (lower > 0.5 ? 0.0006 : -0.0006) * mouth, 0.0005 * mouth]
    case 'lipBite': { const w = lower * mouth; return [0, 0.0022 * w, -0.0036 * w] }
    case 'smile': { const c = near(0.03, MY + 0.004, 0.016, 0.013) * front, ch = near(0.042, -0.026, 0.024, 0.02) * front; return [sx * 0.0026 * c, 0.0032 * c + 0.002 * ch, 0.0013 * ch] }
    case 'browUp': return [0, 0.0042 * near(0.034, 0.041, 0.031, 0.012) * front, 0]
    case 'browIn': { const w = near(0.024, 0.041, 0.024, 0.011) * front; return [-sx * 0.0026 * w, -0.0024 * w, 0.0007 * w] }
    case 'squint': { const w = near(0.032, -0.006, 0.024, 0.006) * front; return [0, 0.0016 * w, 0.0004 * w] }
    default: return [0, 0, 0]
  }
}
type Custom = Partial<Record<MorphName, (p: V, v: number) => V>>
const morphsOf = (s: Surface, custom?: Custom, jawOf?: (v: number) => 0 | 1 | undefined) => MORPHS.map((m) => {
  const d = new Float32Array(s.pos.length)
  for (let v = 0; v < s.pos.length / 3; v++) {
    const p: V = [s.pos[v * 3]!, s.pos[v * 3 + 1]!, s.pos[v * 3 + 2]!]
    const o = custom?.[m] ? custom[m]!(p, v) : faceMove(m, p, jawOf?.(v))
    d[v * 3] = o[0]; d[v * 3 + 1] = o[1]; d[v * 3 + 2] = o[2]
  }
  return d
})
const none = () => [0, 0, 0] as V
const STILL = Object.fromEntries(MORPHS.map((m) => [m, none])) as Custom

/** the visible face: a fine surface whose rows follow the lip line and split there, so the mouth truly opens */
function faceSurface() {
  const cols = 76, half = 46, xMin = -0.078, xMax = 0.074, yMin = -0.112, yMax = 0.098
  const rowsY: number[] = []
  for (let r = 0; r <= half * 2; r++) { const t = r / (half * 2), c = (MY - yMin) / (yMax - yMin), w = t < c ? c - (c - t) ** 1.25 / c ** 0.25 : c + (t - c) ** 1.25 / (1 - c) ** 0.25; rowsY.push(yMin + (yMax - yMin) * w) }
  let cut = 0
  rowsY.forEach((y, i) => { if (Math.abs(y - MY) < Math.abs(rowsY[cut]! - MY)) cut = i })
  const seq: { base: number; jaw: 0 | 1 | undefined; split: boolean }[] = []
  rowsY.forEach((y, i) => { if (i === cut) { seq.push({ base: y, jaw: 1, split: true }, { base: y, jaw: 0, split: true }) } else seq.push({ base: y, jaw: i < cut ? 1 : 0, split: false }) })
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], jaw: (0 | 1)[] = [], ok: boolean[] = [], idx: number[] = []
  const e = 0.0012
  seq.forEach(({ base, jaw: j }) => {
    for (let c = 0; c <= cols; c++) {
      const x = xMin + (xMax - xMin) * (c / cols)
      const y = base + (lipY(x) - MY) * Math.exp(-(((base - MY) / 0.022) ** 2))
      const z = surfZ(x, y)
      const zz = (z ?? 0) + 0.0004, P = q(x, y, zz)
      const g = norm([headF(P[0] + e, P[1], P[2]) - headF(P[0] - e, P[1], P[2]), headF(P[0], P[1] + e, P[2]) - headF(P[0], P[1] - e, P[2]), headF(P[0], P[1], P[2] + e) - headF(P[0], P[1], P[2] - e)])
      ok.push(z !== null && z > 0.012 && g[2] > 0.34) // stops before the silhouette, where the head continues smoothly
      pos.push(...P); nor.push(...g); uv.push(faceU(x), faceV(y)); jaw.push(j as 0 | 1)
    }
  })
  const W = cols + 1
  for (let r = 0; r < seq.length - 1; r++) {
    if (seq[r]!.split && seq[r + 1]!.split) continue
    for (let c = 0; c < cols; c++) { const a = r * W + c, b = a + 1, d = a + W, f = d + 1; if (ok[a] && ok[b] && ok[d] && ok[f]) idx.push(a, b, d, b, f, d) }
  }
  return { s: { pos: new Float32Array(pos), nor: new Float32Array(nor), idx: new Uint32Array(idx), uv: new Float32Array(uv) } as Part, jaw }
}

// ---------- modelling helpers ----------
const uvSphere = (c: V, r: number, rows = 18, cols = 24): Part => {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = []
  for (let i = 0; i <= rows; i++) for (let k = 0; k <= cols; k++) {
    const a = (i / rows) * Math.PI, b = (k / cols) * Math.PI * 2, o: V = [Math.sin(a) * Math.sin(b), Math.cos(a), Math.sin(a) * Math.cos(b)]
    pos.push(...add(c, mul(o, r))); nor.push(...o); uv.push(0.5 + o[0] * 0.5, 0.5 - o[1] * 0.5)
    if (i < rows && k < cols) { const p = i * (cols + 1) + k, d = p + cols + 1; idx.push(p, d, p + 1, p + 1, d, d + 1) }
  }
  return { pos: new Float32Array(pos), nor: new Float32Array(nor), uv: new Float32Array(uv), idx: new Uint32Array(idx) }
}
const box = (c: V, s: V): Surface => {
  const pos: number[] = [], nor: number[] = [], idx: number[] = []
  const F2: [V, V, V][] = [[[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]], [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]], [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]]]
  for (const [n, u, v] of F2) {
    const b = pos.length / 3
    for (const [a, e] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) { const o: V = [n[0] + u[0] * a + v[0] * e, n[1] + u[1] * a + v[1] * e, n[2] + u[2] * a + v[2] * e]; pos.push(c[0] + (o[0] * s[0]) / 2, c[1] + (o[1] * s[1]) / 2, c[2] + (o[2] * s[2]) / 2); nor.push(...n) }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3)
  }
  return { pos: new Float32Array(pos), nor: new Float32Array(nor), idx: new Uint32Array(idx) }
}
const ring = (c: V, axis: V, r: number, n = 22): V[] => {
  const a = norm(axis), u = norm(cross(a, Math.abs(a[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0])), v = cross(a, u)
  return Array.from({ length: n }, (_, i) => { const t = (i / n) * Math.PI * 2; return add(c, add(mul(u, Math.cos(t) * r), mul(v, Math.sin(t) * r))) })
}
/** a clean quad surface over (row, column), with smooth normals */
function loft(rows: number, cols: number, at: (r: number, c: number) => V, uvAt: (r: number, c: number) => [number, number], wrap = true, flip = false): Part {
  const W = cols + 1, pos = new Float32Array((rows + 1) * W * 3), uv = new Float32Array((rows + 1) * W * 2), idx: number[] = []
  for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) { const p = at(r / rows, c / cols), i = r * W + c; pos.set(p, i * 3); uv.set(uvAt(r / rows, c / cols), i * 2) }
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const a = r * W + c, b = a + 1, d = a + W, e = d + 1; if (flip) idx.push(a, d, b, b, d, e); else idx.push(a, b, d, b, e, d) }
  const nor = new Float32Array(pos.length)
  const P = (i: number): V => [pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!]
  for (let t = 0; t < idx.length; t += 3) { const a = idx[t]!, b = idx[t + 1]!, c = idx[t + 2]!, n = cross(sub(P(b), P(a)), sub(P(c), P(a))); for (const v of [a, b, c]) { nor[v * 3] = nor[v * 3]! + n[0]; nor[v * 3 + 1] = nor[v * 3 + 1]! + n[1]; nor[v * 3 + 2] = nor[v * 3 + 2]! + n[2] } }
  if (wrap) for (let r = 0; r <= rows; r++) for (let k = 0; k < 3; k++) { const a = r * W * 3 + k, b = (r * W + cols) * 3 + k, m = nor[a]! + nor[b]!; nor[a] = m; nor[b] = m }
  for (let v = 0; v < nor.length; v += 3) { const n = norm([nor[v]!, nor[v + 1]!, nor[v + 2]!]); nor[v] = n[0]; nor[v + 1] = n[1]; nor[v + 2] = n[2] }
  return { pos, nor, uv, idx: new Uint32Array(idx) }
}
const tubeUv = (path: V[], r: (t: number) => number, sides: number, vScale = 1): Part => { const s = tube(path, r, sides), n = path.length, uv = new Float32Array(s.pos.length / 3 * 2); for (let i = 0; i < n; i++) for (let k = 0; k < sides; k++) { uv[(i * sides + k) * 2] = 0.1 + (0.8 * k) / sides; uv[(i * sides + k) * 2 + 1] = (i / (n - 1)) * vScale } return { ...s, uv } }
function joinParts(parts: Part[]): Part { const m = merge(parts); const uv = new Float32Array(m.pos.length / 3 * 2); let at = 0; for (const p of parts) { if (p.uv) uv.set(p.uv, at * 2); at += p.pos.length / 3 } return { ...m, uv } }
function combine(list: Prim[]): Prim[] {
  const out: Prim[] = []
  for (const material of new Set(list.map((p) => p.material))) {
    const parts = list.filter((p) => p.material === material), m = merge(parts.map((p) => ({ pos: p.pos, nor: p.nor, idx: p.idx }))), v = m.pos.length / 3, joined: Prim = { ...m, material }
    const fill = <T extends Uint8Array | Float32Array>(key: 'uv' | 'joints' | 'weights', size: number, make: (n: number) => T) => { if (!parts.some((p) => p[key])) return; const a = make(v * size); let at = 0; for (const p of parts) { if (p[key]) a.set(p[key] as ArrayLike<number>, at * size); at += p.pos.length / 3 } ;(joined as unknown as Record<string, T>)[key] = a }
    fill('uv', 2, (n) => new Float32Array(n)); fill('joints', 4, (n) => new Uint8Array(n)); fill('weights', 4, (n) => new Uint8Array(n))
    if (parts.some((p) => p.morphs)) joined.morphs = MORPHS.map((_, i) => { const d = new Float32Array(v * 3); let at = 0; for (const p of parts) { if (p.morphs) d.set(p.morphs[i]!, at * 3); at += p.pos.length / 3 } return d })
    out.push(joined)
  }
  return out
}
const bounds = (pts: V[], pad: number): [V, V] => { const a: [number, number, number] = [Infinity, Infinity, Infinity], b: [number, number, number] = [-Infinity, -Infinity, -Infinity]; for (const p of pts) for (let i = 0; i < 3; i++) { a[i] = Math.min(a[i]!, p[i]! - pad); b[i] = Math.max(b[i]!, p[i]! + pad) } return [a, b] }

// kurta silhouette from the reference: [height, half width, half depth]
const PROFILE = [[0.45, 0.186, 0.122], [0.7, 0.174, 0.12], [0.93, 0.15, 0.112], [1.06, 0.122, 0.092], [1.24, 0.142, 0.1], [1.305, 0.146, 0.096], [1.365, 0.122, 0.085], [1.408, 0.083, 0.066], [1.44, 0.046, 0.047]] as const
const profile = (y: number): [number, number] => { for (let i = 0; i < PROFILE.length - 1; i++) { const a = PROFILE[i]!, b = PROFILE[i + 1]!; if (y <= b[0]) { const t = smooth(a[0], b[0], y); return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t] } } const l = PROFILE.at(-1)!; return [l[1], l[2]] }
const kurtaFront = (x: number, y: number) => { const [a, b] = profile(y); return b * Math.sqrt(Math.max(0, 1 - (x / a) ** 2)) }

export function buildVidya() {
  const g = new Glb()
  const T = { face: g.texture(tex('face.png'), 'face'), kurta: g.texture(tex('kurta.jpg'), 'kurta', 'image/jpeg'), dupatta: g.texture(tex('dupatta.png'), 'dupatta'), hair: g.texture(tex('hair.png'), 'hair'), eye: g.texture(tex('eye.jpg'), 'eye', 'image/jpeg'), card: g.texture(tex('card.jpg'), 'card', 'image/jpeg') }
  const M = {
    face: g.material({ name: 'Face', texture: T.face, rough: 0.56, alphaCutoff: 0.5 }), skin: g.material({ name: 'Skin', color: lin(0xecba97), rough: 0.56 }),
    hair: g.material({ name: 'Hair', texture: T.hair, rough: 0.42, alphaCutoff: 0.32, doubleSided: true }), hairBase: g.material({ name: 'HairBase', color: lin(0x241713), rough: 0.62 }),
    kurta: g.material({ name: 'Kurta', texture: T.kurta, rough: 0.9 }), trim: g.material({ name: 'Trim', color: lin(0x75609f), rough: 0.78 }),
    trousers: g.material({ name: 'Trousers', color: lin(0x8a6aa9), rough: 0.88 }), dupatta: g.material({ name: 'Dupatta', texture: T.dupatta, rough: 0.8, doubleSided: true, alphaCutoff: 0.5 }),
    eye: g.material({ name: 'Eye', texture: T.eye, rough: 0.14 }), lash: g.material({ name: 'Lash', color: lin(0x1b1112), rough: 0.6 }),
    silver: g.material({ name: 'Silver', color: lin(0xc4b89f), metal: 0.8, rough: 0.36 }), teeth: g.material({ name: 'Teeth', color: lin(0xf6f0e8), rough: 0.32 }), mouth: g.material({ name: 'MouthInside', color: lin(0x4a1a22), rough: 0.72 }),
    shoe: g.material({ name: 'Shoes', color: lin(0x5a3526), rough: 0.42 }), cord: g.material({ name: 'Lanyard', color: lin(0x3f4f9e), rough: 0.6 }), card: g.material({ name: 'IdCard', texture: T.card, rough: 0.3 }),
    navy: g.material({ name: 'BookNavy', color: lin(0x25405f), rough: 0.55 }), brown: g.material({ name: 'BookBrown', color: lin(0x9a5a35), rough: 0.62 }), paper: g.material({ name: 'Paper', color: lin(0xf2ecdf), rough: 0.85 }),
  }
  const body: Prim[] = [], face: Prim[] = []
  const put = (to: Prim[], s: Part, material: number, w: { joints: Uint8Array; weights: Uint8Array }, extra: Partial<Prim> = {}) => to.push({ pos: s.pos, nor: s.nor, idx: s.idx, material, ...(s.uv ? { uv: s.uv } : {}), ...w, ...extra })

  // ---- head: an inner head (with a real mouth cavity) under the finely gridded painted face ----
  const neck = blend(0.026, limb([0, 1.5, -0.016], [0, 1.405, -0.02], 0.0325, 0.04), ellipsoid([0, 1.372, 0.008], [0.076, 0.05, 0.066]))
  const cavity = ellipsoid(q(0.001, MY - 0.004, 0.082), [0.029, 0.018, 0.036])
  const sockets = blend(0.004, sphere(EYE.L, EYE_R + 0.004), sphere(EYE.R, EYE_R + 0.004))
  const inner: F = (x, y, z) => smax(smax(smin(headF(x, y, z) + 0.0007, neck(x, y, z), 0.02), -cavity(x, y, z), 0.002), -sockets(x, y, z), 0.002)
  const hs = surfaceNets(inner, [-0.102, 1.335, -0.12], [0.102, 1.705, 0.125], 0.0072) as Part
  hs.uv = new Float32Array(hs.pos.length / 3 * 2)
  for (let v = 0; v < hs.pos.length / 3; v++) { hs.uv[v * 2] = clamp(faceU(hs.pos[v * 3]! - HEAD[0]), 0.01, 0.99); hs.uv[v * 2 + 1] = clamp(faceV(hs.pos[v * 3 + 1]! - HEAD[1]), 0.01, 0.99) }
  put(face, hs, M.face, headWeights(hs), { morphs: morphsOf(hs) })
  const fs = faceSurface()
  put(face, fs.s, M.face, rigid(fs.s, 'Head'), { morphs: morphsOf(fs.s, undefined, (v) => fs.jaw[v]) })
  const faceBit = (s: Part, m: number, custom?: Custom, jaw?: 0 | 1) => put(face, s, m, rigid(s, 'Head'), { morphs: morphsOf(s, custom, jaw === undefined ? undefined : () => jaw) })
  const bag = surfaceNets(ellipsoid(q(0.001, MY - 0.008, 0.063), [0.0265, 0.0215, 0.0185]), [-0.032, HEAD[1] + MY - 0.036, 0.036], [0.034, HEAD[1] + MY + 0.018, 0.09], 0.0034)
  faceBit(bag, M.mouth, STILL)
  const teethRow = (dy: number, half: number): V[] => Array.from({ length: 17 }, (_, i) => { const x = 0.001 - half + (i / 16) * 2 * half, y = lipY(x) + dy; return q(x, y, (surfZ(x, y) ?? 0.08) - 0.0055 - (x / half) ** 2 * 0.003) })
  faceBit(tube(teethRow(0.0002, 0.0178), () => 0.0031, 7), M.teeth, undefined, 0)
  faceBit(tube(teethRow(-0.0048, 0.0158), () => 0.0026, 7), M.teeth, undefined, 1)

  // ---- eyes and real eyelids ----
  for (const [c, name] of [[EYE.L, 'LeftEye'], [EYE.R, 'RightEye']] as const) {
    const eb = uvSphere(c, EYE_R, 16, 22)
    put(body, eb, M.eye, rigid(eb, name))
    const turn = (p: V, angle: number): V => { const o = sub(p, c), ca = Math.cos(angle), sa = Math.sin(angle); return add(c, [o[0], o[1] * ca - o[2] * sa, o[1] * sa + o[2] * ca]) }
    const R = EYE_R + 0.0009, SHUT = 0.92, lc = 24, lr = 8, lp: number[] = [], ln: number[] = [], li: number[] = []
    const rim = (k: number): V => { const ex = -0.0185 + (k / lc) * 0.037, ey = 0.0074 * Math.sqrt(Math.max(0, 1 - (ex / 0.0235) ** 2)) + 0.0006, zz = Math.sqrt(Math.max(1e-6, R * R - ex * ex - ey * ey)); return [c[0] + ex, c[1] + ey, c[2] + zz] }
    for (let r = 0; r <= lr; r++) for (let k = 0; k <= lc; k++) { const pt = turn(rim(k), -(r / lr) * 1.35); lp.push(...pt); ln.push(...norm(sub(pt, c))); if (r < lr && k < lc) { const n = r * (lc + 1) + k, d = n + lc + 1; li.push(n, d, n + 1, n + 1, d, d + 1) } }
    const lid: Part = { pos: new Float32Array(lp), nor: new Float32Array(ln), idx: new Uint32Array(li) }
    const swing = (a: number) => (p: V): V => sub(turn(p, a), p)
    faceBit(lid, M.skin, { ...STILL, blink: swing(SHUT), squint: swing(0.14) })
    const lash = tube(Array.from({ length: lc + 1 }, (_, k) => add(rim(k), mul(norm(sub(rim(k), c)), 0.0005))), (t) => 0.0004 + 0.0009 * Math.sin(t * Math.PI) ** 0.5, 5)
    faceBit(lash, M.lash, { ...STILL, blink: swing(SHUT), squint: swing(0.14) })
  }

  // ---- hair: strand cards in layers over a small dark base ----
  const faceHole = blend(0.014, ellipsoid(q(-0.003, -0.016, 0.108), [0.0705, 0.106, 0.094]), limb(q(0, -0.07, 0.1), [0, 1.3, 0.2], 0.08, 0.14))
  const hairBase = blend(0.03, ellipsoid(q(0, 0.034, -0.016), [0.0815, 0.0925, 0.098]), limb(q(0, 0.015, -0.07), [0, 1.36, -0.092], 0.07, 0.05))
  const baseS = surfaceNets((x, y, z) => smax(hairBase(x, y, z), -faceHole(x, y, z), 0.008), [-0.11, 1.3, -0.17], [0.11, 1.705, 0.1], 0.012)
  put(body, baseS, M.hairBase, skin(baseS, ['Head', 'Neck', 'Chest'], 5))
  const shell = (s: number, lon: number, lat: number, out: number): V => add(q(0, 0.034, -0.016), [s * Math.sin(lat) * Math.sin(lon) * (0.0825 + out), Math.cos(lat) * (0.0935 + out), Math.sin(lat) * Math.cos(lon) * (0.099 + out)])
  const cards: Part[] = []
  const card = (pts: V[], width: (t: number) => number) => {
    const n = pts.length, across = 3
    cards.push(loft(n - 1, across, (r, c) => {
      const i = Math.round(r * (n - 1)), p = pts[i]!, tan = norm(sub(pts[Math.min(n - 1, i + 1)]!, pts[Math.max(0, i - 1)]!)), out = norm(sub(p, q(0, 0.02, -0.02))), side = norm(cross(tan, out)), u = c - 0.5
      return add(add(p, mul(side, u * width(r))), mul(out, (0.25 - u * u) * width(r) * 0.42))
    }, (r, c) => [c * 0.42 + (pts[0]![0] * 7 + pts[0]![2] * 5) % 1, r * 0.98], false))
  }
  const lock = (s: number, a: number, seed: number, endY: number, out: number, wide: number) => {
    const startLon = 0.2 + a * 2.6, endLon = 1.46 + a * 1.55, n = 20, pts: V[] = [], wob = Math.sin(seed * 12.9898) * 0.5 + 0.5
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1)
      if (t < 0.44) { const k = t / 0.44; pts.push(shell(s, startLon + (endLon - startLon) * k * k, 0.05 + 1.84 * k, out + 0.002 * Math.sin(k * Math.PI))) }
      else {
        const k = (t - 0.44) / 0.56, top = shell(s, endLon, 1.89, out)
        pts.push([top[0] + s * 0.016 * k + Math.sin(k * 8 + wob * 6) * 0.019 * smooth(0.04, 0.45, k), top[1] + (endY - top[1]) * k, top[2] - 0.012 * k + Math.cos(k * 6 + wob * 4) * 0.014 * smooth(0.05, 0.5, k)])
      }
    }
    card(pts, (t) => wide * Math.min(1, 0.5 + t * 3) * (1 - smooth(0.74, 1, t) * 0.7))
  }
  for (const [layer, out, wide] of [[0, 0.002, 0.034], [1, 0.0065, 0.027], [2, 0.0105, 0.02]] as const) {
    const N = 24 - layer * 3
    for (let i = 0; i < N; i++) { const a = (i + layer * 0.33) / (N - 1 + layer * 0.5); lock(1, Math.min(1, a), i + layer * 31 + 1, 1.285 - 0.08 * Math.sin(a * 3.1) + 0.03 * Math.sin(i * 2.7), out, wide); lock(-1, Math.min(1, a), i + layer * 47 + 60, a < 0.28 ? 1.44 : 1.32 - 0.05 * Math.sin(a * 3.1) + 0.02 * Math.sin(i * 1.9), out, wide) }
  }
  for (const [sg, x0] of [[1, 0.069], [-1, -0.073]] as const) { // soft face-framing waves
    card(Array.from({ length: 16 }, (_, i): V => { const t = i / 15; return q(x0 + sg * 0.004 + sg * Math.sin(t * 6.4) * 0.0055, 0.062 - t * 0.135, 0.03 - t * 0.01 + Math.cos(t * 5) * 0.003) }), (t) => 0.012 * (1 - t * 0.6))
  }
  // braid: fat crossing lobes, as in the reference
  const lobes: Part[] = []
  const count = 19
  for (let i = 0; i < count; i++) {
    const t0 = i / count, t1 = (i + 1.65) / count, sgn = i % 2 ? 1 : -1, shrink = 1 - 0.52 * t0 ** 1.8
    const pts: V[] = Array.from({ length: 11 }, (_, k) => { const u = k / 10, c = catmull(BRAID, clamp(t0 + (t1 - t0) * u)), d = norm(sub(catmull(BRAID, clamp(t0 + (t1 - t0) * u + 0.01)), catmull(BRAID, clamp(t0 + (t1 - t0) * u - 0.01)))), side = norm(cross(d, [0, 0, 1])), up = cross(side, d), offset = Math.cos(u * Math.PI) * sgn; return add(add(c, mul(side, offset * 0.0128 * shrink)), mul(up, Math.sin(u * Math.PI) * 0.0058 * shrink)) })
    lobes.push(tubeUv(pts, (u) => (0.0052 + 0.0088 * Math.sin(u * Math.PI) ** 0.75) * shrink, 8))
  }
  for (const [dx, l] of [[0.006, 0.062], [-0.009, 0.05], [0.001, 0.055]] as const) lobes.push(tubeUv(Array.from({ length: 8 }, (_, i): V => { const t = i / 7; return add(BRAID[6]!, [dx * t + Math.sin(t * 3) * 0.003, -l * t, 0.002]) }), (t) => 0.0075 * (1 - t * 0.88), 6))
  const hairCards = joinParts(cards), braidS = joinParts(lobes)
  put(body, hairCards, M.hair, skin(hairCards, ['Head', 'Neck', 'Chest'], 5))
  put(body, braidS, M.hair, skin(braidS, ['Head', 'Braid1', 'Braid2', 'Braid3', 'Braid4', 'Braid5'], 5))

  // ---- kurta: one clean body panel with a real V neckline and hem ----
  const edgeY = (th: number) => 1.438 - 0.062 * Math.exp(-((th / 0.34) ** 2))
  const kurtaAt = (r: number, c: number): V => {
    const th = (c - 0.5) * Math.PI * 2, top = edgeY(th), y = 0.45 + (top - 0.45) * r
    const [a, b] = profile(y)
    const pleat = 0.0065 * Math.sin(th * 6.3 + 1.2) * smooth(1.04, 0.52, y) + 0.0028 * Math.sin(th * 17 + 0.4) * smooth(0.9, 0.46, y) + 0.0012 * Math.sin(th * 9 + y * 22) * smooth(1.32, 1.08, y) * smooth(0.98, 1.12, y)
    return [(a + pleat) * Math.sin(th), y, (b + pleat) * Math.cos(th)]
  }
  const kurta = loft(62, 76, kurtaAt, (r, c) => { const th = (c - 0.5) * Math.PI * 2, y = 0.45 + (edgeY(th) - 0.45) * r; return [(th * 0.142) / 0.395 + 0.5, 1 - (y - 0.45 + 0.7 * Math.max(0, 0.154 - profile(y)[0])) / 1.07] }, true)
  const kw = skin(kurta, ['Hips', 'Spine', 'Spine1', 'Chest'], 3)
  put(body, kurta, M.kurta, kw)
  const neckTrim = tube(Array.from({ length: 56 }, (_, i): V => { const th = (i / 55 - 0.5) * Math.PI * 2; const [a, b] = profile(edgeY(th)); return [(a + 0.0015) * Math.sin(th), edgeY(th), (b + 0.0015) * Math.cos(th)] }), () => 0.0021, 6, false)
  put(body, neckTrim, M.trim, rigid(neckTrim, 'Chest'))
  const hem = tube(Array.from({ length: 76 }, (_, i): V => { const c = i / 76; const p = kurtaAt(0, c); return [p[0] * 1.004, 0.452, p[2] * 1.004] }), () => 0.0028, 6, true)
  put(body, hem, M.trim, rigid(hem, 'Hips'))
  for (const side of ['Left', 'Right'] as const) {
    const sg = side === 'Left' ? 1 : -1, A = B(`${side}Arm`).pos, E = B(`${side}ForeArm`).pos, W = B(`${side}Hand`).pos, end = mix(E, W, 0.5), start: V = [sg * 0.085, 1.362, -0.004]
    const axis = (t: number): V => t < 0.14 ? add(mix(start, A, smooth(0, 1, t / 0.14)), [0, -0.012 * (t / 0.14), 0]) : t < 0.4 ? add(mix(A, E, (t - 0.14) / 0.52), [0, -0.012 * (1 - (t - 0.14) / 0.26), 0]) : t < 0.66 ? mix(A, E, (t - 0.14) / 0.52) : mix(E, end, (t - 0.66) / 0.34)
    const rad = (t: number) => t < 0.14 ? 0.036 + 0.01 * (t / 0.14) : t < 0.66 ? 0.046 - 0.005 * ((t - 0.14) / 0.52) : 0.041 + 0.0045 * ((t - 0.66) / 0.34)
    const sleeve = loft(30, 22, (r, c) => {
      const p = axis(r), d = norm(sub(axis(Math.min(1, r + 0.02)), axis(Math.max(0, r - 0.02)))), u = norm(cross(d, [0, 0, 1])), v = cross(u, d), a = c * Math.PI * 2 * sg, fold = 0.0016 * Math.sin(r * 26 + c * 5) * smooth(0.3, 0.75, r)
      return add(p, add(mul(u, Math.cos(a) * (rad(r) + fold)), mul(v, Math.sin(a) * (rad(r) + fold))))
    }, (r, c) => [c * 0.46, 0.5 + r * 0.495], true, sg < 0)
    put(body, sleeve, M.kurta, skin(sleeve, [`${side}Shoulder`, `${side}Arm`, `${side}ForeArm`], 7))
    for (const o of [0, -0.016]) { const t = tube(ring(add(end, mul(norm(sub(W, E)), o)), sub(W, E), rad(1) + 0.0008), () => 0.0024, 6, true); put(body, t, M.trim, rigid(t, `${side}ForeArm`)) }
    // forearm and hand
    const hf = HAND[side]!, { d, t: tn, n, wrist } = hf.frame, at = (a: number, b: number, c: number): V => add(add(add(wrist, mul(d, a)), mul(tn, b)), mul(n, c))
    const palm = blend(0.015, limb(at(0.012, 0.011, 0), at(0.076, 0.02, 0.001), 0.0178, 0.0126), limb(at(0.012, -0.011, 0), at(0.076, -0.0205, 0.001), 0.0168, 0.0108), limb(at(0.04, 0, 0), at(0.08, 0, 0.001), 0.0165, 0.014), limb(at(0.018, 0.022, 0.01), at(0.054, 0.04, 0.016), 0.0125, 0.0098))
    const digits = hf.fingers.map((x) => blend(0.003, ...x.pts.slice(0, 3).map((p, i) => limb(p, x.pts[i + 1]!, x.r * (1 - i * 0.09), x.r * (0.92 - i * 0.12)))))
    const forearm = limb(mix(E, W, 0.34), add(W, mul(norm(sub(W, E)), 0.012)), 0.0335, 0.0222)
    const handF: F = (x, y, z) => { let m = smin(forearm(x, y, z), palm(x, y, z), 0.012); for (const f of digits) m = smin(m, f(x, y, z), 0.0036); return m }
    const [mn, mx] = bounds([mix(E, W, 0.34), ...hf.fingers.flatMap((f) => f.pts)], 0.045)
    const hs2 = surfaceNets(handF, mn, mx, 0.0041)
    put(body, hs2, M.skin, skin(hs2, [`${side}ForeArm`, `${side}Hand`, ...hf.fingers.flatMap((f) => [1, 2, 3].map((i) => `${side}Hand${f.name}${i}`))], 8))
    const bandAxis = sub(W, E), band = tube(ring(add(W, mul(norm(bandAxis), -0.012)), bandAxis, side === 'Left' ? 0.0252 : 0.0262), () => (side === 'Left' ? 0.0042 : 0.002), 6, true)
    put(body, band, M.silver, rigid(band, `${side}ForeArm`))
    // trousers, gathered at the ankle
    const H = B(`${side}UpLeg`).pos, Kn = B(`${side}Leg`).pos, F0 = B(`${side}Foot`).pos
    const legAxis = (t: number): V => t < 0.5 ? mix(H, Kn, t / 0.5) : mix(Kn, F0, (t - 0.5) / 0.5)
    const legR = (t: number) => t < 0.5 ? 0.074 - 0.004 * (t / 0.5) : 0.07 - 0.03 * smooth(0.62, 0.97, t)
    const leg = loft(36, 20, (r, c) => { const p = legAxis(0.14 + r * 0.845), a = c * Math.PI * 2, fold = (0.0042 * Math.sin(r * 42 + a * 2) * smooth(0.6, 0.94, r)) + 0.003 * Math.sin(a * 5 + r * 7) * smooth(0.2, 0.7, r); return [p[0] + Math.sin(a) * (legR(r) + fold), p[1], p[2] + Math.cos(a) * (legR(r) * 0.94 + fold)] }, (r, c) => [c * 2, r * 5], true, true)
    put(body, leg, M.trousers, skin(leg, ['Hips', `${side}UpLeg`, `${side}Leg`, `${side}Foot`], 5))
    const t0 = B(`${side}Foot`).end!
    const shoeRaw = blend(0.028, ellipsoid([F0[0], 0.05, F0[2] - 0.012], [0.04, 0.05, 0.056]), ellipsoid([t0[0], 0.032, t0[2] - 0.012], [0.041, 0.03, 0.074]))
    const opening = limb([F0[0], 0.14, F0[2]], [F0[0], 0.058, F0[2] + 0.018], 0.033, 0.03)
    const shoe: F = (x, y, z) => smax(smax(shoeRaw(x, y, z), -y, 0.004), -opening(x, y, z), 0.005)
    const ss = surfaceNets(shoe, [F0[0] - 0.07, -0.008, F0[2] - 0.09], [F0[0] + 0.08, 0.125, t0[2] + 0.09], 0.0115)
    put(body, ss, M.shoe, skin(ss, [`${side}Foot`, `${side}Leg`], 5))
    const ank = surfaceNets(limb([F0[0], 0.105, F0[2]], [F0[0], 0.05, F0[2] + 0.012], 0.0335, 0.03), [F0[0] - 0.05, 0.03, F0[2] - 0.05], [F0[0] + 0.05, 0.14, F0[2] + 0.06], 0.011)
    put(body, ank, M.skin, rigid(ank, `${side}Foot`))
  }

  // ---- dupatta: the real printed cloth, over her left shoulder in soft folds ----
  const dRows = 62, dCols = 30
  const dAt = (s: number, u: number): V => {
    if (s < 0.07) { const a = (s / 0.07) * Math.PI * 0.72, x = 0.1 + (u - 0.5) * 0.11; return [x, 1.33 + Math.sin(a) * 0.102, 0.012 + -Math.cos(a) * 0.085] }
    const k = (s - 0.07) / 0.93, y = 1.402 - k * 1.11, gather = 0.56 + 0.44 * smooth(0, 0.3, k), x = 0.142 + (u - 0.5) * 0.215 * gather + k * 0.02
    const surf = 0.118 + 0.05 * smooth(1.02, 0.45, y)
    const fold = smooth(0, 0.5, k) * (0.014 * Math.sin(u * 11.5 + k * 2.8) + 0.006 * Math.sin(u * 27 - k * 4)) + 0.0028 * Math.sin(u * 15)
    const lead = smooth(0, 0.08, k)
    return [x + 0.01 * Math.sin(k * 4 + u * 3) * smooth(0.1, 0.8, k), y, 0.062 * (1 - lead) + (surf + 0.018 + fold) * lead]
  }
  const dup = loft(dRows, dCols, dAt, (r, c) => [0.006 + c * 0.985, 0.004 + r * 0.992], false)
  const dJ = new Uint8Array(dup.pos.length / 3 * 4), dW = new Uint8Array(dup.pos.length / 3 * 4), chain = ['Chest', 'Dupatta1', 'Dupatta2', 'Dupatta3', 'Dupatta4'].map((n) => bones.findIndex((b) => b.name === n))
  for (let v = 0; v < dup.pos.length / 3; v++) { const r = Math.floor(v / (dCols + 1)) / dRows, f = clamp((r - 0.07) / 0.93) * 4, i = Math.min(3, Math.floor(f)), t = f - i; dJ[v * 4] = chain[i]!; dJ[v * 4 + 1] = chain[i + 1]!; dW[v * 4] = 255 - Math.round(t * 255); dW[v * 4 + 1] = Math.round(t * 255) }
  put(body, dup, M.dupatta, { joints: dJ, weights: dW })

  // ---- jewellery, lanyard, ID card ----
  for (const sg of [1, -1]) {
    const e = q(sg * 0.082, -0.03, -0.004)
    const hook = uvSphere(e, 0.0036, 6, 8), dome = surfaceNets(blend(0.002, ellipsoid(add(e, [0, -0.0145, 0]), [0.0098, 0.0085, 0.0098]), limb(add(e, [0, -0.003, 0]), add(e, [0, -0.012, 0]), 0.002, 0.0038)), add(e, [-0.014, -0.027, -0.014]), add(e, [0.014, 0.004, 0.014]), 0.0024)
    put(body, hook, M.silver, rigid(hook, 'Head')); put(body, dome, M.silver, rigid(dome, 'Head'))
    for (let i = 0; i < 9; i++) { const a = (i / 9) * Math.PI * 2, b = uvSphere(add(e, [Math.cos(a) * 0.009, -0.0245, Math.sin(a) * 0.009]), 0.0015, 3, 4); put(body, b, M.silver, rigid(b, 'Head')) }
  }
  const clip: V = [0.012, 1.12, kurtaFront(0.012, 1.12) + 0.006]
  for (const sg of [1, -1]) {
    const c = tube(Array.from({ length: 18 }, (_, i): V => { const t = i / 17, x = sg * 0.045 * (1 - t) + clip[0] * t, y = 1.435 + (clip[1] - 1.435) * t; return [x, y, Math.max(kurtaFront(x, y), 0.04) + 0.004] }), () => 0.0028, 5)
    put(body, c, M.cord, rigid(c, 'Chest'))
  }
  const cardS = box(add(clip, [0, -0.046, 0.0012]), [0.05, 0.08, 0.002]) as Part
  cardS.uv = new Float32Array(cardS.pos.length / 3 * 2)
  for (let v = 0; v < cardS.pos.length / 3; v++) { cardS.uv[v * 2] = (cardS.pos[v * 3]! - clip[0]) / 0.05 + 0.5; cardS.uv[v * 2 + 1] = 0.5 - (cardS.pos[v * 3 + 1]! - clip[1] + 0.046) / 0.08 }
  put(body, cardS, M.card, rigid(cardS, 'Chest'))

  // ---------- nodes ----------
  const jointNodes = new Map<string, number>()
  for (const b of bones) { const p = b.parent ? B(b.parent).pos : [0, 0, 0] as V; jointNodes.set(b.name, g.node({ name: b.name, translation: [b.pos[0] - p[0], b.pos[1] - p[1], b.pos[2] - p[2]] })) }
  const nodes = g.json.nodes as { children?: number[] }[]
  for (const b of bones) if (b.parent) (nodes[jointNodes.get(b.parent)!]!.children ??= []).push(jointNodes.get(b.name)!)
  const ibm = new Float32Array(bones.length * 16)
  bones.forEach((b, i) => { ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -b.pos[0], -b.pos[1], -b.pos[2], 1], i * 16) })
  const skinIdx = g.json.skins.push({ name: 'VidyaSkin', joints: bones.map((b) => jointNodes.get(b.name)!), skeleton: jointNodes.get('Hips'), inverseBindMatrices: g.accessor(ibm, 'MAT4') }) - 1
  const bodyPrims = combine(body), facePrims = combine(face)
  const bodyNode = g.node({ name: 'VidyaBody', mesh: g.mesh('VidyaBody', bodyPrims), skin: skinIdx })
  const faceNode = g.node({ name: 'VidyaFace', mesh: g.mesh('VidyaFace', facePrims, [...MORPHS]), skin: skinIdx })
  const navy = box([0.006, 0.004, -0.012], [0.165, 0.215, 0.03]), navyPages = box([0.0125, 0.004, -0.012], [0.155, 0.205, 0.022]), brown = box([0.006, -0.012, 0.012], [0.135, 0.178, 0.02]), brownPages = box([0.012, -0.012, 0.012], [0.127, 0.17, 0.0135])
  const spiral = merge(Array.from({ length: 13 }, (_, i) => tube(ring([-0.06, -0.09 + i * 0.015, 0.012], [0, 1, 0], 0.0088, 10), () => 0.0009, 4, true)))
  const prim = (s: Surface, material: number): Prim => ({ pos: s.pos, nor: s.nor, idx: s.idx, material })
  const booksNode = g.node({ name: 'Books', mesh: g.mesh('Books', [prim(navy, M.navy), prim(navyPages, M.paper), prim(brown, M.brown), prim(brownPages, M.paper), prim(spiral, M.silver)]) })
  ;(nodes[jointNodes.get('RightHand')!]!.children ??= []).push(booksNode)
  const root = g.node({ name: 'Vidya', children: [jointNodes.get('Hips')!, bodyNode, faceNode] })
  const glb = g.toBuffer([root])
  const tris = (list: Prim[]) => list.reduce((n, p) => n + p.idx.length / 3, 0)
  const byMat = Object.fromEntries([...bodyPrims, ...facePrims].map((x) => [(g.json.materials[x.material] as { name: string }).name, x.idx.length / 3]))
  return { glb, byMat, stats: { triangles: tris(bodyPrims) + tris(facePrims) + [navy, navyPages, brown, brownPages, spiral].reduce((n, s) => n + s.idx.length / 3, 0), faceTriangles: tris(facePrims), bones: bones.length, primitives: bodyPrims.length + facePrims.length + 5, materials: g.json.materials.length, morphs: MORPHS.length, bytes: glb.length } }
}

if (process.argv[1]?.endsWith('build.ts')) {
  const t0 = performance.now()
  const { glb, stats, byMat } = buildVidya()
  const out = join(HERE, '../../public/vidya/vidya.glb')
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, glb)
  process.stdout.write(`${JSON.stringify(byMat)}\n${JSON.stringify({ ...stats, seconds: Math.round((performance.now() - t0) / 1000) })}\n`)
}
