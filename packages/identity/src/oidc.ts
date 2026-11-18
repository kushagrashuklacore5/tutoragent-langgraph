/**
 * Minimal, dependency-free OpenID Connect relying-party primitives: discovery (cached, issuer-validated),
 * JWKS (cached, refetch on unknown kid, rate-limited), ID token validation (RS256/ES256 only) and the
 * authorization-code token exchange with PKCE. No token or secret is ever logged.
 */
import { createHash, createPublicKey, verify as cryptoVerify, type JsonWebKey as CryptoJwk, type KeyObject } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { AppError } from '@platform/core'

export class OidcError extends AppError {
  constructor(code: string, message: string) {
    super(code, message, { status: 401 })
    this.name = 'OidcError'
  }
}
const fail = (code: string, msg: string): never => { throw new OidcError(code, msg) }

export interface DiscoveryDocument {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  token_endpoint_auth_methods_supported?: string[]
  id_token_signing_alg_values_supported?: string[]
}

export interface OidcClientOptions {
  /** allow http:// issuers/endpoints (tests, local dev only) */
  allowInsecureHttp?: boolean
  /** allow issuers resolving to loopback/private addresses (tests, local dev only) */
  allowPrivateNetwork?: boolean
  discoveryTtlMs?: number
  jwksTtlMs?: number
  /** minimum interval between JWKS refetches triggered by an unknown kid */
  jwksMinRefetchMs?: number
  clockSkewSec?: number
  /** reject ID tokens whose iat is older than this */
  maxTokenAgeSec?: number
  timeoutMs?: number
  fetch?: typeof fetch
  now?: () => number
}

type Jwk = CryptoJwk & { kty?: string; kid?: string; use?: string; alg?: string; crv?: string }

export const SUPPORTED_ALGS = ['RS256', 'ES256'] as const

const b64urlJson = (s: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object')
    return v as Record<string, unknown>
  } catch {
    return fail('id_token_malformed', 'ID token is malformed')
  }
}

export const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')

function isPrivateAddress(ip: string): boolean {
  const v = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  if (isIP(v) === 4) {
    const [a, b] = v.split('.').map(Number) as [number, number]
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  }
  const l = v.toLowerCase()
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb')
}

export function createOidcClient(o: OidcClientOptions = {}) {
  const doFetch = o.fetch ?? fetch
  const now = o.now ?? Date.now
  const discoveryTtl = o.discoveryTtlMs ?? 3_600_000
  const jwksTtl = o.jwksTtlMs ?? 3_600_000
  const minRefetch = o.jwksMinRefetchMs ?? 30_000
  const skew = o.clockSkewSec ?? 60
  const maxAge = o.maxTokenAgeSec ?? 600
  const timeoutMs = o.timeoutMs ?? 10_000

  const discoveryCache = new Map<string, { doc: DiscoveryDocument; until: number }>()
  const jwksCache = new Map<string, { keys: Map<string, { key: KeyObject; jwk: Jwk }>; until: number; fetchedAt: number }>()

  async function checkUrl(raw: string, what: string): Promise<URL> {
    let u: URL
    try { u = new URL(raw) } catch { return fail('oidc_url_invalid', `${what} is not a valid URL`) }
    if (u.protocol !== 'https:' && !(o.allowInsecureHttp && u.protocol === 'http:')) fail('oidc_url_insecure', `${what} must use https`)
    if (u.username || u.password) fail('oidc_url_invalid', `${what} must not contain credentials`)
    if (!o.allowPrivateNetwork) {
      const host = u.hostname.replace(/^\[|\]$/g, '')
      const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => fail('oidc_unreachable', `${what} host does not resolve`))).map((a) => a.address)
      if (addrs.some(isPrivateAddress)) fail('oidc_url_private', `${what} resolves to a private network address`)
    }
    return u
  }

  async function getJson(url: string, what: string): Promise<Record<string, unknown>> {
    await checkUrl(url, what)
    let res: Response
    try {
      res = await doFetch(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
    } catch {
      return fail('oidc_unreachable', `${what} could not be fetched`)
    }
    if (!res.ok) fail('oidc_unreachable', `${what} returned HTTP ${res.status}`)
    const body = await res.json().catch(() => null)
    if (!body || typeof body !== 'object') fail('oidc_bad_response', `${what} is not JSON`)
    return body as Record<string, unknown>
  }

  async function discover(issuer: string, opts: { fresh?: boolean } = {}): Promise<DiscoveryDocument> {
    const c = discoveryCache.get(issuer)
    if (c && c.until > now() && !opts.fresh) return c.doc
    const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`
    const d = await getJson(url, 'Discovery document')
    // OIDC Discovery § 4.3: the issuer in the document MUST exactly match the configured issuer
    if (d.issuer !== issuer) fail('oidc_issuer_mismatch', 'Discovery issuer does not match the configured issuer')
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
      if (typeof d[k] !== 'string') fail('oidc_bad_response', `Discovery document lacks ${k}`)
      await checkUrl(d[k] as string, k)
    }
    const doc = d as unknown as DiscoveryDocument
    discoveryCache.set(issuer, { doc, until: now() + discoveryTtl })
    return doc
  }

  async function loadJwks(jwksUri: string) {
    const body = await getJson(jwksUri, 'JWKS')
    if (!Array.isArray(body.keys)) fail('oidc_bad_response', 'JWKS has no keys')
    const keys = new Map<string, { key: KeyObject; jwk: Jwk }>()
    let i = 0
    for (const jwk of body.keys as (Jwk)[]) {
      if (!jwk || (jwk.kty !== 'RSA' && jwk.kty !== 'EC')) continue
      if (jwk.use && jwk.use !== 'sig') continue
      // only public members are imported, even if a misconfigured IdP publishes private ones
      const pub = jwk.kty === 'RSA' ? { kty: 'RSA', n: jwk.n, e: jwk.e } : { kty: 'EC', crv: jwk.crv, x: jwk.x, y: jwk.y }
      try {
        keys.set(jwk.kid ?? `#${i++}`, { key: createPublicKey({ key: pub as CryptoJwk, format: 'jwk' }), jwk })
      } catch { /* skip unusable key */ }
    }
    const entry = { keys, until: now() + jwksTtl, fetchedAt: now() }
    jwksCache.set(jwksUri, entry)
    return entry
  }

  async function keyFor(jwksUri: string, kid: string | undefined, alg: string) {
    const kty = alg === 'RS256' ? 'RSA' : 'EC'
    const pick = (e: { keys: Map<string, { key: KeyObject; jwk: Jwk }> }) => {
      if (kid !== undefined) return e.keys.get(kid)
      const candidates = [...e.keys.values()].filter((k) => k.jwk.kty === kty)
      return candidates.length === 1 ? candidates[0] : undefined
    }
    let e = jwksCache.get(jwksUri)
    if (!e || e.until <= now()) e = await loadJwks(jwksUri)
    let found = pick(e)
    // key rotation: refetch once on an unknown kid, but not more often than minRefetch
    if (!found && now() - e.fetchedAt >= minRefetch) {
      e = await loadJwks(jwksUri)
      found = pick(e)
    }
    if (!found) return fail('id_token_unknown_key', 'ID token signing key is unknown')
    if (found.jwk.kty !== kty || (kty === 'EC' && found.jwk.crv !== 'P-256')) fail('id_token_alg_mismatch', 'Signing key does not match the token algorithm')
    if (found.jwk.alg && found.jwk.alg !== alg) fail('id_token_alg_mismatch', 'Signing key does not match the token algorithm')
    return found.key
  }

  /** Validate an ID token (signature, iss, aud/azp, exp/iat/nbf, nonce). Returns its claims. */
  async function verifyIdToken(idToken: string, expect: { issuer: string; clientId: string; nonce: string; jwksUri: string }): Promise<Record<string, unknown>> {
    if (typeof idToken !== 'string') fail('id_token_malformed', 'ID token is missing')
    const parts = idToken.split('.')
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) fail('id_token_malformed', 'ID token is malformed')
    const [h, p, s] = parts as [string, string, string]
    const header = b64urlJson(h)
    const alg = header.alg
    // rejects 'none', HS* (would allow forging with the public key as HMAC secret) and anything else
    if (typeof alg !== 'string' || !(SUPPORTED_ALGS as readonly string[]).includes(alg)) fail('id_token_alg_rejected', 'ID token algorithm is not accepted')
    if (header.crit !== undefined) fail('id_token_alg_rejected', 'ID token uses unsupported critical headers')
    const kid = typeof header.kid === 'string' ? header.kid : undefined
    const key = await keyFor(expect.jwksUri, kid, alg as string)
    const sig = Buffer.from(s, 'base64url')
    const data = Buffer.from(`${h}.${p}`)
    let ok = false
    if (alg === 'RS256') ok = cryptoVerify('sha256', data, key, sig)
    else ok = sig.length === 64 && cryptoVerify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig)
    if (!ok) fail('id_token_bad_signature', 'ID token signature is invalid')

    const c = b64urlJson(p)
    const t = Math.floor(now() / 1000)
    if (c.iss !== expect.issuer) fail('id_token_wrong_issuer', 'ID token issuer is not the configured issuer')
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud]
    if (!aud.includes(expect.clientId)) fail('id_token_wrong_audience', 'ID token audience does not include this client')
    if ((aud.length > 1 || c.azp !== undefined) && c.azp !== expect.clientId) fail('id_token_wrong_audience', 'ID token authorized party is not this client')
    if (typeof c.exp !== 'number' || c.exp + skew < t) fail('id_token_expired', 'ID token has expired')
    if (typeof c.iat !== 'number' || c.iat - skew > t || c.iat + maxAge < t) fail('id_token_expired', 'ID token issue time is not acceptable')
    if (c.nbf !== undefined && (typeof c.nbf !== 'number' || c.nbf - skew > t)) fail('id_token_not_yet_valid', 'ID token is not yet valid')
    if (typeof c.nonce !== 'string' || c.nonce !== expect.nonce) fail('id_token_nonce_mismatch', 'ID token nonce does not match')
    if (typeof c.sub !== 'string' || !c.sub) fail('id_token_malformed', 'ID token has no subject')
    return c
  }

  /** Authorization-code exchange (RFC 6749 § 4.1.3 + PKCE RFC 7636). Returns the raw id_token. */
  async function exchangeCode(doc: DiscoveryDocument, input: { code: string; codeVerifier: string; redirectUri: string; clientId: string; clientSecret: string | null }): Promise<string> {
    await checkUrl(doc.token_endpoint, 'token_endpoint')
    const form = new URLSearchParams({ grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri, code_verifier: input.codeVerifier })
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
    const methods = doc.token_endpoint_auth_methods_supported ?? ['client_secret_basic']
    if (input.clientSecret && methods.includes('client_secret_basic')) {
      const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, '+')
      headers.authorization = `Basic ${Buffer.from(`${enc(input.clientId)}:${enc(input.clientSecret)}`).toString('base64')}`
    } else {
      form.set('client_id', input.clientId)
      if (input.clientSecret) form.set('client_secret', input.clientSecret)
    }
    let res: Response
    try {
      res = await doFetch(doc.token_endpoint, { method: 'POST', headers, body: form, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) })
    } catch {
      return fail('oidc_token_exchange_failed', 'Token endpoint could not be reached')
    }
    const body = (await res.json().catch(() => null)) as { id_token?: unknown; token_type?: unknown } | null
    if (!res.ok || !body) return fail('oidc_token_exchange_failed', `Token endpoint returned HTTP ${res.status}`)
    if (typeof body.id_token !== 'string') return fail('oidc_token_exchange_failed', 'Token response has no id_token')
    return body.id_token
  }

  return { discover, verifyIdToken, exchangeCode, checkUrl }
}
export type OidcClient = ReturnType<typeof createOidcClient>
