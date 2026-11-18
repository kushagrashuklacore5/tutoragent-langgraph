import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { AppError, isUuid, newId } from '@platform/core'
import { counter } from '@platform/observability'
import type { MigrationSet } from '@platform/tenancy-db'
import type { SystemDatabase } from '@platform/tenancy-db/system'
import type { KeyManager } from '@platform/ai-gateway'

/**
 * Field-level encryption at rest.
 *
 * - AES-256-GCM, a fresh 96-bit IV per value.
 * - One data key per tenant (versioned; rotation adds a new active version, old versions still decrypt),
 *   wrapped by the platform KeyManager (envelope encryption, same pattern as the AI secret broker).
 *   Wrapped keys live in `platform.field_data_keys`, readable only by the system role.
 * - Additional authenticated data binds every ciphertext to (tenant, table, column, record id, key
 *   version): a value copied to another row, column or tenant fails authentication instead of decrypting.
 *
 * Ciphertext format (text, safe for `text` columns): `fc1.<keyVersion>.<iv>.<tag>.<ciphertext>` (base64url).
 */

export const fieldCryptoMigrations: MigrationSet = {
  owner: 'platform.field-crypto',
  schema: 'platform',
  dir: fileURLToPath(new URL('../migrations', import.meta.url)),
}

/** Where a value lives. All parts are bound into the AAD. */
export interface FieldRef {
  /** e.g. `education_tutor.turns` (callers outside the platform get their module id prefixed by module-runtime) */
  table: string
  column: string
  recordId: string
}

export interface FieldCrypto {
  encrypt(tenantId: string, field: FieldRef, plaintext: string): Promise<string>
  decrypt(tenantId: string, field: FieldRef, ciphertext: string): Promise<string>
  /** Create a new active key version for a tenant (old versions are retired but still decrypt). */
  rotate(tenantId: string): Promise<number>
  /** Drop cached unwrapped keys (all tenants, or one). */
  forget(tenantId?: string): void
}

const PREFIX = 'fc1'
const NAME = /^[a-z][a-z0-9_.:-]{0,127}$/

export const isFieldCiphertext = (v: unknown): v is string => typeof v === 'string' && v.startsWith(`${PREFIX}.`)

function aad(tenantId: string, f: FieldRef, version: number): Buffer {
  if (!isUuid(tenantId)) throw new AppError('crypto_tenant_invalid', 'A valid tenant id is required')
  if (!NAME.test(f.table) || !NAME.test(f.column)) throw new AppError('crypto_field_invalid', `Invalid field reference ${f.table}.${f.column}`)
  if (!f.recordId || f.recordId.length > 200) throw new AppError('crypto_field_invalid', 'A record id is required')
  return Buffer.from(JSON.stringify([PREFIX, tenantId, f.table, f.column, f.recordId, version]), 'utf8')
}

const decryptFailed = () => new AppError('decrypt_failed', 'Encrypted field could not be decrypted', { status: 500, expose: false })

export function createFieldCrypto(o: { system: SystemDatabase; keyManager: KeyManager; cacheTtlMs?: number }): FieldCrypto {
  const ttl = o.cacheTtlMs ?? 5 * 60_000
  const cache = new Map<string, { active: number | null; keys: Map<number, Buffer>; until: number }>()

  const entry = (tenantId: string) => {
    let e = cache.get(tenantId)
    if (!e || e.until < Date.now()) {
      e = { active: null, keys: new Map(), until: Date.now() + ttl }
      cache.set(tenantId, e)
    }
    return e
  }

  async function keyVersion(tenantId: string, version: number): Promise<Buffer> {
    const e = entry(tenantId)
    const hit = e.keys.get(version)
    if (hit) return hit
    const r = await o.system.query<{ wrapped_key: Buffer }>('select wrapped_key from platform.field_data_keys where tenant_id = $1 and version = $2', [tenantId, version])
    if (!r.rows[0]) throw decryptFailed()
    const key = await o.keyManager.unwrap(r.rows[0].wrapped_key)
    e.keys.set(version, key)
    return key
  }

  async function activeKey(tenantId: string): Promise<{ version: number; key: Buffer }> {
    const e = entry(tenantId)
    if (e.active !== null && e.keys.has(e.active)) return { version: e.active, key: e.keys.get(e.active)! }
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await o.system.query<{ version: number; wrapped_key: Buffer }>(
        `select version, wrapped_key from platform.field_data_keys where tenant_id = $1 and status = 'active'`, [tenantId])
      if (r.rows[0]) {
        const key = await o.keyManager.unwrap(r.rows[0].wrapped_key)
        e.keys.set(r.rows[0].version, key)
        e.active = r.rows[0].version
        return { version: r.rows[0].version, key }
      }
      // first use for this tenant: create version 1; a concurrent creator wins via the unique indexes
      await o.system.query(
        `insert into platform.field_data_keys (id, tenant_id, version, wrapped_key, key_manager) values ($1, $2, 1, $3, $4) on conflict do nothing`,
        [newId(), tenantId, await o.keyManager.wrap(randomBytes(32)), o.keyManager.id])
    }
    throw new AppError('crypto_key_unavailable', 'Could not obtain a data key')
  }

  return {
    async encrypt(tenantId, field, plaintext) {
      const { version, key } = await activeKey(tenantId)
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', key, iv)
      c.setAAD(aad(tenantId, field, version))
      const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()])
      counter('field_crypto_ops_total', { op: 'encrypt' }).inc()
      return [PREFIX, String(version), iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.')
    },

    async decrypt(tenantId, field, ciphertext) {
      const parts = ciphertext.split('.')
      if (parts.length !== 5 || parts[0] !== PREFIX || !/^\d+$/.test(parts[1]!)) throw decryptFailed()
      const version = Number(parts[1])
      const key = await keyVersion(tenantId, version)
      try {
        const d = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[2]!, 'base64url'))
        d.setAAD(aad(tenantId, field, version))
        d.setAuthTag(Buffer.from(parts[3]!, 'base64url'))
        const out = Buffer.concat([d.update(Buffer.from(parts[4]!, 'base64url')), d.final()]).toString('utf8')
        counter('field_crypto_ops_total', { op: 'decrypt' }).inc()
        return out
      } catch (e) {
        if (e instanceof AppError) throw e
        counter('field_crypto_ops_total', { op: 'decrypt_failed' }).inc()
        throw decryptFailed()
      }
    },

    async rotate(tenantId) {
      if (!isUuid(tenantId)) throw new AppError('crypto_tenant_invalid', 'A valid tenant id is required')
      const version = await o.system.tx(async (tx) => {
        await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`field-crypto:${tenantId}`])
        const next = (await tx.query<{ v: number }>('select coalesce(max(version), 0)::int + 1 as v from platform.field_data_keys where tenant_id = $1', [tenantId])).rows[0]!.v
        await tx.query(`update platform.field_data_keys set status = 'retired' where tenant_id = $1 and status = 'active'`, [tenantId])
        await tx.query(`insert into platform.field_data_keys (id, tenant_id, version, wrapped_key, key_manager) values ($1, $2, $3, $4, $5)`,
          [newId(), tenantId, next, await o.keyManager.wrap(randomBytes(32)), o.keyManager.id])
        return next
      })
      cache.delete(tenantId)
      return version
    },

    forget(tenantId) {
      if (tenantId) cache.delete(tenantId)
      else cache.clear()
    },
  }
}
