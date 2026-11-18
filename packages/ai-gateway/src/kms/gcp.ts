import { createSign } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { registerSecret } from '@platform/observability'
import type { KeyManager } from '../secrets.ts'
import { kmsError, kmsRequest, type FetchLike, type KmsHttpOptions } from './http.ts'

/**
 * Google Cloud KMS key manager: data keys are wrapped with `cryptoKeys.encrypt` and unwrapped with
 * `cryptoKeys.decrypt` (REST v1), with CRC32C integrity checks in both directions as Google recommends.
 * API: https://cloud.google.com/kms/docs/reference/rest/v1/projects.locations.keyRings.cryptoKeys/encrypt
 * The ciphertext names the key version, so unwrap keeps working after key rotation.
 */

export type GcpTokenSource = () => Promise<string>
export const KMS_SCOPE = 'https://www.googleapis.com/auth/cloudkms'

export interface ServiceAccountKey {
  client_email: string
  private_key: string
  private_key_id?: string
  token_uri?: string
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url')

/** RS256-signed JWT assertion for the OAuth2 JWT bearer grant (RFC 7523), as Google's token endpoint expects. */
export function serviceAccountAssertion(sa: ServiceAccountKey, scope: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = { alg: 'RS256', typ: 'JWT', ...(sa.private_key_id ? { kid: sa.private_key_id } : {}) }
  const claims = { iss: sa.client_email, scope, aud: sa.token_uri ?? 'https://oauth2.googleapis.com/token', iat: nowSec, exp: nowSec + 3600 }
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`
  const sig = createSign('RSA-SHA256').update(input).sign(sa.private_key)
  return `${input}.${b64url(sig)}`
}

function cachedToken(load: () => Promise<{ token: string; expiresInSec: number }>): GcpTokenSource {
  let cur: { token: string; until: number } | undefined
  let inflight: Promise<string> | undefined
  return async () => {
    if (cur && cur.until > Date.now()) return cur.token
    inflight ??= load().then(({ token, expiresInSec }) => {
      registerSecret(token)
      cur = { token, until: Date.now() + Math.max(0, expiresInSec - 300) * 1000 }
      return token
    }).finally(() => (inflight = undefined))
    return inflight
  }
}

interface TokenOpts { fetch?: FetchLike; timeoutMs?: number; scope?: string }

/** OAuth2 access tokens from a service-account key (JWT bearer flow). */
export function serviceAccountTokenSource(sa: ServiceAccountKey, o: TokenOpts = {}): GcpTokenSource {
  if (!sa.client_email || !sa.private_key) throw kmsError('gcp', 'credentials', 'service account key is missing client_email or private_key', { code: 'kms_config_invalid' })
  registerSecret(sa.private_key)
  const tokenUri = sa.token_uri ?? 'https://oauth2.googleapis.com/token'
  return cachedToken(async () => {
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: serviceAccountAssertion(sa, o.scope ?? KMS_SCOPE) }).toString()
    const res = await (o.fetch ?? fetch)(tokenUri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'error', signal: AbortSignal.timeout(o.timeoutMs ?? 5000) }).catch(() => null)
    if (!res) throw kmsError('gcp', 'token', 'token endpoint unreachable', { code: 'kms_unavailable', retryable: true })
    const text = await res.text()
    if (!res.ok) {
      let err = 'unknown'
      try { err = String((JSON.parse(text) as { error?: string }).error ?? 'unknown') } catch { /* not JSON */ }
      throw kmsError('gcp', 'token', `HTTP ${res.status} ${err.replace(/[^\w.-]/g, '')}`, { status: res.status, code: 'kms_access_denied' })
    }
    const j = JSON.parse(text) as { access_token?: string; expires_in?: number }
    if (!j.access_token) throw kmsError('gcp', 'token', 'token response without access_token')
    return { token: j.access_token, expiresInSec: j.expires_in ?? 3600 }
  })
}

/** Access tokens from the GCE/GKE/Cloud Run metadata server (attached service account; no key file). */
export function metadataTokenSource(o: TokenOpts & { metadataHost?: string } = {}): GcpTokenSource {
  const host = o.metadataHost ?? process.env.GCE_METADATA_HOST ?? 'metadata.google.internal'
  const url = `${host.startsWith('http') ? host : `http://${host}`}/computeMetadata/v1/instance/service-accounts/default/token?scopes=${encodeURIComponent(o.scope ?? KMS_SCOPE)}`
  return cachedToken(async () => {
    const res = await (o.fetch ?? fetch)(url, { headers: { 'metadata-flavor': 'Google' }, signal: AbortSignal.timeout(o.timeoutMs ?? 2000) }).catch(() => null)
    if (!res?.ok) throw kmsError('gcp', 'token', `metadata server unavailable${res ? ` (HTTP ${res.status})` : ''}`, { code: 'kms_unavailable', retryable: true })
    const j = (await res.json()) as { access_token: string; expires_in: number }
    return { token: j.access_token, expiresInSec: j.expires_in }
  })
}

/** Token source for a key file path, or the metadata server when none is given. */
export async function gcpTokenSource(credentialsFile: string | undefined, o: TokenOpts = {}): Promise<GcpTokenSource> {
  if (!credentialsFile) return metadataTokenSource(o)
  let sa: ServiceAccountKey & { type?: string }
  try {
    sa = JSON.parse(await readFile(credentialsFile, 'utf8')) as ServiceAccountKey & { type?: string }
  } catch {
    throw kmsError('gcp', 'credentials', 'GOOGLE_APPLICATION_CREDENTIALS file is unreadable or not JSON', { code: 'kms_config_invalid' })
  }
  if (sa.type && sa.type !== 'service_account') throw kmsError('gcp', 'credentials', `credentials type ${sa.type.replace(/\W/g, '')} is not supported (use a service account key or the metadata server)`, { code: 'kms_config_invalid' })
  return serviceAccountTokenSource(sa, o)
}

// ── CRC32C (Castagnoli), needed for KMS integrity fields ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
export function crc32c(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export interface GcpKmsOptions extends KmsHttpOptions {
  /** projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k> */
  keyName: string
  token: GcpTokenSource
  endpoint?: string
  /** bound to every wrapped key; unwrap fails if it differs */
  additionalAuthenticatedData?: string
}

export function gcpKmsKeyManager(o: GcpKmsOptions): KeyManager {
  if (!/^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/.test(o.keyName)) {
    throw kmsError('gcp', 'config', 'keyName must be projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>', { code: 'kms_config_invalid' })
  }
  const base = (o.endpoint ?? 'https://cloudkms.googleapis.com').replace(/\/+$/, '')
  const aad = Buffer.from(o.additionalAuthenticatedData ?? 'ekbharat/ai-data-key', 'utf8')

  async function call<T>(op: 'encrypt' | 'decrypt', payload: Record<string, unknown>): Promise<T> {
    const url = `${base}/v1/${o.keyName}:${op}`
    const body = JSON.stringify(payload)
    const res = await kmsRequest('gcp', op, o, async () => ({
      url, init: { method: 'POST', headers: { authorization: `Bearer ${await o.token()}`, 'content-type': 'application/json' }, body },
    }))
    if (res.status >= 300) {
      let status = ''
      try { status = String((JSON.parse(res.text) as { error?: { status?: string } }).error?.status ?? '') } catch { /* not JSON */ }
      const code = res.status === 401 || res.status === 403 ? 'kms_access_denied' : op === 'decrypt' && res.status === 400 ? 'kms_unwrap_failed' : 'kms_error'
      throw kmsError('gcp', op, `HTTP ${res.status} ${status.replace(/\W/g, '')}`.trim(), { status: res.status, code })
    }
    return JSON.parse(res.text) as T
  }

  return {
    id: `gcp-kms:${o.keyName}`,
    async wrap(dataKey) {
      const r = await call<{ ciphertext?: string; ciphertextCrc32c?: string; verifiedPlaintextCrc32c?: boolean; verifiedAdditionalAuthenticatedDataCrc32c?: boolean }>('encrypt', {
        plaintext: dataKey.toString('base64'),
        additionalAuthenticatedData: aad.toString('base64'),
        plaintextCrc32c: String(crc32c(dataKey)),
        additionalAuthenticatedDataCrc32c: String(crc32c(aad)),
      })
      if (!r.ciphertext) throw kmsError('gcp', 'encrypt', 'response without ciphertext')
      const ct = Buffer.from(r.ciphertext, 'base64')
      if (!r.verifiedPlaintextCrc32c || !r.verifiedAdditionalAuthenticatedDataCrc32c || r.ciphertextCrc32c !== String(crc32c(ct))) {
        throw kmsError('gcp', 'encrypt', 'integrity check failed (CRC32C)', { code: 'kms_integrity' })
      }
      return ct
    },
    async unwrap(wrapped) {
      const r = await call<{ plaintext?: string; plaintextCrc32c?: string }>('decrypt', {
        ciphertext: wrapped.toString('base64'),
        additionalAuthenticatedData: aad.toString('base64'),
        ciphertextCrc32c: String(crc32c(wrapped)),
        additionalAuthenticatedDataCrc32c: String(crc32c(aad)),
      })
      if (!r.plaintext) throw kmsError('gcp', 'decrypt', 'response without plaintext')
      const pt = Buffer.from(r.plaintext, 'base64')
      if (r.plaintextCrc32c !== String(crc32c(pt))) throw kmsError('gcp', 'decrypt', 'integrity check failed (CRC32C)', { code: 'kms_integrity' })
      return pt
    },
  }
}
