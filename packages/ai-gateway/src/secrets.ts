import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { AppError, newId, sha256 } from '@platform/core'
import { registerSecret } from '@platform/observability'
import type { SystemDatabase } from '@platform/tenancy-db/system'

/** Wraps/unwraps data keys. Local implementation for dev/pilot; a cloud KMS implements the same interface (F12). */
export interface KeyManager {
  id: string
  wrap(dataKey: Buffer): Promise<Buffer>
  unwrap(wrapped: Buffer): Promise<Buffer>
}

function seal(key: Buffer, plain: Buffer) {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([c.update(plain), c.final()])
  return { iv, tag: c.getAuthTag(), ct }
}
function open(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()])
}

export function localKeyManager(masterKey: Buffer): KeyManager {
  if (masterKey.length !== 32) throw new AppError('key_invalid', 'master key must be 32 bytes')
  return {
    id: 'local-aes256gcm-v1',
    async wrap(dk) {
      const { iv, tag, ct } = seal(masterKey, dk)
      return Buffer.concat([iv, tag, ct])
    },
    async unwrap(w) {
      return open(masterKey, w.subarray(0, 12), w.subarray(12, 28), w.subarray(28))
    },
  }
}

export interface StoredSecretInfo {
  id: string
  fingerprint: string
  last4: string
}

/**
 * Envelope-encrypted, write-only secrets (AI_GATEWAY.md § 11.1).
 * One data key per scope (platform, or each tenant for BYOK) wrapped by the KeyManager.
 * Plaintext is only returned to the gateway at call time, cached briefly, and registered with the
 * log redactor so it can never appear in logs.
 */
export function createSecretBroker(system: SystemDatabase, km: KeyManager, opts: { cacheTtlMs?: number } = {}) {
  const ttl = opts.cacheTtlMs ?? 60_000
  const cache = new Map<string, { value: string; tenantId: string | null; until: number }>()

  async function dataKey(tenantId: string | null): Promise<{ id: string; key: Buffer }> {
    const existing = await system.query<{ id: string; wrapped_key: Buffer }>(
      `select id, wrapped_key from platform.ai_data_keys where tenant_id is not distinct from $1`, [tenantId])
    if (existing.rows[0]) return { id: existing.rows[0].id, key: await km.unwrap(existing.rows[0].wrapped_key) }
    const key = randomBytes(32)
    const id = newId()
    await system.query(
      `insert into platform.ai_data_keys (id, tenant_id, wrapped_key, key_manager) values ($1, $2, $3, $4) on conflict do nothing`,
      [id, tenantId, await km.wrap(key), km.id])
    return dataKey(tenantId) // re-read: another process may have won the race
  }

  return {
    async put(tenantId: string | null, plaintext: string): Promise<StoredSecretInfo> {
      if (!plaintext || plaintext.length < 8) throw new AppError('secret_invalid', 'Secret is too short', { status: 400 })
      const dk = await dataKey(tenantId)
      const { iv, tag, ct } = seal(dk.key, Buffer.from(plaintext, 'utf8'))
      const id = newId()
      const info = { id, fingerprint: sha256(plaintext).slice(0, 12), last4: plaintext.slice(-4) }
      await system.query(
        `insert into platform.ai_secrets (id, tenant_id, data_key_id, ciphertext, iv, auth_tag, fingerprint, last4) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, tenantId, dk.id, ct, iv, tag, info.fingerprint, info.last4])
      return info
    },

    async rotate(secretId: string, tenantId: string | null, plaintext: string): Promise<StoredSecretInfo> {
      const dk = await dataKey(tenantId)
      const { iv, tag, ct } = seal(dk.key, Buffer.from(plaintext, 'utf8'))
      const fp = sha256(plaintext).slice(0, 12)
      const r = await system.query(
        `update platform.ai_secrets set ciphertext=$3, iv=$4, auth_tag=$5, data_key_id=$6, fingerprint=$7, last4=$8, rotated_at=now()
         where id=$1 and tenant_id is not distinct from $2`,
        [secretId, tenantId, ct, iv, tag, dk.id, fp, plaintext.slice(-4)])
      if (!r.rowCount) throw new AppError('secret_not_found', 'Secret not found', { status: 404 })
      cache.delete(secretId)
      return { id: secretId, fingerprint: fp, last4: plaintext.slice(-4) }
    },

    /** Decrypt for a call. Refuses if the secret belongs to another scope (BYOK isolation). */
    async reveal(secretId: string, expectedTenantId: string | null): Promise<string> {
      const c = cache.get(secretId)
      if (c && c.until > Date.now()) {
        if (c.tenantId !== expectedTenantId) throw new AppError('secret_scope_mismatch', 'Secret does not belong to this scope', { status: 403 })
        return c.value
      }
      const r = await system.query<{ tenant_id: string | null; ciphertext: Buffer; iv: Buffer; auth_tag: Buffer; data_key_id: string }>(
        `select tenant_id, ciphertext, iv, auth_tag, data_key_id from platform.ai_secrets where id = $1`, [secretId])
      const row = r.rows[0]
      if (!row) throw new AppError('secret_not_found', 'Secret not found', { status: 404 })
      if (row.tenant_id !== expectedTenantId) throw new AppError('secret_scope_mismatch', 'Secret does not belong to this scope', { status: 403 })
      const dk = await system.query<{ wrapped_key: Buffer }>('select wrapped_key from platform.ai_data_keys where id = $1', [row.data_key_id])
      const key = await km.unwrap(dk.rows[0]!.wrapped_key)
      const value = open(key, row.iv, row.auth_tag, row.ciphertext).toString('utf8')
      registerSecret(value)
      cache.set(secretId, { value, tenantId: row.tenant_id, until: Date.now() + ttl })
      return value
    },

    async info(secretId: string): Promise<StoredSecretInfo | null> {
      const r = await system.query<{ id: string; fingerprint: string; last4: string }>('select id, fingerprint, last4 from platform.ai_secrets where id = $1', [secretId])
      return r.rows[0] ?? null
    },

    forget(secretId: string) {
      cache.delete(secretId)
    },
  }
}
export type SecretBroker = ReturnType<typeof createSecretBroker>
