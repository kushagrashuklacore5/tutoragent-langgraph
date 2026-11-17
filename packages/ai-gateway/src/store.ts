import type { Capabilities } from '@platform/ai-adapter-kit'
import type { SystemDatabase } from '@platform/tenancy-db/system'
import { normalizeCapabilities, narrow } from './capabilities.ts'
import type { DataPolicy, TenantAiPolicy } from './policy.ts'

/** Gateway configuration rows, read through the system role (platform rows are invisible to the app role). */

export interface ConnectionRow {
  id: string
  tenant_id: string | null
  scope: 'platform' | 'tenant'
  adapter: string
  name: string
  base_url: string | null
  allow_private_network: boolean
  data_policy: DataPolicy
  enabled_capabilities: Partial<Capabilities> | null
  enabled_models: string[] | null
  secret_id: string | null
  timeout_ms: number
  infra_cost: Pricing | null
  enabled: boolean
  status: 'untested' | 'ok' | 'failing'
  last_test: unknown
  version: number
}

export interface Pricing {
  currency: string
  inputPerMTok: number
  outputPerMTok: number
  cachedInputPerMTok?: number
  source?: string
  effectiveFrom?: string
}

export interface DeploymentRow {
  id: string
  tenant_id: string | null
  connection_id: string
  model_id: string
  declared: Capabilities
  verified: Capabilities | null
  verified_at: Date | null
  pricing: Pricing | null
  enabled: boolean
}

export interface RouteCandidate {
  deploymentId: string
  params?: { temperature?: number; maxOutputTokens?: number; reasoning?: 'off' | 'low' | 'medium' | 'high' }
}
export interface RouteRow {
  id: string
  tenant_id: string | null
  scope: 'platform' | 'tenant'
  target: string
  environment: string
  candidates: RouteCandidate[]
  version: number
}

export function createStore(system: SystemDatabase) {
  const fixDeployment = (r: DeploymentRow): DeploymentRow => ({ ...r, declared: normalizeCapabilities(r.declared), verified: r.verified ? normalizeCapabilities(r.verified) : null })
  return {
    async connection(id: string): Promise<ConnectionRow | null> {
      return (await system.query<ConnectionRow>('select * from platform.ai_connections where id = $1', [id])).rows[0] ?? null
    },
    async connections(scope: { tenantId: string | null }): Promise<ConnectionRow[]> {
      return (await system.query<ConnectionRow>('select * from platform.ai_connections where tenant_id is not distinct from $1 order by name', [scope.tenantId])).rows
    },
    async deployment(id: string): Promise<DeploymentRow | null> {
      const r = (await system.query<DeploymentRow>('select * from platform.ai_deployments where id = $1', [id])).rows[0]
      return r ? fixDeployment(r) : null
    },
    async deploymentsOf(connectionId: string): Promise<DeploymentRow[]> {
      return (await system.query<DeploymentRow>('select * from platform.ai_deployments where connection_id = $1 order by model_id', [connectionId])).rows.map(fixDeployment)
    },
    /** Active route for exactly this scope/target/environment. */
    async route(tenantId: string | null, target: string, environment: string): Promise<RouteRow | null> {
      return (await system.query<RouteRow>(
        'select * from platform.ai_routes where tenant_id is not distinct from $1 and target = $2 and environment = $3 and active', [tenantId, target, environment])).rows[0] ?? null
    },
    async tenantPolicy(tenantId: string): Promise<TenantAiPolicy> {
      const r = await system.query<{ policy: { ai?: TenantAiPolicy } }>('select policy from platform.tenants where id = $1', [tenantId])
      return r.rows[0]?.policy?.ai ?? {}
    },
    async evalPassed(taskId: string, deploymentId: string): Promise<boolean> {
      const r = await system.query<{ passed: boolean }>('select passed from platform.ai_eval_standings where task_id = $1 and deployment_id = $2', [taskId, deploymentId])
      return r.rows[0]?.passed === true
    },
  }
}
export type Store = ReturnType<typeof createStore>

/** Capabilities used for routing: verified in production; declared elsewhere. Narrowed by connection allowlist. */
export function routingCapabilities(dep: DeploymentRow, conn: ConnectionRow, environment: string): Capabilities | null {
  const base = environment === 'production' ? dep.verified : (dep.verified ?? dep.declared)
  if (!base) return null
  return narrow(base, conn.enabled_capabilities)
}
