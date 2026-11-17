import { newId } from '@platform/core'
import { counter, histogram } from '@platform/observability'
import type { Usage } from '@platform/ai-adapter-kit'
import type { SystemDatabase } from '@platform/tenancy-db/system'
import type { Pricing } from './store.ts'

export interface OperationRecord {
  tenantId: string
  moduleId: string
  taskId: string
  routeId?: string | null
  routeVersion?: number | null
  deploymentId?: string | null
  connectionId?: string | null
  adapter?: string | null
  modelId?: string | null
  attempt: number
  fallback: boolean
  byok: boolean
  status: 'ok' | 'error'
  errorKind?: string | null
  usage?: Usage
  ttftMs?: number | null
  latencyMs: number
  pricing?: Pricing | null
  promptVersion?: string | null
  traceId?: string | null
}

/** Cost in currency micro-units from token usage and the pricing version in force. Null when unknown. */
export function costMicros(usage: Usage | undefined, pricing: Pricing | null | undefined): number | null {
  if (!usage || !pricing || usage.inputTokens === null || usage.outputTokens === null) return null
  const cached = usage.cachedInputTokens ?? 0
  const fresh = Math.max(0, usage.inputTokens - cached)
  const cost = fresh * pricing.inputPerMTok + cached * (pricing.cachedInputPerMTok ?? pricing.inputPerMTok) + usage.outputTokens * pricing.outputPerMTok
  return Math.round(cost) // per-MTok prices × tokens / 1e6 × 1e6 micros
}

export async function recordOperation(system: SystemDatabase, r: OperationRecord): Promise<string> {
  const id = newId()
  const cost = costMicros(r.usage, r.pricing)
  await system.query(
    `insert into platform.ai_operations (id, tenant_id, module_id, task_id, route_id, route_version, deployment_id, connection_id, adapter, model_id,
       attempt, fallback, byok, status, error_kind, input_tokens, output_tokens, cached_tokens, reasoning_tokens, ttft_ms, latency_ms, cost_micros, currency, prompt_version, trace_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
    [id, r.tenantId, r.moduleId, r.taskId, r.routeId ?? null, r.routeVersion ?? null, r.deploymentId ?? null, r.connectionId ?? null, r.adapter ?? null, r.modelId ?? null,
      r.attempt, r.fallback, r.byok, r.status, r.errorKind ?? null, r.usage?.inputTokens ?? null, r.usage?.outputTokens ?? null, r.usage?.cachedInputTokens ?? null,
      r.usage?.reasoningTokens ?? null, r.ttftMs ?? null, Math.round(r.latencyMs), cost, cost === null ? null : r.pricing?.currency ?? null, r.promptVersion ?? null, r.traceId ?? null],
  )
  const labels = { adapter: r.adapter ?? 'none', model: r.modelId ?? 'none', task: r.taskId, status: r.status }
  counter('ai_requests_total', labels).inc()
  if (r.fallback) counter('ai_fallbacks_total', { task: r.taskId }).inc()
  histogram('ai_latency_ms', { adapter: r.adapter ?? 'none', model: r.modelId ?? 'none' }).observe(r.latencyMs)
  if (r.usage?.inputTokens) counter('ai_input_tokens_total', { adapter: r.adapter ?? 'none', model: r.modelId ?? 'none' }).inc(r.usage.inputTokens)
  if (r.usage?.outputTokens) counter('ai_output_tokens_total', { adapter: r.adapter ?? 'none', model: r.modelId ?? 'none' }).inc(r.usage.outputTokens)
  if (cost) counter('ai_cost_micros_total', { currency: r.pricing?.currency ?? 'unknown', tenant: r.tenantId }).inc(cost)
  return id
}

/** Month-to-date spend vs hard limit for tenant (and optionally module). */
export async function budgetExceeded(system: SystemDatabase, tenantId: string, moduleId: string): Promise<{ exceeded: boolean; limit?: number; spent?: number }> {
  const b = await system.query<{ module_id: string | null; currency: string; monthly_hard_limit_micros: number }>(
    `select module_id, currency, monthly_hard_limit_micros from platform.ai_budgets where tenant_id = $1 and (module_id is null or module_id = $2)`, [tenantId, moduleId])
  for (const row of b.rows) {
    const s = await system.query<{ spent: number }>(
      `select coalesce(sum(cost_micros), 0)::bigint as spent from platform.ai_operations
       where tenant_id = $1 and currency = $2 and created_at >= date_trunc('month', now()) and ($3::text is null or module_id = $3)`,
      [tenantId, row.currency, row.module_id])
    const spent = s.rows[0]?.spent ?? 0
    if (spent >= row.monthly_hard_limit_micros) return { exceeded: true, limit: row.monthly_hard_limit_micros, spent }
  }
  return { exceeded: false }
}

export async function usageSummary(system: SystemDatabase, tenantId: string, from: Date, to: Date) {
  const r = await system.query(
    `select module_id, task_id, adapter, model_id, count(*)::int as calls, sum(case when status = 'error' then 1 else 0 end)::int as errors,
            sum(case when fallback then 1 else 0 end)::int as fallbacks, coalesce(sum(input_tokens), 0)::bigint as input_tokens,
            coalesce(sum(output_tokens), 0)::bigint as output_tokens, coalesce(sum(cost_micros), 0)::bigint as cost_micros, max(currency) as currency,
            percentile_cont(0.5) within group (order by latency_ms) as p50_ms, percentile_cont(0.95) within group (order by latency_ms) as p95_ms
     from platform.ai_operations where tenant_id = $1 and created_at >= $2 and created_at < $3
     group by module_id, task_id, adapter, model_id order by module_id, task_id`,
    [tenantId, from, to])
  return r.rows
}
