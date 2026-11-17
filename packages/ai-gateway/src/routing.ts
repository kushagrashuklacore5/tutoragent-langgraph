import type { Capabilities } from '@platform/ai-adapter-kit'
import { capabilityGaps } from './capabilities.ts'
import { notLessStrict, policyViolations, type TenantAiPolicy } from './policy.ts'
import { routingCapabilities, type ConnectionRow, type DeploymentRow, type RouteCandidate, type RouteRow, type Store } from './store.ts'
import type { TaskDefinition } from './tasks.ts'

export interface EligibleCandidate {
  deployment: DeploymentRow
  connection: ConnectionRow
  capabilities: Capabilities
  params: RouteCandidate['params']
  route: RouteRow
  position: number
}
export interface Rejection {
  deploymentId: string
  reasons: string[]
}

export interface RoutingContext {
  store: Store
  environment: string
  /** adapters compiled into this build */
  adapterTypes: Set<string>
}

/**
 * Check one candidate against a task for a tenant. Returns reasons it is NOT eligible (empty = eligible).
 * Used both when saving a route and before every call, so configuration drift is caught at runtime.
 */
export async function candidateIssues(
  ctx: RoutingContext,
  task: TaskDefinition,
  tenantId: string | null,
  tenantPolicy: TenantAiPolicy,
  dep: DeploymentRow | null,
  conn: ConnectionRow | null,
): Promise<{ reasons: string[]; capabilities: Capabilities | null }> {
  const reasons: string[] = []
  if (!dep) return { reasons: ['deployment not found'], capabilities: null }
  if (!conn) return { reasons: ['connection not found'], capabilities: null }
  if (!dep.enabled) reasons.push('deployment disabled')
  if (!conn.enabled) reasons.push('connection disabled')
  if (!ctx.adapterTypes.has(conn.adapter)) reasons.push(`adapter ${conn.adapter} is not available in this build`)
  if (conn.enabled_models && !conn.enabled_models.includes(dep.model_id)) reasons.push('model not enabled on connection')
  // BYOK isolation: a tenant-scope connection may serve only its own tenant
  if (conn.tenant_id !== null && conn.tenant_id !== tenantId) reasons.push('connection belongs to another tenant')
  if (conn.tenant_id === null && tenantPolicy.byok === 'byok_only') reasons.push('tenant policy allows only its own (BYOK) connections')
  if (conn.tenant_id !== null && tenantPolicy.byok === 'platform_only') reasons.push('tenant policy allows only platform connections')
  const caps = routingCapabilities(dep, conn, ctx.environment)
  if (!caps) reasons.push('capabilities not verified (production requires probe-verified capabilities)')
  else reasons.push(...capabilityGaps(caps, task.requires))
  reasons.push(...policyViolations(conn.data_policy, task.dataClass, tenantPolicy))
  if (ctx.environment === 'production' && !(await ctx.store.evalPassed(task.id, dep.id))) reasons.push(`no passing eval for ${task.id} on this deployment`)
  return { reasons, capabilities: caps }
}

/** Resolution order: tenant task → tenant category → platform task → platform category. No implicit default. */
export async function findRoute(ctx: RoutingContext, task: TaskDefinition, tenantId: string): Promise<RouteRow | null> {
  const targets = [`task:${task.id}`, `category:${task.category}`]
  for (const scope of [tenantId, null]) {
    for (const target of targets) {
      const r = await ctx.store.route(scope, target, ctx.environment)
      if (r) return r
    }
  }
  return null
}

/**
 * Eligible candidates for a call, in route order. Fallback candidates must also be at least as
 * strict on data policy as the first eligible candidate (never "best effort").
 */
export async function resolveCandidates(ctx: RoutingContext, task: TaskDefinition, tenantId: string, tenantPolicy: TenantAiPolicy): Promise<{ eligible: EligibleCandidate[]; rejected: Rejection[]; route: RouteRow | null }> {
  const route = await findRoute(ctx, task, tenantId)
  if (!route) return { eligible: [], rejected: [], route: null }
  const eligible: EligibleCandidate[] = []
  const rejected: Rejection[] = []
  for (const [position, c] of route.candidates.entries()) {
    const dep = await ctx.store.deployment(c.deploymentId)
    const conn = dep ? await ctx.store.connection(dep.connection_id) : null
    const { reasons, capabilities } = await candidateIssues(ctx, task, tenantId, tenantPolicy, dep, conn)
    if (!reasons.length && eligible[0] && !notLessStrict(conn!.data_policy, eligible[0].connection.data_policy)) reasons.push('data policy less strict than the primary candidate')
    if (reasons.length) rejected.push({ deploymentId: c.deploymentId, reasons })
    else eligible.push({ deployment: dep!, connection: conn!, capabilities: capabilities!, params: c.params, route, position })
  }
  // tasks that may not switch model only ever use the first eligible candidate
  const single = task.fallback === 'none' || task.determinism === 'pinned' || task.requires.operation === 'embed'
  return { eligible: single ? eligible.slice(0, 1) : eligible, rejected, route }
}
