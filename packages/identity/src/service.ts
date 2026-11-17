import { AppError, badRequest, forbidden, newId, randomToken, sha256, unauthorized } from '@platform/core'
import { counter } from '@platform/observability'
import type { Database, Sql } from '@platform/tenancy-db'
import type { SystemDatabase } from '@platform/tenancy-db/system'
import { recordAudit, recordSystemAudit } from '@platform/audit'
import type { MailTransport } from './mail.ts'
import { ROLES, type Role } from './permissions.ts'

export interface AuthContext {
  userId: string
  tenantId: string
  email: string
  roles: string[]
  isPlatformAdmin: boolean
  sessionId: string
}

export interface IdentityOptions {
  system: SystemDatabase
  db: Database
  mail: MailTransport
  publicBaseUrl: string
  loginTokenTtlMs?: number
  sessionTtlMs?: number
  /** max magic links per user per 15 minutes */
  linkRateLimit?: number
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const normEmail = (e: string) => e.trim().toLowerCase()

export function createIdentityService(o: IdentityOptions) {
  const tokenTtl = o.loginTokenTtlMs ?? 15 * 60_000
  const sessionTtl = o.sessionTtlMs ?? 7 * 24 * 3_600_000
  const rate = o.linkRateLimit ?? 5

  return {
    /** Platform-admin / CLI operation: create an institution (or individual) tenant with its first admin. */
    async createTenant(input: { slug: string; name: string; type?: 'institution' | 'individual'; adminEmail: string; adminName?: string; policy?: Record<string, unknown> }) {
      const email = normEmail(input.adminEmail)
      if (!EMAIL.test(email)) throw badRequest('email_invalid', 'Invalid admin email')
      return o.system.tx(async (tx) => {
        const tenantId = newId()
        await tx.query('insert into platform.tenants (id, slug, name, type, policy) values ($1, $2, $3, $4, $5)', [
          tenantId, input.slug, input.name, input.type ?? 'institution', JSON.stringify(input.policy ?? {}),
        ]).catch((e: { code?: string }) => {
          if (e.code === '23505') throw new AppError('tenant_exists', 'Tenant slug already exists', { status: 409 })
          if (e.code === '23514') throw badRequest('tenant_slug_invalid', 'Slug must be lowercase letters, digits and dashes')
          throw e
        })
        const userId = await upsertUser(tx, email, input.adminName ?? '')
        await tx.query('insert into platform.memberships (tenant_id, user_id, roles) values ($1, $2, $3)', [tenantId, userId, ['tenant_admin']])
        await recordSystemAudit(tx, { tenantId, actorUserId: null, action: 'tenant.created', targetType: 'tenant', targetId: tenantId, metadata: { slug: input.slug } })
        return { tenantId, adminUserId: userId }
      })
    },

    /**
     * Start sign-in. Always resolves the same way whether or not the email is a member (no account
     * enumeration); only members get a link.
     */
    async requestMagicLink(input: { tenantSlug: string; email: string }): Promise<void> {
      const email = normEmail(input.email)
      if (!EMAIL.test(email)) throw badRequest('email_invalid', 'Invalid email')
      const r = await o.system.query<{ tenant_id: string; user_id: string; recent: number }>(
        `select t.id as tenant_id, u.id as user_id,
                (select count(*) from platform.login_tokens lt where lt.user_id = u.id and lt.created_at > now() - interval '15 minutes')::int as recent
         from platform.tenants t
         join platform.memberships m on m.tenant_id = t.id and m.status = 'active'
         join platform.users u on u.id = m.user_id
         where t.slug = $1 and t.status = 'active' and u.email = $2`,
        [input.tenantSlug, email],
      )
      const row = r.rows[0]
      if (!row) {
        counter('auth_magic_link_total', { outcome: 'unknown_member' }).inc()
        return
      }
      if (row.recent >= rate) {
        counter('auth_magic_link_total', { outcome: 'rate_limited' }).inc()
        return
      }
      const token = randomToken(32)
      await o.system.query('insert into platform.login_tokens (token_hash, tenant_id, user_id, expires_at) values ($1, $2, $3, $4)', [
        sha256(token), row.tenant_id, row.user_id, new Date(Date.now() + tokenTtl),
      ])
      const link = `${o.publicBaseUrl.replace(/\/$/, '')}/auth/verify#token=${token}`
      await o.mail.send({ to: email, subject: 'Your Ek Bharat.AI sign-in link', text: `Sign in: ${link}\nThis link expires in ${Math.round(tokenTtl / 60000)} minutes and works once.` })
      counter('auth_magic_link_total', { outcome: 'sent' }).inc()
    },

    /** Complete sign-in. Enforces single use, expiry and the adults-only pilot rule (PD-09). */
    async verifyMagicLink(input: { token: string; ageAttestation?: 'adult' | 'minor' }) {
      if (!input.token || input.token.length < 20) throw unauthorized('Invalid or expired link')
      // The transaction commits even when the user is age-restricted, so a recorded 'minor'
      // attestation (and the consumed link) persist; the rejection is raised after commit.
      const out = await o.system.tx(async (tx) => {
        const used = await tx.query<{ tenant_id: string; user_id: string }>(
          `update platform.login_tokens set used_at = now()
           where token_hash = $1 and used_at is null and expires_at > now()
           returning tenant_id, user_id`,
          [sha256(input.token)],
        )
        const t = used.rows[0]
        if (!t) throw unauthorized('Invalid or expired link')
        const u = (await tx.query<{ id: string; email: string; age_attestation: string | null; is_platform_admin: boolean }>(
          'select id, email, age_attestation, is_platform_admin from platform.users where id = $1', [t.user_id],
        )).rows[0]
        if (!u) throw unauthorized('Invalid or expired link')
        let attestation = u.age_attestation
        if (!attestation) {
          if (!input.ageAttestation) throw new AppError('age_attestation_required', 'Please confirm you are 18 or older', { status: 403 })
          attestation = input.ageAttestation
          await tx.query('update platform.users set age_attestation = $2, age_attested_at = now() where id = $1', [u.id, attestation])
          await recordSystemAudit(tx, { tenantId: t.tenant_id, actorUserId: u.id, action: 'user.age_attested', targetType: 'user', targetId: u.id, metadata: { attestation } })
        }
        if (attestation !== 'adult') return { restricted: true as const }
        const sessionToken = randomToken(32)
        const sessionId = newId()
        const expiresAt = new Date(Date.now() + sessionTtl)
        await tx.query('insert into platform.sessions (id, tenant_id, user_id, token_hash, expires_at) values ($1, $2, $3, $4, $5)', [
          sessionId, t.tenant_id, u.id, sha256(sessionToken), expiresAt,
        ])
        await recordSystemAudit(tx, { tenantId: t.tenant_id, actorUserId: u.id, action: 'session.created', targetType: 'session', targetId: sessionId })
        return { restricted: false as const, sessionToken, expiresAt, userId: u.id, tenantId: t.tenant_id }
      })
      if (out.restricted) {
        counter('auth_sign_in_total', { outcome: 'age_restricted' }).inc()
        throw new AppError('age_restricted', 'This pilot is available to students aged 18 and over', { status: 403 })
      }
      counter('auth_sign_in_total', { outcome: 'ok' }).inc()
      return { sessionToken: out.sessionToken, expiresAt: out.expiresAt, userId: out.userId, tenantId: out.tenantId }
    },

    /** Resolve a bearer/cookie session token to an auth context, or null if invalid. */
    async resolveSession(token: string | undefined): Promise<AuthContext | null> {
      if (!token || token.length < 20) return null
      const r = await o.system.query<{ id: string; tenant_id: string; user_id: string; email: string; roles: string[]; is_platform_admin: boolean }>(
        `select s.id, s.tenant_id, s.user_id, u.email, m.roles, u.is_platform_admin
         from platform.sessions s
         join platform.users u on u.id = s.user_id
         join platform.memberships m on m.tenant_id = s.tenant_id and m.user_id = s.user_id and m.status = 'active'
         join platform.tenants t on t.id = s.tenant_id and t.status = 'active'
         where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now() and u.age_attestation = 'adult'`,
        [sha256(token)],
      )
      const s = r.rows[0]
      if (!s) return null
      return { sessionId: s.id, tenantId: s.tenant_id, userId: s.user_id, email: s.email, roles: s.roles, isPlatformAdmin: s.is_platform_admin }
    },

    async logout(token: string): Promise<void> {
      await o.system.query('update platform.sessions set revoked_at = now() where token_hash = $1 and revoked_at is null', [sha256(token)])
    },

    /** Tenant admin: add or update a member. Runs under the caller's tenant (RLS) except the global user row. */
    async upsertMember(auth: AuthContext, input: { email: string; roles: Role[]; displayName?: string }) {
      const email = normEmail(input.email)
      if (!EMAIL.test(email)) throw badRequest('email_invalid', 'Invalid email')
      if (!input.roles.length || input.roles.some((r) => !ROLES.includes(r))) throw badRequest('roles_invalid', `Roles must be from ${ROLES.join(', ')}`)
      const userId = await o.system.tx((tx) => upsertUser(tx, email, input.displayName ?? ''))
      await o.db.withTenant({ tenantId: auth.tenantId, userId: auth.userId, roles: auth.roles }, async (tx) => {
        await tx.query(
          `insert into platform.memberships (tenant_id, user_id, roles) values (platform.current_tenant(), $1, $2)
           on conflict (tenant_id, user_id) do update set roles = excluded.roles, status = 'active'`,
          [userId, input.roles],
        )
        await recordAudit(tx, auth, { action: 'member.upserted', targetType: 'user', targetId: userId, metadata: { roles: input.roles } })
      })
      return { userId }
    },

    async listMembers(auth: AuthContext) {
      return o.db.withTenant({ tenantId: auth.tenantId, userId: auth.userId, roles: auth.roles }, async (tx) =>
        (await tx.query<{ user_id: string; email: string; roles: string[]; status: string }>(
          `select m.user_id, u.email, m.roles, m.status from platform.memberships m join platform.users u on u.id = m.user_id order by u.email`,
        )).rows,
      )
    },

    async disableMember(auth: AuthContext, userId: string) {
      if (userId === auth.userId) throw forbidden('You cannot disable yourself')
      await o.db.withTenant({ tenantId: auth.tenantId, userId: auth.userId, roles: auth.roles }, async (tx) => {
        await tx.query(`update platform.memberships set status = 'disabled' where user_id = $1`, [userId])
        await tx.query(`update platform.sessions set revoked_at = now() where user_id = $1 and revoked_at is null`, [userId]).catch(() => undefined)
        await recordAudit(tx, auth, { action: 'member.disabled', targetType: 'user', targetId: userId })
      })
      // sessions of the disabled user are not visible under the admin's RLS context; revoke via system
      await o.system.query('update platform.sessions set revoked_at = now() where tenant_id = $1 and user_id = $2 and revoked_at is null', [auth.tenantId, userId])
    },

    async setPlatformAdmin(email: string, value: boolean) {
      await o.system.query('update platform.users set is_platform_admin = $2 where email = $1', [normEmail(email), value])
    },
  }
}

async function upsertUser(tx: Sql, email: string, displayName: string): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `insert into platform.users (id, email, display_name) values ($1, $2, $3)
     on conflict (email) do update set display_name = case when excluded.display_name <> '' then excluded.display_name else platform.users.display_name end
     returning id`,
    [newId(), email, displayName],
  )
  return r.rows[0]!.id
}

export type IdentityService = ReturnType<typeof createIdentityService>
