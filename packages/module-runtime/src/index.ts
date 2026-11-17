import { AppError } from '@platform/core'
import { baseMigrations, type Database, type MigrationSet } from '@platform/tenancy-db'
import { definePlatformPermissions, identityMigrations, PermissionRegistry } from '@platform/identity'
import { auditMigrations, recordAudit } from '@platform/audit'
import { enqueue, jobsMigrations, type JobHandler } from '@platform/jobs'
import { EventBus } from '@platform/events'
import { aiGatewayMigrations, GatewayError, TaskRegistry, type Gateway } from '@platform/ai-gateway'
import { validateManifest, type ModuleDeps, type ModuleManifest, type RouteDef } from '@platform/contracts'

export const PLATFORM_MIGRATIONS: MigrationSet[] = [baseMigrations, identityMigrations, auditMigrations, jobsMigrations, aiGatewayMigrations]

export function migrationSetsFor(modules: ModuleManifest[]): MigrationSet[] {
  return [
    ...PLATFORM_MIGRATIONS,
    ...modules.filter((m) => m.db).map((m) => ({ owner: m.id, schema: m.db!.schema, dir: m.db!.migrationsDir })),
  ]
}

export interface MountedRoute extends RouteDef {
  moduleId: string
  fullPath: string
}

export interface Platform {
  modules: ModuleManifest[]
  permissions: PermissionRegistry
  tasks: TaskRegistry
  events: EventBus
  routes: MountedRoute[]
  jobs: Map<string, JobHandler>
  ui: { moduleId: string; path: string; title: string; permission: string }[]
  nav: { moduleId: string; label: string; path: string; permission: string }[]
  depsFor(moduleId: string): ModuleDeps
}

/**
 * Register everything the enabled modules declare. A module that is absent simply contributes
 * nothing: no routes, permissions, jobs, subscriptions, UI entries or AI tasks.
 */
export function buildPlatform(modules: ModuleManifest[], o: { db: Database; gateway: () => Gateway; tasks?: TaskRegistry }): Platform {
  const ids = new Set<string>()
  for (const m of modules) {
    validateManifest(m)
    if (ids.has(m.id)) throw new AppError('module_duplicate', `Module ${m.id} registered twice`)
    ids.add(m.id)
  }
  const permissions = new PermissionRegistry()
  definePlatformPermissions(permissions)
  const tasks = o.tasks ?? new TaskRegistry()
  const events = new EventBus()

  const depsFor = (moduleId: string): ModuleDeps => ({
    db: o.db,
    inTenant: (p, fn) => o.db.withTenant({ tenantId: p.tenantId, userId: p.userId, roles: p.roles }, fn),
    enqueue: (tx, jobName, payload, opts) => enqueue(tx, `${moduleId}/${jobName}`, payload, opts),
    publish: (tx, topic, payload) => {
      if (!topic.startsWith(`${moduleId}.`)) throw new AppError('event_namespace', `${moduleId} may only publish its own topics`)
      return events.publish(tx, topic, payload)
    },
    audit: (tx, p, e) => recordAudit(tx, p, { ...e, action: `${moduleId}.${e.action}` }),
    ai: (p) => {
      const own = (taskId: string) => {
        if (!taskId.startsWith(`${moduleId}.`)) throw new GatewayError('unknown_task', `${moduleId} may only call its own AI tasks`)
      }
      return {
        run: (taskId, input, ctx) => (own(taskId), o.gateway().run(taskId, input, { tenantId: p.tenantId, userId: p.userId, ...ctx })),
        stream: (taskId, input, ctx) => (own(taskId), o.gateway().stream(taskId, input, { tenantId: p.tenantId, userId: p.userId, ...ctx })),
        embed: (taskId, inputs, purpose) => (own(taskId), o.gateway().embed(taskId, inputs, { tenantId: p.tenantId, userId: p.userId }, purpose)),
      }
    },
  })

  const routes: MountedRoute[] = []
  const jobs = new Map<string, JobHandler>()
  const ui: Platform['ui'] = []
  const nav: Platform['nav'] = []

  for (const m of modules) {
    for (const perm of m.permissions ?? []) permissions.define({ ...perm, owner: m.id })
    for (const t of m.ai?.tasks ?? []) tasks.register(t)
    for (const topic of m.events?.publishes ?? []) events.declarePublisher(topic)
  }
  for (const m of modules) {
    const deps = depsFor(m.id)
    for (const r of m.routes?.(deps) ?? []) {
      if (!permissions.has(r.permission)) throw new AppError('route_permission_unknown', `${m.id} ${r.method} ${r.path}: unknown permission ${r.permission}`)
      const ns = r.permission.split(':')[0]
      if (ns !== m.id && ns !== 'platform') throw new AppError('route_permission_foreign', `${m.id} may not use another module's permission ${r.permission}`)
      routes.push({ ...r, moduleId: m.id, fullPath: `/api/m/${m.id}${r.path}` })
    }
    for (const [name, h] of Object.entries(m.jobs?.(deps) ?? {})) jobs.set(`${m.id}/${name}`, h)
    for (const s of m.events?.subscribes ?? []) events.subscribe(s.topic, m.id, s.handler(deps), { optional: s.optional })
    for (const r of m.ui?.routes ?? []) ui.push({ moduleId: m.id, ...r })
    for (const n of m.ui?.nav ?? []) nav.push({ moduleId: m.id, ...n })
  }
  const missing = events.unresolved().filter((u) => !u.optional)
  if (missing.length) throw new AppError('event_subscription_unresolved', `Required event subscriptions without publisher: ${missing.map((x) => `${x.subscriber}<-${x.topic}`).join(', ')}`)
  for (const [k, h] of events.jobHandlers()) jobs.set(k, h)

  return { modules, permissions, tasks, events, routes, jobs, ui, nav, depsFor }
}
