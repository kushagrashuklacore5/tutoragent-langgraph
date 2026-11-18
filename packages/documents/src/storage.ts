import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { connect } from 'node:net'
import { AppError } from '@platform/core'

/** Object storage for originals. Keys are `<tenant>/<module>/<document-id>` (ids only — no user input). */
export interface ObjectStore {
  put(key: string, data: Buffer): Promise<void>
  get(key: string): Promise<Buffer>
  delete(key: string): Promise<void>
  /** delete everything under a prefix (module purge) */
  deletePrefix(prefix: string): Promise<void>
}

const KEY = /^[0-9a-f-]{36}\/[a-z0-9._-]+(\/[0-9a-f-]{36})?$/

/**
 * Local filesystem store for development and single-node pilots, encrypted at rest with AES-256-GCM
 * (key supplied by the host, e.g. derived from the platform key manager). Production uses an
 * S3-compatible store in the India region (F12) behind the same interface.
 */
export function localObjectStore(rootDir: string, encryptionKey: Buffer): ObjectStore {
  if (encryptionKey.length !== 32) throw new AppError('store_key_invalid', 'object store key must be 32 bytes')
  const root = resolve(rootDir)
  const pathOf = (key: string) => {
    if (!KEY.test(key)) throw new AppError('storage_key_invalid', 'invalid storage key')
    const p = resolve(root, ...key.split('/'))
    if (!p.startsWith(root + sep)) throw new AppError('storage_key_invalid', 'invalid storage key')
    return p
  }
  return {
    async put(key, data) {
      const p = pathOf(key)
      await mkdir(resolve(p, '..'), { recursive: true })
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', encryptionKey, iv)
      c.setAAD(Buffer.from(key))
      const ct = Buffer.concat([c.update(data), c.final()])
      await writeFile(p, Buffer.concat([iv, c.getAuthTag(), ct]), { mode: 0o600 })
    },
    async get(key) {
      const raw = await readFile(pathOf(key))
      const d = createDecipheriv('aes-256-gcm', encryptionKey, raw.subarray(0, 12))
      d.setAAD(Buffer.from(key))
      d.setAuthTag(raw.subarray(12, 28))
      return Buffer.concat([d.update(raw.subarray(28)), d.final()])
    },
    async delete(key) {
      await rm(pathOf(key), { force: true })
    },
    async deletePrefix(prefix) {
      if (!/^[0-9a-f-]{36}\/[a-z0-9._-]+$/.test(prefix) && !/^[0-9a-f-]{36}$/.test(prefix)) throw new AppError('storage_key_invalid', 'invalid prefix')
      await rm(join(root, ...prefix.split('/')), { recursive: true, force: true })
    },
  }
}

/** Malware scanning (SECURITY_AND_PRIVACY § 7). */
export interface Scanner {
  id: string
  scan(data: Buffer): Promise<{ clean: boolean; signature?: string }>
}

/** Development only: performs no scan. The API host refuses to use it in production. */
export const devNoopScanner: Scanner = { id: 'dev-noop', async scan() { return { clean: true } } }

/** ClamAV `clamd` INSTREAM protocol over TCP. */
export function clamdScanner(host: string, port: number, timeoutMs = 30_000): Scanner {
  return {
    id: `clamd:${host}:${port}`,
    scan(data) {
      return new Promise((res, rej) => {
        const s = connect({ host, port })
        let reply = ''
        const t = setTimeout(() => { s.destroy(); rej(new AppError('scan_timeout', 'Virus scan timed out', { status: 503 })) }, timeoutMs)
        s.on('connect', () => {
          s.write('zINSTREAM\0')
          for (let i = 0; i < data.length; i += 64 * 1024) {
            const chunk = data.subarray(i, i + 64 * 1024)
            const len = Buffer.alloc(4)
            len.writeUInt32BE(chunk.length)
            s.write(len)
            s.write(chunk)
          }
          s.write(Buffer.alloc(4))
        })
        s.on('data', (d) => (reply += d.toString('utf8')))
        s.on('end', () => {
          clearTimeout(t)
          const r = reply.replace(/\0/g, '').trim()
          if (/: OK$/.test(r)) res({ clean: true })
          else if (/FOUND$/.test(r)) res({ clean: false, signature: r.replace(/^stream: /, '').replace(/ FOUND$/, '') })
          else rej(new AppError('scan_failed', `Virus scanner error: ${r.slice(0, 100)}`, { status: 503 }))
        })
        s.on('error', (e) => { clearTimeout(t); rej(new AppError('scan_unavailable', `Virus scanner unavailable (${e.message})`, { status: 503 })) })
      })
    },
  }
}
