/**
 * In-process mock OpenID Provider for tests: discovery, JWKS, token endpoint (client auth + PKCE
 * checked) and signed ID tokens (RS256 / ES256). Keys are generated at start; nothing is persisted.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'

export interface MockKey { kid: string; alg: 'RS256' | 'ES256'; privateKey: KeyObject; publicJwk: Record<string, unknown> }

export function makeKey(alg: 'RS256' | 'ES256', kid = randomBytes(6).toString('hex')): MockKey {
  const { privateKey, publicKey } = alg === 'RS256'
    ? generateKeyPairSync('rsa', { modulusLength: 2048 })
    : generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return { kid, alg, privateKey, publicJwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg } }
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')

export function signJwt(claims: Record<string, unknown>, key: MockKey, header: Record<string, unknown> = {}): string {
  const h = b64({ alg: key.alg, typ: 'JWT', kid: key.kid, ...header })
  const p = b64(claims)
  const sig = sign('sha256', Buffer.from(`${h}.${p}`), key.alg === 'ES256' ? { key: key.privateKey, dsaEncoding: 'ieee-p1363' } : key.privateKey)
  return `${h}.${p}.${sig.toString('base64url')}`
}

interface Grant { clientId: string; redirectUri: string; challenge: string; nonce: string; claims: Record<string, unknown>; tamper?: (c: Record<string, unknown>) => Record<string, unknown>; rawToken?: (nonce: string) => string }

export interface MockProvider {
  issuer: string
  keys: MockKey[]
  /** active signing key */
  signingKey: MockKey
  clients: Map<string, string>
  stats: { jwks: number; discovery: number; token: number }
  /** Simulate the user authenticating at the IdP: consumes the authorization URL, returns a code. */
  authorize(authUrl: string, claims: Record<string, unknown>, opts?: { tamper?: (c: Record<string, unknown>) => Record<string, unknown>; rawToken?: (nonce: string) => string }): { code: string; state: string; redirectUri: string }
  rotate(alg?: 'RS256' | 'ES256'): MockKey
  close(): Promise<void>
}

export async function startMockProvider(opts: { alg?: 'RS256' | 'ES256'; issuerPath?: string; discoveryIssuer?: string } = {}): Promise<MockProvider> {
  const grants = new Map<string, Grant>()
  const stats = { jwks: 0, discovery: 0, token: 0 }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', p.issuer)
    const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    if (url.pathname === `${opts.issuerPath ?? ''}/.well-known/openid-configuration`) {
      stats.discovery++
      return json(200, {
        issuer: opts.discoveryIssuer ?? p.issuer, authorization_endpoint: `${p.issuer}/authorize`, token_endpoint: `${p.issuer}/token`, jwks_uri: `${p.issuer}/jwks`,
        response_types_supported: ['code'], id_token_signing_alg_values_supported: ['RS256', 'ES256'], code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      })
    }
    if (url.pathname === `${opts.issuerPath ?? ''}/jwks`) {
      stats.jwks++
      return json(200, { keys: p.keys.map((k) => k.publicJwk) })
    }
    if (url.pathname === `${opts.issuerPath ?? ''}/token` && req.method === 'POST') {
      stats.token++
      let body = ''
      for await (const c of req) body += c
      const f = new URLSearchParams(body)
      let clientId = f.get('client_id')
      let secret = f.get('client_secret')
      const basic = req.headers.authorization?.startsWith('Basic ') ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString() : null
      if (basic) {
        const i = basic.indexOf(':')
        clientId = decodeURIComponent(basic.slice(0, i))
        secret = decodeURIComponent(basic.slice(i + 1))
      }
      if (!clientId || p.clients.get(clientId) !== secret) return json(401, { error: 'invalid_client' })
      const g = grants.get(f.get('code') ?? '')
      grants.delete(f.get('code') ?? '')
      if (!g || g.clientId !== clientId || g.redirectUri !== f.get('redirect_uri')) return json(400, { error: 'invalid_grant' })
      const verifier = f.get('code_verifier') ?? ''
      if (createHash('sha256').update(verifier).digest('base64url') !== g.challenge) return json(400, { error: 'invalid_grant', error_description: 'pkce' })
      const now = Math.floor(Date.now() / 1000)
      let claims: Record<string, unknown> = { iss: p.issuer, aud: clientId, sub: 'sub-' + String(g.claims.email ?? 'x'), iat: now, exp: now + 300, nonce: g.nonce, ...g.claims }
      if (g.tamper) claims = g.tamper(claims)
      return json(200, { access_token: 'at', token_type: 'Bearer', id_token: g.rawToken ? g.rawToken(g.nonce) : signJwt(claims, p.signingKey) })
    }
    json(404, { error: 'not_found' })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  const first = makeKey(opts.alg ?? 'RS256')
  const p: MockProvider = {
    issuer: `http://127.0.0.1:${port}${opts.issuerPath ?? ''}`,
    keys: [first],
    signingKey: first,
    clients: new Map(),
    stats,
    authorize(authUrl, claims, o = {}) {
      const u = new URL(authUrl)
      if (u.searchParams.get('code_challenge_method') !== 'S256') throw new Error('PKCE S256 required')
      const code = randomBytes(16).toString('hex')
      grants.set(code, {
        clientId: u.searchParams.get('client_id')!, redirectUri: u.searchParams.get('redirect_uri')!, challenge: u.searchParams.get('code_challenge')!,
        nonce: u.searchParams.get('nonce')!, claims, tamper: o.tamper, rawToken: o.rawToken,
      })
      return { code, state: u.searchParams.get('state')!, redirectUri: u.searchParams.get('redirect_uri')! }
    },
    rotate(alg = 'RS256') {
      const k = makeKey(alg)
      p.keys = [k]
      p.signingKey = k
      return k
    },
    async close() {
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
    },
  }
  return p
}
