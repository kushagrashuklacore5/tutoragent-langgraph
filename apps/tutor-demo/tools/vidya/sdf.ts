/** Small sculpting kit: signed distance shapes, smooth blends and a surface-nets mesher. No dependencies. */
export type V = readonly [number, number, number]
export type F = (x: number, y: number, z: number) => number
export interface Surface { pos: Float32Array; nor: Float32Array; idx: Uint32Array }

export const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const mul = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s]
export const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const len = (a: V) => Math.sqrt(dot(a, a))
export const norm = (a: V): V => mul(a, 1 / (len(a) || 1))
export const mix = (a: V, b: V, t: number): V => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
export const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x))
export const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t) }

export const smin = (a: number, b: number, k: number) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25 }
export const smax = (a: number, b: number, k: number) => -smin(-a, -b, k)
export const blend = (k: number, ...fs: F[]): F => (x, y, z) => { let d = fs[0]!(x, y, z); for (let i = 1; i < fs.length; i++) d = smin(d, fs[i]!(x, y, z), k); return d }
export const carve = (base: F, cut: F, k: number): F => (x, y, z) => smax(base(x, y, z), -cut(x, y, z), k)

export const sphere = (c: V, r: number): F => (x, y, z) => Math.hypot(x - c[0], y - c[1], z - c[2]) - r
export const ellipsoid = (c: V, r: V): F => (x, y, z) => {
  const px = x - c[0], py = y - c[1], pz = z - c[2]
  const k0 = Math.hypot(px / r[0], py / r[1], pz / r[2])
  const k1 = Math.hypot(px / (r[0] * r[0]), py / (r[1] * r[1]), pz / (r[2] * r[2]))
  return k1 < 1e-9 ? -Math.min(r[0], r[1], r[2]) : (k0 * (k0 - 1)) / k1
}
/** a capsule whose radius changes along its length */
export const limb = (a: V, b: V, ra: number, rb: number): F => {
  const ba = sub(b, a), bb = dot(ba, ba) || 1e-9
  return (x, y, z) => {
    const px = x - a[0], py = y - a[1], pz = z - a[2]
    const t = clamp((px * ba[0] + py * ba[1] + pz * ba[2]) / bb)
    return Math.hypot(px - ba[0] * t, py - ba[1] * t, pz - ba[2] * t) - (ra + (rb - ra) * t)
  }
}
export const segmentDistance = (p: V, a: V, b: V) => {
  const ba = sub(b, a), t = clamp(dot(sub(p, a), ba) / (dot(ba, ba) || 1e-9))
  return len(sub(p, add(a, mul(ba, t))))
}

/** Naive surface nets: a smooth closed mesh of the zero level, projected back onto the surface, with analytic-style normals. */
export function surfaceNets(f: F, min: V, max: V, h: number): Surface {
  const nx = Math.ceil((max[0] - min[0]) / h) + 1, ny = Math.ceil((max[1] - min[1]) / h) + 1, nz = Math.ceil((max[2] - min[2]) / h) + 1
  const at = (i: number, j: number, k: number) => i + nx * (j + ny * k)
  const val = new Float32Array(nx * ny * nz)
  for (let k = 0, n = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) val[n++] = f(min[0] + i * h, min[1] + j * h, min[2] + k * h)
  const id = new Int32Array(nx * ny * nz).fill(-1)
  const out: number[] = []
  const C = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]] as const
  const E = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]] as const
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const v = C.map((c) => val[at(i + c[0], j + c[1], k + c[2])]!)
    let mask = 0
    v.forEach((x, n) => { if (x < 0) mask |= 1 << n })
    if (mask === 0 || mask === 255) continue
    let sx = 0, sy = 0, sz = 0, cnt = 0
    for (const [a, b] of E) {
      if ((v[a]! < 0) === (v[b]! < 0)) continue
      const t = v[a]! / (v[a]! - v[b]!)
      sx += C[a]![0] + (C[b]![0] - C[a]![0]) * t; sy += C[a]![1] + (C[b]![1] - C[a]![1]) * t; sz += C[a]![2] + (C[b]![2] - C[a]![2]) * t; cnt++
    }
    id[at(i, j, k)] = out.length / 3
    out.push(min[0] + (i + sx / cnt) * h, min[1] + (j + sy / cnt) * h, min[2] + (k + sz / cnt) * h)
  }
  const tri: number[] = []
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return
    if (flip) tri.push(a, c, b, a, d, c); else tri.push(a, b, c, a, c, d)
  }
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const v0 = val[at(i, j, k)]!
    const in0 = v0 < 0
    if (in0 !== (val[at(i + 1, j, k)]! < 0)) quad(id[at(i, j - 1, k - 1)]!, id[at(i, j, k - 1)]!, id[at(i, j, k)]!, id[at(i, j - 1, k)]!, !in0)
    if (in0 !== (val[at(i, j + 1, k)]! < 0)) quad(id[at(i - 1, j, k - 1)]!, id[at(i - 1, j, k)]!, id[at(i, j, k)]!, id[at(i, j, k - 1)]!, !in0)
    if (in0 !== (val[at(i, j, k + 1)]! < 0)) quad(id[at(i - 1, j - 1, k)]!, id[at(i, j - 1, k)]!, id[at(i, j, k)]!, id[at(i - 1, j, k)]!, !in0)
  }
  const pos = new Float32Array(out), nor = new Float32Array(out.length)
  const e = h * 0.5
  const grad = (x: number, y: number, z: number): V => norm([f(x + e, y, z) - f(x - e, y, z), f(x, y + e, z) - f(x, y - e, z), f(x, y, z + e) - f(x, y, z - e)])
  for (let n = 0; n < pos.length; n += 3) {
    let x = pos[n]!, y = pos[n + 1]!, z = pos[n + 2]!
    for (let s = 0; s < 2; s++) { const g = grad(x, y, z), d = clamp(f(x, y, z), -h, h); x -= g[0] * d; y -= g[1] * d; z -= g[2] * d }
    const g = grad(x, y, z)
    pos[n] = x; pos[n + 1] = y; pos[n + 2] = z; nor[n] = g[0]; nor[n + 1] = g[1]; nor[n + 2] = g[2]
  }
  return { pos, nor, idx: new Uint32Array(tri) }
}

/** A tube along a path with a radius at each point (lips, brows, jewellery, cords). */
export function tube(path: V[], radius: (t: number) => number, sides = 8, closed = false): Surface {
  const n = path.length, pos: number[] = [], nor: number[] = [], idx: number[] = []
  let up: V = [0, 0, 1]
  for (let i = 0; i < n; i++) {
    const a = path[closed ? (i - 1 + n) % n : Math.max(0, i - 1)]!, b = path[closed ? (i + 1) % n : Math.min(n - 1, i + 1)]!
    const d = norm(sub(b, a))
    if (Math.abs(dot(up, d)) > 0.95) up = [1, 0, 0]
    const s = norm(cross(d, up)), u = cross(s, d)
    up = u
    const r = radius(closed ? i / n : i / (n - 1))
    for (let k = 0; k < sides; k++) {
      const q = (k / sides) * Math.PI * 2, o = add(mul(s, Math.cos(q)), mul(u, Math.sin(q)))
      pos.push(...add(path[i]!, mul(o, r))); nor.push(...o)
    }
  }
  const rings = closed ? n : n - 1
  for (let i = 0; i < rings; i++) for (let k = 0; k < sides; k++) {
    const a = i * sides + k, b = i * sides + ((k + 1) % sides), c = ((i + 1) % n) * sides + k, d = ((i + 1) % n) * sides + ((k + 1) % sides)
    idx.push(a, c, b, b, c, d)
  }
  return { pos: new Float32Array(pos), nor: new Float32Array(nor), idx: new Uint32Array(idx) }
}

/** Joins surfaces into one. */
export function merge(parts: Surface[]): Surface {
  const vc = parts.reduce((n, p) => n + p.pos.length, 0), ic = parts.reduce((n, p) => n + p.idx.length, 0)
  const pos = new Float32Array(vc), nor = new Float32Array(vc), idx = new Uint32Array(ic)
  let v = 0, i = 0
  for (const p of parts) {
    pos.set(p.pos, v); nor.set(p.nor, v)
    for (let n = 0; n < p.idx.length; n++) idx[i + n] = p.idx[n]! + v / 3
    v += p.pos.length; i += p.idx.length
  }
  return { pos, nor, idx }
}
