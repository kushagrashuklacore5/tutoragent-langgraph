import { inflateRawSync } from 'node:zlib'

/**
 * Minimal, defensive ZIP reader for DOCX/PPTX (central directory based). Guards against zip bombs:
 * entry count, per-entry and total uncompressed size limits, and compression ratio.
 */
export interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  size: number
  offset: number
}

const LIMITS = { entries: 5000, entryBytes: 50 * 1024 * 1024, totalBytes: 200 * 1024 * 1024, ratio: 200 }

export function listZipEntries(buf: Buffer): ZipEntry[] {
  // find End Of Central Directory (scan back up to 64 KiB comment)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip file')
  const count = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (count > LIMITS.entries) throw new Error('too many zip entries')
  const out: ZipEntry[] = []
  let p = cdOffset
  let total = 0
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt central directory')
    const method = buf.readUInt16LE(p + 10)
    const compressedSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const offset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    if (size > LIMITS.entryBytes) throw new Error('zip entry too large')
    if (compressedSize > 0 && size / compressedSize > LIMITS.ratio) throw new Error('suspicious compression ratio')
    total += size
    if (total > LIMITS.totalBytes) throw new Error('zip content too large')
    out.push({ name, method, compressedSize, size, offset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

export function readZipEntry(buf: Buffer, e: ZipEntry): Buffer {
  const p = e.offset
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error('corrupt local header')
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28)
  const data = buf.subarray(start, start + e.compressedSize)
  if (e.method === 0) return Buffer.from(data)
  if (e.method === 8) {
    const out = inflateRawSync(data, { maxOutputLength: LIMITS.entryBytes })
    if (out.length !== e.size) throw new Error('zip entry size mismatch')
    return out
  }
  throw new Error(`unsupported zip compression method ${e.method}`)
}
