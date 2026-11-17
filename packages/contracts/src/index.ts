import { AppError } from '@platform/core'
import type { Database, Sql } from '@platform/tenancy-db'
import type { JobHandler, EnqueueOptions } from '@platform/jobs'
import type { EventHandler } from '@platform/events'
import type { CallContext, EmbedResultWithRoute, GatewayStreamEvent, RunInput, RunResult, TaskDefinition } from './ai.ts'

export type { TaskDefinition } from './ai.ts'
export type Role = 'student' | 'educator' | 'tenant_admin'

/** Authenticated caller as seen by module code. */
export interface Principal {
  userId: string
  tenantId: string
  email: string
  roles: string[]
  isPlatformAdmin: boolean
}

/** AI access for a module: only its own tasks, only through the gateway. */
export interface ModuleAi {
  run(taskId: string, input: RunInput, ctx?: Partial<CallContext>): Promise<RunResult>
  stream(taskId: string, input: RunInput, ctx?: Partial<CallContext>): AsyncIterable<GatewayStreamEvent>
  embed(taskId: string, inputs: string[], purpose?: 'document' | 'query'): Promise<EmbedResultWithRoute>
}

/** Everything a module may use. Note: no system (BYPASSRLS) database access, no secrets, no providers. */
export interface ModuleDeps {
  db: Database
  /** run `fn` in the caller tenant's RLS transaction */
  inTenant<T>(p: Pick<Principal, 'tenantId' | 'userId' | 'roles'>, fn: (tx: Sql) => Promise<T>): Promise<T>
  enqueue(tx: Sql, jobName: string, payload: unknown, opts?: EnqueueOptions): Promise<{ id: string; created: boolean }>
  publish(tx: Sql, topic: string, payload: unknown): Promise<number>
  audit(tx: Sql, p: Pick<Principal, 'userId'>, e: { action: string; targetType: string; targetId?: string | null; metadata?: Record<string, unknown> }): Promise<void>
  /** AI scoped to the calling tenant/user */
  ai(p: Pick<Principal, 'tenantId' | 'userId'>): ModuleAi
}

export interface RequestContext {
  principal: Principal
  params: Record<string, string>
  query: URLSearchParams
  body: unknown
  signal: AbortSignal
}
export interface StreamResponse {
  stream: AsyncIterable<unknown>
}
export type RouteHandler = (ctx: RequestContext) => Promise<unknown | StreamResponse>

export interface RouteDef {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** relative path, e.g. `/courses/:courseId` (mounted under /api/m/<module-id>) */
  path: string
  /** required permission key (must be one of the module's own or a platform permission) */
  permission: string
  handler: RouteHandler
}

export interface DataStore {
  kind: 'schema' | 'object_prefix' | 'retrieval_chunks' | 'platform_documents' | 'audit_events' | 'ai_operations' | 'jobs'
  name: string
  /** what decommissioning does with it (MODULE_REMOVAL_STRATEGY § 3) */
  onRemove: 'export_then_drop' | 'delete' | 'retain_platform_policy' | 'owner_retains'
  description: string
}

/** The module contract (platform-planning/ARCHITECTURE.md § 2). Everything a module adds is declared here. */
export interface ModuleManifest {
  id: string
  vertical: string
  version: string
  owner: string
  description: string
  db?: { schema: string; migrationsDir: string }
  permissions?: { key: string; description: string; roles: Role[] }[]
  routes?: (deps: ModuleDeps) => RouteDef[]
  jobs?: (deps: ModuleDeps) => Record<string, JobHandler>
  events?: {
    publishes?: string[]
    subscribes?: { topic: string; optional?: boolean; handler: (deps: ModuleDeps) => EventHandler }[]
  }
  ui?: { routes: { path: string; title: string; permission: string }[]; nav?: { label: string; path: string; permission: string }[] }
  ai?: { tasks: TaskDefinition[] }
  data: { stores: DataStore[] }
  evals?: { suites: string[] }
}

const MODULE_ID = /^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*$/
const FORBIDDEN_KEYS = /^(provider|model|modelId|apiKey|baseUrl|connection|adapter)$/i

/** Validate a manifest's namespacing and required fields. Throws AppError('manifest_invalid') with all problems. */
export function validateManifest(m: ModuleManifest): void {
  const p: string[] = []
  if (!MODULE_ID.test(m.id)) p.push(`id "${m.id}" must be <vertical>.<agent>`)
  const [vertical, agent] = m.id.split('.')
  if (m.vertical !== vertical) p.push(`vertical "${m.vertical}" must match id prefix "${vertical}"`)
  if (!m.owner) p.push('owner is required')
  if (!m.data?.stores) p.push('data inventory (data.stores) is required')
  const expectedSchema = `${vertical}_${agent}`
  if (m.db && m.db.schema !== expectedSchema) p.push(`db.schema must be "${expectedSchema}"`)
  if (m.db && !m.data?.stores?.some((s) => s.kind === 'schema' && s.name === m.db!.schema)) p.push('data.stores must declare the module schema')
  for (const perm of m.permissions ?? []) if (!perm.key.startsWith(`${m.id}:`)) p.push(`permission ${perm.key} must start with "${m.id}:"`)
  for (const topic of m.events?.publishes ?? []) if (!topic.startsWith(`${m.id}.`) || !/\.v\d+$/.test(topic)) p.push(`published topic ${topic} must be "${m.id}.<event>.v<n>"`)
  for (const r of m.ui?.routes ?? []) if (!r.path.startsWith(`/app/${vertical}/${agent}`)) p.push(`UI route ${r.path} must be under /app/${vertical}/${agent}`)
  for (const t of m.ai?.tasks ?? []) {
    if (t.owner !== m.id || !t.id.startsWith(`${m.id}.`)) p.push(`AI task ${t.id} must be owned by and namespaced with ${m.id}`)
    for (const k of Object.keys(t)) if (FORBIDDEN_KEYS.test(k)) p.push(`AI task ${t.id} has forbidden field "${k}" (tasks declare needs, not providers)`)
  }
  for (const k of Object.keys(m)) if (FORBIDDEN_KEYS.test(k)) p.push(`manifest has forbidden field "${k}"`)
  if ((m.ai?.tasks?.length ?? 0) > 0 && !m.evals?.suites?.length) p.push('modules with AI tasks must declare eval suites')
  if (p.length) throw new AppError('manifest_invalid', `Module ${m.id}: ${p.join('; ')}`, { details: { problems: p } })
}
