import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto'

export const newId = (): string => randomUUID()
/** URL-safe random token with `bytes` of entropy. */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url')
export const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex')
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID.test(s)
