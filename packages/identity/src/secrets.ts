import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { AppError } from '@platform/core'

/** Binds a sealed value to where it belongs, so a sealed secret cannot be moved to another tenant/purpose. */
export interface SealContext {
  tenantId: string
  purpose: string
}

/**
 * Seals secrets (e.g. OIDC client secrets) for storage. Injected by the API host; in production it is
 * backed by the platform key manager / KMS. Implementations must authenticate `context`.
 */
export interface SecretSealer {
  seal(plaintext: string, context: SealContext): Promise<string>
  unseal(sealed: string, context: SealContext): Promise<string>
}

const aad = (c: SealContext) => Buffer.from(`${c.tenantId}|${c.purpose}`, 'utf8')

/**
 * AES-256-GCM sealer with a caller-provided (or random, process-lifetime) key. Intended for tests and
 * local development; with a random key, sealed values do not survive a restart.
 */
export function memorySealer(key: Buffer = randomBytes(32)): SecretSealer {
  if (key.length !== 32) throw new AppError('key_invalid', 'sealer key must be 32 bytes')
  return {
    async seal(plaintext, context) {
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', key, iv)
      c.setAAD(aad(context))
      const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()])
      return `v1.${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url')}`
    },
    async unseal(sealed, context) {
      if (!sealed.startsWith('v1.')) throw new AppError('secret_unseal_failed', 'Unsupported sealed secret')
      const raw = Buffer.from(sealed.slice(3), 'base64url')
      try {
        const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
        d.setAAD(aad(context))
        d.setAuthTag(raw.subarray(12, 28))
        return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')
      } catch {
        throw new AppError('secret_unseal_failed', 'Sealed secret could not be opened')
      }
    },
  }
}
