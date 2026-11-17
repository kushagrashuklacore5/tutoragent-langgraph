import { AppError, badRequest, forbidden, unauthorized, type Environment } from '@platform/core'
import { renderPrometheus } from '@platform/observability'
import type { Database } from '@platform/tenancy-db'
import type { SystemDatabase } from '@platform/tenancy-db/system'
import { createIdentityService, type AuthContext, type MailTransport } from '@platform/identity'
import { listAudit } from '@platform/audit'
import { ADAPTERS, createGateway, type Actor, type Gateway, type KeyManager } from '@platform/ai-gateway'
import type { ModuleManifest, Principal } from '@platform/contracts'
import type { ProviderAdapter } from '@platform/ai-adapter-kit'
import { buildPlatform, type Platform } from '@platform/module-runtime'
import { createRouter, type HttpRoute, type ParsedRequest } from './http.ts'

export interface AppOptions {
  env: Environment
  db: Database
  system: SystemDatabase
  keyManager: KeyManager
  mail: MailTransport
  publicBaseUrl: string
  allowedOrigins: string[]
  modules: ModuleManifest[]
  /** defaults to the generated adapter registry; tests may add fakes */
  adapters?: Record<string, ProviderAdapter>
  metricsToken?: string
  /** cache for per-tenant module enablement (ms); 0 disables */
  moduleCacheMs?: number
}

const COOKIE = 'ebs'
type CreateConnection = Parameters<Gateway['admin']['createConnection']>[1]
type SetRoute = Parameters<Gateway['admin']['setRoute']>[1]

/** Build the HTTP application from platform services + enabled modules. No I/O happens until requests arrive. */
export function createApp(o: AppOptions) {
  let gateway: Gateway
  const platform: Platform = buildPlatform(o.modules, { db: o.db, gateway: () => gateway })
  gateway = createGateway({ system: o.system, keyManager: o.keyManager, environment: o.env, adapters: o.adapters ?? ADAPTERS, tasks: platform.tasks })
  const identity = createIdentityService({ system: o.system, db: o.db, mail: o.mail, publicBaseUrl: o.publicBaseUrl })

  const enabledCache = new Map<string, { mods: Set<string>; until: number }>()
  async function tenantModuleEnabled(tenantId: string, moduleId: string): Promise<boolean> {
    const c = enabledCache.get(tenantId)
    if (c && c.until > Date.now()) return c.mods.has(moduleId)
    const r = await o.system.query<{ enabled_modules: string[] }>('select enabled_modules from platform.tenants where id = $1', [tenantId])
    const mods = new Set(r.rows[0]?.enabled_modules ?? [])
    enabledCache.set(tenantId, { mods, until: Date.now() + (o.moduleCacheMs ?? 10_000) })
    return mods.has(moduleId)
  }

  async function authenticate(req: ParsedRequest): Promise<AuthContext> {
    const h = req.raw.headers.authorization
    const bearer = h?.startsWith('Bearer ') ? h.slice(7) : undefined
    const token = bearer ?? req.cookies[COOKIE]
    const auth = await identity.resolveSession(token)
    if (!auth) throw unauthorized()
    // CSRF: cookie-authenticated state changes must come from an allowed origin
    if (!bearer && req.method !== 'GET') {
      const origin = req.raw.headers.origin
      if (!origin || ![...o.allowedOrigins, new URL(o.publicBaseUrl).origin].includes(origin)) throw forbidden('Cross-site request rejected')
    }
    return auth
  }
  const actorOf = (a: AuthContext): Actor => ({ userId: a.userId, tenantId: a.tenantId, isPlatformAdmin: a.isPlatformAdmin, roles: a.roles })
  const principalOf = (a: AuthContext): Principal => ({ userId: a.userId, tenantId: a.tenantId, email: a.email, roles: a.roles, isPlatformAdmin: a.isPlatformAdmin })

  /** Wrap a handler with authentication + permission check. Every non-public route must declare a permission. */
  const secured = (method: string, path: string, permission: string, moduleId: string | null, fn: (req: ParsedRequest, auth: AuthContext) => Promise<unknown>): HttpRoute => ({
    method, path, permission, moduleId,
    handler: async (req) => {
      const auth = await authenticate(req)
      platform.permissions.assert(auth, permission)
      if (moduleId && !(await tenantModuleEnabled(auth.tenantId, moduleId))) throw new AppError('not_found', 'Not found', { status: 404 })
      return fn(req, auth)
    },
  })
  const pub = (method: string, path: string, fn: (req: ParsedRequest) => Promise<unknown>): HttpRoute => ({ method, path, permission: 'public', moduleId: null, handler: fn })
  const body = <T>(req: ParsedRequest): T => {
    if (!req.body || typeof req.body !== 'object') throw badRequest('body_required', 'JSON body required')
    return req.body as T
  }

  const routes: HttpRoute[] = [
    pub('GET', '/health', async () => ({ status: 'ok' })),
    pub('GET', '/metrics', async (req) => {
      if (o.env === 'production' && req.raw.headers.authorization !== `Bearer ${o.metricsToken ?? '§'}`) throw unauthorized()
      req.res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(renderPrometheus())
    }),

    // ── auth ──
    pub('POST', '/api/auth/magic-link', async (req) => {
      const b = body<{ tenantSlug?: string; email?: string }>(req)
      if (!b.tenantSlug || !b.email) throw badRequest('fields_required', 'tenantSlug and email are required')
      await identity.requestMagicLink({ tenantSlug: b.tenantSlug, email: b.email })
      return { status: 'sent_if_member' }
    }),
    pub('POST', '/api/auth/verify', async (req) => {
      const b = body<{ token?: string; ageAttestation?: 'adult' | 'minor' }>(req)
      const s = await identity.verifyMagicLink({ token: b.token ?? '', ageAttestation: b.ageAttestation })
      const secure = o.publicBaseUrl.startsWith('https') ? '; Secure' : ''
      req.res.setHeader('set-cookie', `${COOKIE}=${s.sessionToken}; HttpOnly; SameSite=Lax; Path=/; Expires=${s.expiresAt.toUTCString()}${secure}`)
      return { expiresAt: s.expiresAt, sessionToken: s.sessionToken }
    }),
    secured('POST', '/api/auth/logout', 'platform:session.read', null, async (req) => {
      const h = req.raw.headers.authorization
      await identity.logout(h?.startsWith('Bearer ') ? h.slice(7) : req.cookies[COOKIE] ?? '')
      req.res.setHeader('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`)
    }),
    secured('GET', '/api/me', 'platform:session.read', null, async (_r, a) => ({ userId: a.userId, tenantId: a.tenantId, email: a.email, roles: a.roles, isPlatformAdmin: a.isPlatformAdmin })),
    secured('GET', '/api/platform/modules', 'platform:session.read', null, async (_r, a) => {
      const visible = (perm: string) => platform.permissions.allows(a, perm)
      const enabled: string[] = []
      for (const m of platform.modules) if (await tenantModuleEnabled(a.tenantId, m.id)) enabled.push(m.id)
      return {
        modules: enabled,
        ui: platform.ui.filter((u) => enabled.includes(u.moduleId) && visible(u.permission)),
        nav: platform.nav.filter((n) => enabled.includes(n.moduleId) && visible(n.permission)),
      }
    }),

    // ── members & audit ──
    secured('GET', '/api/members', 'platform:members.read', null, async (_r, a) => identity.listMembers(a)),
    secured('POST', '/api/members', 'platform:members.manage', null, async (req, a) => identity.upsertMember(a, body(req))),
    secured('POST', '/api/members/:userId/disable', 'platform:members.manage', null, async (req, a) => identity.disableMember(a, req.params.userId!)),
    secured('GET', '/api/audit', 'platform:audit.read', null, async (req, a) =>
      o.db.withTenant({ tenantId: a.tenantId, userId: a.userId, roles: a.roles }, (tx) => listAudit(tx, { limit: Number(req.query.get('limit') ?? 50) }))),

    // ── AI administration (platform scope needs platform admin; tenant scope = BYOK, tenant admin) ──
    secured('GET', '/api/admin/ai/adapters', 'platform:ai.admin', null, async () => gateway.admin.adapters()),
    secured('GET', '/api/admin/ai/connections', 'platform:ai.admin', null, async (_r, a) => gateway.admin.listConnections(actorOf(a), null)),
    secured('POST', '/api/admin/ai/connections', 'platform:ai.admin', null, async (req, a) => gateway.admin.createConnection(actorOf(a), { ...body<CreateConnection>(req), tenantId: null })),
    secured('POST', '/api/admin/ai/connections/:id/test', 'platform:ai.admin', null, async (req, a) => gateway.admin.testConnection(actorOf(a), req.params.id!)),
    secured('POST', '/api/admin/ai/connections/:id/discover', 'platform:ai.admin', null, async (req, a) => gateway.admin.discoverModels(actorOf(a), req.params.id!)),
    secured('POST', '/api/admin/ai/connections/:id/rotate-key', 'platform:ai.admin', null, async (req, a) => gateway.admin.rotateKey(actorOf(a), req.params.id!, body<{ apiKey: string }>(req).apiKey)),
    secured('POST', '/api/admin/ai/connections/:id/enabled', 'platform:ai.admin', null, async (req, a) => gateway.admin.setConnectionEnabled(actorOf(a), req.params.id!, !!body<{ enabled: boolean }>(req).enabled)),
    secured('POST', '/api/admin/ai/models/approve', 'platform:ai.admin', null, async (req, a) => gateway.admin.approveModel(actorOf(a), body(req))),
    secured('POST', '/api/admin/ai/deployments', 'platform:ai.admin', null, async (req, a) => gateway.admin.createDeployment(actorOf(a), body(req))),
    secured('POST', '/api/admin/ai/deployments/:id/probe', 'platform:ai.admin', null, async (req, a) => gateway.admin.probeDeployment(actorOf(a), req.params.id!)),
    secured('PUT', '/api/admin/ai/routes', 'platform:ai.admin', null, async (req, a) => gateway.admin.setRoute(actorOf(a), { ...body<SetRoute>(req), tenantId: null })),
    secured('POST', '/api/admin/ai/eval-standings', 'platform:ai.admin', null, async (req, a) => gateway.admin.recordEvalStanding(actorOf(a), body(req))),
    secured('GET', '/api/admin/ai/tasks', 'platform:ai.admin', null, async () => platform.tasks.list()),
    // tenant-scoped (BYOK) — only when the tenant policy enables it
    secured('GET', '/api/ai/connections', 'platform:ai.connections.tenant', null, async (_r, a) => gateway.admin.listConnections(actorOf(a), a.tenantId)),
    secured('POST', '/api/ai/connections', 'platform:ai.connections.tenant', null, async (req, a) => gateway.admin.createConnection(actorOf(a), { ...body<CreateConnection>(req), tenantId: a.tenantId, allowPrivateNetwork: false })),
    secured('PUT', '/api/ai/routes', 'platform:ai.connections.tenant', null, async (req, a) => gateway.admin.setRoute(actorOf(a), { ...body<SetRoute>(req), tenantId: a.tenantId })),
    secured('GET', '/api/ai/usage', 'platform:ai.usage.read', null, async (req, a) =>
      gateway.admin.usage(actorOf(a), a.tenantId, new Date(req.query.get('from') ?? Date.now() - 30 * 86_400_000), new Date(req.query.get('to') ?? Date.now() + 60_000))),
  ]

  // ── module routes, mounted under /api/m/<module-id> ──
  for (const r of platform.routes) {
    routes.push(secured(r.method, r.fullPath, r.permission, r.moduleId, async (req, a) =>
      r.handler({ principal: principalOf(a), params: req.params, query: req.query, body: req.body, signal: req.signal })))
  }

  for (const r of routes) if (r.permission !== 'public' && !platform.permissions.has(r.permission)) throw new AppError('route_permission_unknown', `${r.method} ${r.path} uses unknown permission ${r.permission}`)

  return {
    handler: createRouter(routes, { allowedOrigins: o.allowedOrigins }),
    routes,
    platform,
    gateway,
    identity,
    /** snapshot used by removal tests */
    routeTable: () => routes.map((r) => `${r.method} ${r.path} [${r.permission}]`).sort(),
  }
}
export type App = ReturnType<typeof createApp>
