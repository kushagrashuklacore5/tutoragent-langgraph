import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import { AppError } from '@platform/core'
import { baseMigrations, type Database, type MigrationSet } from '@platform/tenancy-db'
import { definePlatformPermissions, identityMigrations, PermissionRegistry } from '@platform/identity'
import { auditMigrations, recordAudit } from '@platform/audit'
import { enqueue, jobsMigrations, type JobHandler, type ScheduleDef } from '@platform/jobs'
import { fieldCryptoMigrations, type FieldCrypto } from '@platform/field-crypto'
import { EventBus } from '@platform/events'
import { aiGatewayMigrations, GatewayError, TaskRegistry, type Gateway } from '@platform/ai-gateway'
import { validateManifest, type ModuleDeps, type ModuleManifest, type RouteDef } from '@platform/contracts'
import { documentsMigrations, type DocumentRow, type DocumentService } from '@platform/documents'
import { EMBED_TASK_ID, embeddingTask, ingestionJob, retrievalMigrations, type Retrieval } from '@platform/retrieval'
import type { DocumentInfo, MathChecker, ModuleDocuments, ModuleRetrieval } from '@platform/contracts'
export { createFieldCrypto, type FieldCrypto } from '@platform/field-crypto'

/** Document + retrieval access scoped to one module: it can only see and change its own documents. */
function moduleDocumentAccess(moduleId: string, docs: DocumentService, rt: Retrieval): { documents: ModuleDocuments; retrieval: ModuleRetrieval } {
  type P = { tenantId: string; userId?: string; roles?: string[] }
  const principal = (p: P) => {
    if (!p.userId) throw new AppError('unauthorized', 'A user is required', { status: 401 })
    return { tenantId: p.tenantId, userId: p.userId, roles: p.roles }
  }
  const info = (d: DocumentRow): DocumentInfo => ({
    id: d.id, filename: d.filename, kind: d.kind, status: d.status, error: d.error, page_count: d.page_count, locator_kind: d.locator_kind, version: d.version,
    supersedes: d.supersedes, trust: d.trust, visibility: d.visibility, scope: d.scope, owner_user_id: d.owner_user_id, created_at: d.created_at, size_bytes: d.size_bytes,
  })
  const own = async (p: P, id: string) => {
    const d = await docs.get(principal(p), id)
    if (d.owner_module !== moduleId) throw new AppError('not_found', 'Document not found', { status: 404 })
    return d
  }
  return {
    documents: {
      upload: async (p, input) => info(await docs.upload(principal(p), { ...input, ownerModule: moduleId })),
      list: async (p, scope) => (await docs.list(principal(p), { ownerModule: moduleId, scope })).map(info),
      get: async (p, id) => info(await own(p, id)),
      page: async (p, id, n) => {
        await own(p, id)
        const r = await docs.page(principal(p), id, n)
        return { document: info(r.document), text: r.text }
      },
      delete: async (p, id) => { await own(p, id); await docs.delete(principal(p), id) },
      reprocess: async (p, id) => { await own(p, id); await docs.reprocess(principal(p), id) },
    },
    retrieval: { search: (p, q) => rt.search(principal(p), { ...q, ownerModule: moduleId }) },
  }
}

export const PLATFORM_MIGRATIONS: MigrationSet[] = [baseMigrations, identityMigrations, auditMigrations, jobsMigrations, aiGatewayMigrations, documentsMigrations, retrievalMigrations, fieldCryptoMigrations]

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
  /** recurring jobs declared by modules (namespaced), for the worker's scheduler */
  schedules: ScheduleDef[]
}

/**
 * Register everything the enabled modules declare. A module that is absent simply contributes
 * nothing: no routes, permissions, jobs, subscriptions, UI entries or AI tasks.
 */
export function buildPlatform(modules: ModuleManifest[], o: { db: Database; gateway: () => Gateway; tasks?: TaskRegistry; documents?: DocumentService; retrieval?: Retrieval; embeddingDimensions?: number; crypto?: FieldCrypto; math?: MathChecker; checkpointer?: BaseCheckpointSaver }): Platform {
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
    checkpointer: o.checkpointer,
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
        transcribe: (taskId, input, ctx) => (own(taskId), o.gateway().transcribe(taskId, input, { tenantId: p.tenantId, userId: p.userId, ...ctx })),
        synthesize: (taskId, input, ctx) => (own(taskId), o.gateway().synthesize(taskId, input, { tenantId: p.tenantId, userId: p.userId, ...ctx })),
        synthesizeStream: (taskId, input, ctx) => (own(taskId), o.gateway().synthesizeStream(taskId, input, { tenantId: p.tenantId, userId: p.userId, ...ctx })),
      }
    },
    ...(o.documents && o.retrieval ? moduleDocumentAccess(moduleId, o.documents, o.retrieval) : {}),
    ...(o.math ? { math: o.math } : {}),
    ...(o.crypto ? { crypto: moduleCrypto(moduleId, o.crypto) } : {}),
  })
  if (o.documents && o.retrieval && !tasks.get(EMBED_TASK_ID)) tasks.register(embeddingTask(o.embeddingDimensions ?? 1024))

  const routes: MountedRoute[] = []
  const jobs = new Map<string, JobHandler>()
  const ui: Platform['ui'] = []
  const nav: Platform['nav'] = []
  const schedules: ScheduleDef[] = []

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
    for (const s of m.schedules ?? []) {
      if (!jobs.has(`${m.id}/${s.job}`)) throw new AppError('schedule_job_unknown', `${m.id} schedule ${s.name} references unknown job ${s.job}`)
      schedules.push({ name: `${m.id}/${s.name}`, jobType: `${m.id}/${s.job}`, spec: s.spec, payload: s.payload, perTenant: s.perTenant ? { requireModule: m.id } : undefined })
    }
    for (const s of m.events?.subscribes ?? []) events.subscribe(s.topic, m.id, s.handler(deps), { optional: s.optional })
    for (const r of m.ui?.routes ?? []) ui.push({ moduleId: m.id, ...r })
    for (const n of m.ui?.nav ?? []) nav.push({ moduleId: m.id, ...n })
  }
  if (o.documents && o.retrieval) {
    const ing = ingestionJob(o.documents, o.retrieval)
    jobs.set(ing.type, ing.handler as JobHandler)
  }
  const missing = events.unresolved().filter((u) => !u.optional)
  if (missing.length) throw new AppError('event_subscription_unresolved', `Required event subscriptions without publisher: ${missing.map((x) => `${x.subscriber}<-${x.topic}`).join(', ')}`)
  for (const [k, h] of events.jobHandlers()) jobs.set(k, h)

  return { modules, permissions, tasks, events, routes, jobs, ui, nav, depsFor, schedules }
}

/** Field encryption for one module: the module id is bound into every ciphertext's AAD (via the table name). */
function moduleCrypto(moduleId: string, fc: FieldCrypto): NonNullable<ModuleDeps['crypto']> {
  const ref = (f: { table: string; column: string; recordId: string }) => ({ ...f, table: `${moduleId}:${f.table}` })
  return {
    encrypt: (p, f, plaintext) => fc.encrypt(p.tenantId, ref(f), plaintext),
    decrypt: (p, f, ciphertext) => fc.decrypt(p.tenantId, ref(f), ciphertext),
  }
}
