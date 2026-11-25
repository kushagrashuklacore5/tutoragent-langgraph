/** Minimal glTF 2.0 binary writer (meshes, skin, sparse morph targets, PBR materials, PNG textures) and PNG encoder. */
import { deflateSync } from 'node:zlib'

const FLOAT = 5126, U8 = 5121, U16 = 5123, U32 = 5125
const COUNT: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }
type Typed = Float32Array | Uint8Array | Uint16Array | Uint32Array
const componentOf = (d: Typed) => (d instanceof Float32Array ? FLOAT : d instanceof Uint8Array ? U8 : d instanceof Uint16Array ? U16 : U32)

export interface Prim {
  pos: Float32Array; nor: Float32Array; idx: Uint32Array; material: number
  uv?: Float32Array; color?: Uint8Array; joints?: Uint8Array; weights?: Uint8Array
  /** one per morph name, full-length position deltas (zeros are stored sparsely) */
  morphs?: Float32Array[]
}
export interface MaterialDef { alphaCutoff?: number; name: string; color?: readonly [number, number, number, number?]; metal?: number; rough?: number; texture?: number; doubleSided?: boolean; emissive?: readonly [number, number, number] }

export class Glb {
  private chunks: Buffer[] = []
  private size = 0
  readonly json = { nodes: [] as unknown[], meshes: [] as unknown[], accessors: [] as unknown[], bufferViews: [] as unknown[], materials: [] as unknown[], skins: [] as unknown[], textures: [] as unknown[], images: [] as unknown[], samplers: [] as unknown[] }

  private view(data: Typed | Buffer, target?: number) {
    const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    const pad = (4 - (this.size % 4)) % 4
    if (pad) { this.chunks.push(Buffer.alloc(pad)); this.size += pad }
    const v: Record<string, number> = { buffer: 0, byteOffset: this.size, byteLength: b.length }
    if (target) v.target = target
    this.chunks.push(Buffer.from(b)); this.size += b.length
    return this.json.bufferViews.push(v) - 1
  }
  accessor(data: Typed, type: string, target?: number, normalized = false, bounds = false) {
    const count = data.length / COUNT[type]!
    const a: Record<string, unknown> = { bufferView: this.view(data, target), componentType: componentOf(data), count, type }
    if (normalized) a.normalized = true
    if (bounds) {
      const n = COUNT[type]!, min = new Array(n).fill(Infinity), max = new Array(n).fill(-Infinity)
      for (let i = 0; i < data.length; i++) { const c = i % n; min[c] = Math.min(min[c], data[i]!); max[c] = Math.max(max[c], data[i]!) }
      a.min = min; a.max = max
    }
    return this.json.accessors.push(a) - 1
  }
  /** a morph target that stores only the vertices it moves */
  private sparseVec3(d: Float32Array) {
    const count = d.length / 3, moved: number[] = []
    for (let i = 0; i < count; i++) if (Math.abs(d[i * 3]!) + Math.abs(d[i * 3 + 1]!) + Math.abs(d[i * 3 + 2]!) > 2e-5) moved.push(i)
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
    const values = new Float32Array(Math.max(1, moved.length) * 3)
    const list = moved.length ? moved : [0]
    list.forEach((v, n) => { for (let c = 0; c < 3; c++) { const x = moved.length ? d[v * 3 + c]! : 0; values[n * 3 + c] = x; min[c] = Math.min(min[c]!, x); max[c] = Math.max(max[c]!, x) } })
    const indices = count < 65536 ? new Uint16Array(list) : new Uint32Array(list)
    return this.json.accessors.push({
      componentType: FLOAT, count, type: 'VEC3', min, max,
      sparse: { count: list.length, indices: { bufferView: this.view(indices), componentType: componentOf(indices) }, values: { bufferView: this.view(values) } },
    }) - 1
  }
  material(m: MaterialDef) {
    const pbr: Record<string, unknown> = { baseColorFactor: [...(m.color ?? [1, 1, 1]).slice(0, 3), m.color?.[3] ?? 1], metallicFactor: m.metal ?? 0, roughnessFactor: m.rough ?? 0.7 }
    if (m.texture !== undefined) pbr.baseColorTexture = { index: m.texture }
    const out: Record<string, unknown> = { name: m.name, pbrMetallicRoughness: pbr }
    if (m.doubleSided) out.doubleSided = true
    if (m.alphaCutoff !== undefined) { out.alphaMode = 'MASK'; out.alphaCutoff = m.alphaCutoff }
    if (m.emissive) out.emissiveFactor = m.emissive
    return this.json.materials.push(out) - 1
  }
  texture(data: Buffer, name: string, mimeType = 'image/png') {
    if (!this.json.samplers.length) this.json.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 })
    const image = this.json.images.push({ name, mimeType, bufferView: this.view(data) }) - 1
    return this.json.textures.push({ source: image, sampler: 0 }) - 1
  }
  mesh(name: string, prims: Prim[], morphNames: string[] = []) {
    const primitives = prims.map((p) => {
      const attributes: Record<string, number> = { POSITION: this.accessor(p.pos, 'VEC3', 34962, false, true), NORMAL: this.accessor(p.nor, 'VEC3', 34962) }
      if (p.uv) attributes.TEXCOORD_0 = this.accessor(p.uv, 'VEC2', 34962)
      if (p.color) attributes.COLOR_0 = this.accessor(p.color, 'VEC4', 34962, true)
      if (p.joints) attributes.JOINTS_0 = this.accessor(p.joints, 'VEC4', 34962)
      if (p.weights) attributes.WEIGHTS_0 = this.accessor(p.weights, 'VEC4', 34962, true)
      const vcount = p.pos.length / 3
      const out: Record<string, unknown> = { attributes, material: p.material, indices: this.accessor(vcount < 65536 ? Uint16Array.from(p.idx) : p.idx, 'SCALAR', 34963) }
      if (p.morphs?.length) out.targets = p.morphs.map((d) => ({ POSITION: this.sparseVec3(d) }))
      return out
    })
    const m: Record<string, unknown> = { name, primitives }
    if (morphNames.length) { m.extras = { targetNames: morphNames }; m.weights = morphNames.map(() => 0) }
    return this.json.meshes.push(m) - 1
  }
  node(n: Record<string, unknown>) { return this.json.nodes.push(n) - 1 }
  toBuffer(rootNodes: number[]) {
    const bin = Buffer.concat(this.chunks)
    const binPad = (4 - (bin.length % 4)) % 4
    const body = Buffer.concat([bin, Buffer.alloc(binPad)])
    const doc: Record<string, unknown> = { asset: { version: '2.0', generator: 'ekbharat-vidya-procedural' }, scene: 0, scenes: [{ nodes: rootNodes }], buffers: [{ byteLength: body.length }] }
    for (const [k, v] of Object.entries(this.json)) if (Array.isArray(v) && v.length) doc[k] = v
    let js = Buffer.from(JSON.stringify(doc))
    if (js.length % 4) js = Buffer.concat([js, Buffer.alloc(4 - (js.length % 4), 0x20)])
    const head = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8)
    head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + body.length, 8)
    jh.writeUInt32LE(js.length, 0); jh.writeUInt32LE(0x4e4f534a, 4)
    bh.writeUInt32LE(body.length, 0); bh.writeUInt32LE(0x004e4942, 4)
    return Buffer.concat([head, jh, js, bh, body])
  }
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type: string, data: Buffer) => { const l = Buffer.alloc(4), t = Buffer.from(type), c = Buffer.alloc(4); l.writeUInt32BE(data.length); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([l, t, data, c]) }
/** RGB8 PNG */
export function png(w: number, h: number, rgb: Uint8Array) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}
