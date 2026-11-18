/**
 * Institution single sign-on (OIDC authorization-code flow with PKCE), one IdP per tenant.
 *
 * Account mapping rules:
 *  - the configured "email verified" claim must be true (boolean, or the string "true" some IdPs emit;
 *    default `email_verified`; for
 *    Microsoft Entra configure `xms_edov`, the "email domain owner verified" optional claim);
 *  - the email domain must be in the tenant's allowed domains;
 *  - the user must already be an active member of the tenant, unless the tenant enabled
 *    just-in-time student provisioning (default off); disabled memberships are never reactivated;
 *  - adults-only pilot (PD-09): users without an attestation are handed to the existing magic-link
 *    verify step (a single-use login token) to attest; a recorded 'minor' attestation blocks.
 * Sessions are created exactly like magic-link sessions (same table, same cookie).
 */
import { AppError, badRequest, newId, randomToken, sha256, safeEqual } from '@platform/core'
import { counter, logger, registerSecret } from '@platform/observability'
import type { Database } from '@platform/tenancy-db'
import type { SystemDatabase } from '@platform/tenancy-db/system'
import { recordAudit, recordSystemAudit } from '@platform/audit'
import { createOidcClient, OidcError, pkceChallenge, type OidcClient, type OidcClientOptions } from './oidc.ts'
import type { SecretSealer } from './secrets.ts'

export interface SsoOptions {
  system: SystemDatabase
  db: Database
  sealer: SecretSealer
  /** web app origin; success and error redirects go here */
  publicBaseUrl: string
  /** fixed per environment; must be registered at every IdP. Default `${publicBaseUrl}/api/auth/sso/callback` */
  redirectUri?: string
  stateTtlMs?: number
  sessionTtlMs?: number
  loginTokenTtlMs?: number
  /** max authorization requests started per tenant per minute */
  startsPerTenantPerMinute?: number
  oidc?: OidcClientOptions
  /** injected client (tests) */
  client?: OidcClient
}

export interface SsoAdminContext {
  userId: string
  tenantId: string
  roles: string[]
}

export interface IdpConfigInput {
  issuer?: string
  clientId?: string
  /** write-only; omitted = keep the stored secret, null = remove it */
  clientSecret?: string | null
  allowedDomains?: string[]
  enabled?: boolean
  emailClaim?: string
  nameClaim?: string
  emailVerifiedClaim?: string
  jitStudentProvisioning?: boolean
}

export interface IdpConfigView {
  issuer: string
  clientId: string
  hasClientSecret: boolean
  allowedDomains: string[]
  enabled: boolean
  emailClaim: string
  nameClaim: string
  emailVerifiedClaim: string
  jitStudentProvisioning: boolean
  updatedAt: Date
}

interface IdpRow {
  tenant_id: string
  issuer: string
  client_id: string
  client_secret_sealed: string | null
  allowed_domains: string[]
  enabled: boolean
  email_claim: string
  name_claim: string
  email_verified_claim: string
  jit_student_provisioning: boolean
  updated_at: Date
}

export type SsoStartResult = { kind: 'redirect'; location: string; binder: string; binderMaxAgeSec: number } | { kind: 'error'; location: string; code: string }
export type SsoCallbackResult =
  | { kind: 'session'; location: string; sessionToken: string; expiresAt: Date; userId: string; tenantId: string }
  | { kind: 'attestation'; location: string }
  | { kind: 'error'; location: string; code: string }

const SECRET_PURPOSE = 'sso.client_secret'
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const CLAIM = /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Safe relative path inside the app for post-login redirect. */
function safeReturnTo(v: string | null | undefined): string | null {
  if (!v || v.length > 512 || !v.startsWith('/') || v.startsWith('//') || /[\\\s]/.test(v)) return null
  return v
}

/** Codes the user may see on the error page (no internal details). */
const USER_CODES: Record<string, string> = {
  sso_not_available: 'sso_not_available',
  rate_limited: 'rate_limited',
  email_not_verified: 'email_not_verified',
  domain_not_allowed: 'domain_not_allowed',
  not_a_member: 'not_a_member',
  age_restricted: 'age_restricted',
  idp_error: 'idp_error',
}

export function createSsoService(o: SsoOptions) {
  const base = o.publicBaseUrl.replace(/\/$/, '')
  const redirectUri = o.redirectUri ?? `${base}/api/auth/sso/callback`
  const stateTtl = o.stateTtlMs ?? 10 * 60_000
  const sessionTtl = o.sessionTtlMs ?? 7 * 24 * 3_600_000
  const loginTokenTtl = o.loginTokenTtlMs ?? 10 * 60_000
  const perTenant = o.startsPerTenantPerMinute ?? 120
  const client = o.client ?? createOidcClient(o.oidc)
  const errorLocation = (code: string) => `${base}/auth/sso-error?code=${encodeURIComponent(USER_CODES[code] ?? 'sso_failed')}`
  const ctx = (tenantId: string) => ({ tenantId, purpose: SECRET_PURPOSE })

  async function unsealSecret(row: IdpRow): Promise<string | null> {
    if (!row.client_secret_sealed) return null
    const s = await o.sealer.unseal(row.client_secret_sealed, ctx(row.tenant_id))
    registerSecret(s)
    return s
  }

  async function auditFailure(tenantId: string | null, reason: string, extra: Record<string, unknown> = {}) {
    counter('auth_sso_total', { outcome: reason }).inc()
    logger.warn('sso login failed', { tenantId, reason })
    await o.system.tx((tx) => recordSystemAudit(tx, { tenantId, actorUserId: null, action: 'auth.sso.login_failed', targetType: 'tenant', targetId: tenantId, metadata: { reason, ...extra } }))
      .catch(() => undefined)
  }

  const view = (r: IdpRow): IdpConfigView => ({
    issuer: r.issuer, clientId: r.client_id, hasClientSecret: !!r.client_secret_sealed, allowedDomains: r.allowed_domains, enabled: r.enabled,
    emailClaim: r.email_claim, nameClaim: r.name_claim, emailVerifiedClaim: r.email_verified_claim, jitStudentProvisioning: r.jit_student_provisioning, updatedAt: r.updated_at,
  })

  async function getConfig(auth: SsoAdminContext): Promise<IdpConfigView | null> {
    return o.db.withTenant({ tenantId: auth.tenantId, userId: auth.userId, roles: auth.roles }, async (tx) => {
      const r = (await tx.query<IdpRow>('select * from platform.tenant_idp_configs')).rows[0]
      return r ? view(r) : null
    })
  }

  return {
    redirectUri,

    // ── tenant administration (RLS: own tenant only) ──

    getConfig,

    async setConfig(auth: SsoAdminContext, input: IdpConfigInput): Promise<IdpConfigView> {
      if (!input || typeof input !== 'object') throw badRequest('body_required', 'Configuration required')
      const current = await getConfig(auth)
      const issuer = (input.issuer ?? current?.issuer ?? '').trim()
      const clientId = (input.clientId ?? current?.clientId ?? '').trim()
      if (!issuer || !clientId) throw badRequest('fields_required', 'issuer and clientId are required')
      try {
        const u = new URL(issuer)
        if (u.search || u.hash) throw new Error('query')
      } catch { throw badRequest('issuer_invalid', 'issuer must be a URL without query or fragment') }
      await client.checkUrl(issuer, 'issuer').catch((e: AppError) => { throw badRequest(e.code, e.message) })
      if (clientId.length > 512) throw badRequest('client_id_invalid', 'clientId is too long')
      const domains = (input.allowedDomains ?? current?.allowedDomains ?? []).map((d) => String(d).trim().toLowerCase())
      if (domains.some((d) => !DOMAIN.test(d))) throw badRequest('domains_invalid', 'allowedDomains must be domain names')
      const claims = {
        email: input.emailClaim ?? current?.emailClaim ?? 'email',
        name: input.nameClaim ?? current?.nameClaim ?? 'name',
        verified: input.emailVerifiedClaim ?? current?.emailVerifiedClaim ?? 'email_verified',
      }
      if (!Object.values(claims).every((c) => CLAIM.test(c))) throw badRequest('claim_invalid', 'Claim names must be simple identifiers')
      const enabled = input.enabled ?? current?.enabled ?? false
      const jit = input.jitStudentProvisioning ?? current?.jitStudentProvisioning ?? false
      if (input.clientSecret !== undefined && input.clientSecret !== null && (typeof input.clientSecret !== 'string' || !input.clientSecret || input.clientSecret.length > 4096)) {
        throw badRequest('client_secret_invalid', 'clientSecret must be a non-empty string')
      }
      if (enabled) {
        if (!domains.length) throw badRequest('domains_required', 'At least one allowed email domain is required to enable SSO')
        // fail fast on a wrong issuer: discovery must succeed and match exactly
        await client.discover(issuer, { fresh: true }).catch((e: AppError) => { throw badRequest(e.code, e.message) })
      }
      const sealed = input.clientSecret === undefined ? undefined : input.clientSecret === null ? null : await o.sealer.seal(input.clientSecret, ctx(auth.tenantId))
      return o.db.withTenant({ tenantId: auth.tenantId, userId: auth.userId, roles: auth.roles }, async (tx) => {
        const r = await tx.query<IdpRow>(
          `insert into platform.tenant_idp_configs as c (tenant_id, issuer, client_id, client_secret_sealed, allowed_domains, enabled, email_claim, name_claim, email_verified_claim, jit_student_provisioning, updated_by)
           values (platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           on conflict (tenant_id) do update set issuer = excluded.issuer, client_id = excluded.client_id,
             client_secret_sealed = case when $11 then excluded.client_secret_sealed else c.client_secret_sealed end,
             allowed_domains = excluded.allowed_domains, enabled = excluded.enabled, email_claim = excluded.email_claim, name_claim = excluded.name_claim,
             email_verified_claim = excluded.email_verified_claim, jit_student_provisioning = excluded.jit_student_provisioning, updated_by = excluded.updated_by, updated_at = now()
           returning *`,
          [issuer, clientId, sealed ?? null, domains, enabled, claims.email, claims.name, claims.verified, jit, auth.userId, sealed !== undefined],
        )
        await recordAudit(tx, auth, {
          action: 'sso.config_updated', targetType: 'tenant', targetId: auth.tenantId,
          metadata: { issuer, enabled, allowedDomains: domains, jitStudentProvisioning: jit, secretChanged: sealed !== undefined },
        })
        return view(r.rows[0]!)
      })
    },

    /** Check the stored configuration against the IdP (discovery + JWKS reachability). Never returns secrets. */
    async testConfig(auth: SsoAdminContext): Promise<{ ok: boolean; code?: string; message?: string; authorizationEndpoint?: string; tokenEndpoint?: string }> {
      const cfg = await getConfig(auth)
      if (!cfg) return { ok: false, code: 'sso_not_configured', message: 'No identity provider configured' }
      try {
        const doc = await client.discover(cfg.issuer, { fresh: true })
        await client.checkUrl(doc.jwks_uri, 'jwks_uri')
        const r = await (o.oidc?.fetch ?? fetch)(doc.jwks_uri, { signal: AbortSignal.timeout(10_000), redirect: 'error' })
        const jwks = (await r.json().catch(() => null)) as { keys?: unknown[] } | null
        if (!r.ok || !Array.isArray(jwks?.keys) || !jwks.keys.length) return { ok: false, code: 'oidc_jwks_unusable', message: 'JWKS could not be loaded' }
        return { ok: true, authorizationEndpoint: doc.authorization_endpoint, tokenEndpoint: doc.token_endpoint }
      } catch (e) {
        const err = e as AppError
        return { ok: false, code: err.code ?? 'oidc_error', message: err instanceof AppError ? err.message : 'Identity provider check failed' }
      }
    },

    // ── sign-in ──

    /** Begin sign-in for a tenant: stores state/nonce/PKCE server-side and returns the IdP redirect. */
    async start(input: { tenantSlug: string; returnTo?: string | null }): Promise<SsoStartResult> {
      const row = (await o.system.query<IdpRow & { tenant_active: boolean }>(
        `select c.*, (t.status = 'active') as tenant_active from platform.tenants t join platform.tenant_idp_configs c on c.tenant_id = t.id where t.slug = $1`,
        [input.tenantSlug],
      )).rows[0]
      if (!row || !row.enabled || !row.tenant_active) {
        counter('auth_sso_total', { outcome: 'not_available' }).inc()
        return { kind: 'error', code: 'sso_not_available', location: errorLocation('sso_not_available') }
      }
      const recent = (await o.system.query<{ n: number }>(
        `select count(*)::int as n from platform.sso_login_states where tenant_id = $1 and created_at > now() - interval '1 minute'`, [row.tenant_id],
      )).rows[0]!.n
      if (recent >= perTenant) {
        await auditFailure(row.tenant_id, 'rate_limited')
        return { kind: 'error', code: 'rate_limited', location: errorLocation('rate_limited') }
      }
      let doc
      try {
        doc = await client.discover(row.issuer)
      } catch (e) {
        await auditFailure(row.tenant_id, (e as AppError).code ?? 'idp_error')
        return { kind: 'error', code: 'idp_error', location: errorLocation('idp_error') }
      }
      const state = randomToken(32)
      const nonce = randomToken(32)
      const verifier = randomToken(48)
      const binder = randomToken(32)
      await o.system.query(`delete from platform.sso_login_states where expires_at < now() - interval '1 hour'`)
      await o.system.query(
        'insert into platform.sso_login_states (state_hash, tenant_id, binder_hash, nonce, code_verifier, return_to, expires_at) values ($1, $2, $3, $4, $5, $6, $7)',
        [sha256(state), row.tenant_id, sha256(binder), nonce, verifier, safeReturnTo(input.returnTo), new Date(Date.now() + stateTtl)],
      )
      const u = new URL(doc.authorization_endpoint)
      for (const [k, v] of Object.entries({
        response_type: 'code', client_id: row.client_id, redirect_uri: redirectUri, scope: 'openid email profile',
        state, nonce, code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256',
      })) u.searchParams.set(k, v)
      counter('auth_sso_total', { outcome: 'started' }).inc()
      return { kind: 'redirect', location: u.toString(), binder, binderMaxAgeSec: Math.ceil(stateTtl / 1000) }
    },

    /** Complete sign-in at the redirect URI. Never throws for user-facing failures; returns an error redirect. */
    async callback(input: { state?: string | null; code?: string | null; error?: string | null; binder?: string | null }): Promise<SsoCallbackResult> {
      const err = (tenantId: string | null, reason: string, userCode = reason, extra: Record<string, unknown> = {}) =>
        auditFailure(tenantId, reason, extra).then((): SsoCallbackResult => ({ kind: 'error', code: userCode, location: errorLocation(userCode) }))
      if (!input.state || input.state.length > 200) return err(null, 'state_invalid', 'sso_failed')
      // single use: consumed before anything else can fail
      const st = (await o.system.query<{ tenant_id: string; binder_hash: string; nonce: string; code_verifier: string; return_to: string | null }>(
        `update platform.sso_login_states set used_at = now() where state_hash = $1 and used_at is null and expires_at > now()
         returning tenant_id, binder_hash, nonce, code_verifier, return_to`,
        [sha256(input.state)],
      )).rows[0]
      if (!st) return err(null, 'state_invalid', 'sso_failed')
      if (!input.binder || !safeEqual(sha256(input.binder), st.binder_hash)) return err(st.tenant_id, 'state_not_bound', 'sso_failed')
      if (input.error) return err(st.tenant_id, 'idp_denied', 'idp_error', { idpError: String(input.error).slice(0, 64) })
      if (!input.code || input.code.length > 4096) return err(st.tenant_id, 'code_missing', 'sso_failed')
      const row = (await o.system.query<IdpRow & { tenant_active: boolean }>(
        `select c.*, (t.status = 'active') as tenant_active from platform.tenant_idp_configs c join platform.tenants t on t.id = c.tenant_id where c.tenant_id = $1`, [st.tenant_id],
      )).rows[0]
      if (!row || !row.enabled || !row.tenant_active) return err(st.tenant_id, 'sso_not_available')

      let claims: Record<string, unknown>
      try {
        const doc = await client.discover(row.issuer)
        const idToken = await client.exchangeCode(doc, { code: input.code, codeVerifier: st.code_verifier, redirectUri, clientId: row.client_id, clientSecret: await unsealSecret(row) })
        claims = await client.verifyIdToken(idToken, { issuer: row.issuer, clientId: row.client_id, nonce: st.nonce, jwksUri: doc.jwks_uri })
      } catch (e) {
        const code = e instanceof OidcError || e instanceof AppError ? e.code : 'idp_error'
        if (!(e instanceof AppError)) logger.warn('sso unexpected error', { tenantId: st.tenant_id, error: (e as Error)?.name })
        return err(st.tenant_id, code, 'idp_error')
      }

      const rawEmail = claims[row.email_claim]
      const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : ''
      if (!EMAIL.test(email)) return err(st.tenant_id, 'email_missing', 'email_not_verified')
      const verified = claims[row.email_verified_claim]
      if (verified !== true && verified !== 'true') return err(st.tenant_id, 'email_not_verified')
      const domain = email.slice(email.lastIndexOf('@') + 1)
      if (!row.allowed_domains.includes(domain)) return err(st.tenant_id, 'domain_not_allowed', 'domain_not_allowed', { domain })
      const name = typeof claims[row.name_claim] === 'string' ? (claims[row.name_claim] as string).slice(0, 200) : ''

      type Out = { kind: 'session'; token: string; expiresAt: Date; userId: string } | { kind: 'attest'; token: string } | { kind: 'deny'; reason: string; code: string }
      const out = await o.system.tx(async (tx): Promise<Out> => {
        let m = (await tx.query<{ user_id: string; status: string | null; age_attestation: string | null }>(
          `select u.id as user_id, m.status, u.age_attestation from platform.users u
           left join platform.memberships m on m.user_id = u.id and m.tenant_id = $2 where u.email = $1`,
          [email, st.tenant_id],
        )).rows[0]
        if (!m?.status) {
          if (!row.jit_student_provisioning) return { kind: 'deny', reason: 'not_a_member', code: 'not_a_member' }
          const userId = (await tx.query<{ id: string }>(
            `insert into platform.users (id, email, display_name) values ($1, $2, $3)
             on conflict (email) do update set display_name = platform.users.display_name returning id`,
            [newId(), email, name],
          )).rows[0]!.id
          await tx.query(`insert into platform.memberships (tenant_id, user_id, roles) values ($1, $2, '{student}')`, [st.tenant_id, userId])
          await recordSystemAudit(tx, { tenantId: st.tenant_id, actorUserId: userId, action: 'member.provisioned_jit', targetType: 'user', targetId: userId, metadata: { roles: ['student'], via: 'sso' } })
          m = { user_id: userId, status: 'active', age_attestation: (await tx.query<{ age_attestation: string | null }>('select age_attestation from platform.users where id = $1', [userId])).rows[0]!.age_attestation }
        }
        if (m.status !== 'active') return { kind: 'deny', reason: 'membership_disabled', code: 'not_a_member' }
        if (m.age_attestation === 'minor') return { kind: 'deny', reason: 'age_restricted', code: 'age_restricted' }
        if (!m.age_attestation) {
          // PD-09: hand over to the existing attestation step via a single-use login token
          const token = randomToken(32)
          await tx.query('insert into platform.login_tokens (token_hash, tenant_id, user_id, expires_at) values ($1, $2, $3, $4)', [
            sha256(token), st.tenant_id, m.user_id, new Date(Date.now() + loginTokenTtl),
          ])
          await recordSystemAudit(tx, { tenantId: st.tenant_id, actorUserId: m.user_id, action: 'auth.sso.attestation_required', targetType: 'user', targetId: m.user_id })
          return { kind: 'attest', token }
        }
        const token = randomToken(32)
        const sessionId = newId()
        const expiresAt = new Date(Date.now() + sessionTtl)
        await tx.query('insert into platform.sessions (id, tenant_id, user_id, token_hash, expires_at) values ($1, $2, $3, $4, $5)', [
          sessionId, st.tenant_id, m.user_id, sha256(token), expiresAt,
        ])
        await recordSystemAudit(tx, { tenantId: st.tenant_id, actorUserId: m.user_id, action: 'auth.sso.login_succeeded', targetType: 'session', targetId: sessionId, metadata: { issuer: row.issuer } })
        await recordSystemAudit(tx, { tenantId: st.tenant_id, actorUserId: m.user_id, action: 'session.created', targetType: 'session', targetId: sessionId })
        return { kind: 'session', token, expiresAt, userId: m.user_id }
      })
      if (out.kind === 'deny') return err(st.tenant_id, out.reason, out.code)
      if (out.kind === 'attest') {
        counter('auth_sso_total', { outcome: 'attestation_required' }).inc()
        return { kind: 'attestation', location: `${base}/auth/verify#token=${out.token}&sso=1` }
      }
      counter('auth_sso_total', { outcome: 'ok' }).inc()
      return { kind: 'session', location: `${base}${st.return_to ?? '/'}`, sessionToken: out.token, expiresAt: out.expiresAt, userId: out.userId, tenantId: st.tenant_id }
    },
  }
}
export type SsoService = ReturnType<typeof createSsoService>

/** Fixed-window in-memory limiter (per process) for unauthenticated endpoints, keyed e.g. by client IP. */
export function createRateLimiter(opts: { limit: number; windowMs: number }) {
  const hits = new Map<string, { n: number; until: number }>()
  return {
    take(key: string): boolean {
      const t = Date.now()
      if (hits.size > 10_000) for (const [k, v] of hits) if (v.until <= t) hits.delete(k)
      const h = hits.get(key)
      if (!h || h.until <= t) { hits.set(key, { n: 1, until: t + opts.windowMs }); return true }
      h.n++
      return h.n <= opts.limit
    },
  }
}
