import { fileURLToPath } from 'node:url'
import { newId } from '@platform/core'
import { currentTrace } from '@platform/observability'
import type { MigrationSet, Sql } from '@platform/tenancy-db'

export const auditMigrations: MigrationSet = {
  owner: 'platform.audit',
  schema: 'platform',
  dir: fileURLToPath(new URL('../migrations', import.meta.url)),
}

export interface AuditEvent {
  action: string
  targetType: string
  targetId?: string | null
  metadata?: Record<string, unknown>
}

/**
 * Record an audit event inside the caller's tenant transaction (so it commits or rolls back with
 * the change it describes). RLS guarantees it is written to the current tenant only.
 */
export async function recordAudit(tx: Sql, actor: { userId?: string | null }, e: AuditEvent): Promise<void> {
  await tx.query(
    `insert into platform.audit_events (id, tenant_id, actor_user_id, action, target_type, target_id, metadata, trace_id)
     values ($1, platform.current_tenant(), $2, $3, $4, $5, $6, $7)`,
    [newId(), actor.userId ?? null, e.action, e.targetType, e.targetId ?? null, JSON.stringify(e.metadata ?? {}), currentTrace()?.traceId ?? null],
  )
}

/** Audit from privileged (system) code paths, where the tenant is explicit. */
export async function recordSystemAudit(tx: Sql, e: AuditEvent & { tenantId: string | null; actorUserId: string | null }): Promise<void> {
  await tx.query(
    `insert into platform.audit_events (id, tenant_id, actor_user_id, action, target_type, target_id, metadata, trace_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [newId(), e.tenantId, e.actorUserId, e.action, e.targetType, e.targetId ?? null, JSON.stringify(e.metadata ?? {}), currentTrace()?.traceId ?? null],
  )
}

export async function listAudit(tx: Sql, opts: { limit?: number; before?: Date } = {}) {
  const r = await tx.query(
    `select id, actor_user_id, action, target_type, target_id, metadata, trace_id, created_at
     from platform.audit_events where ($1::timestamptz is null or created_at < $1) order by created_at desc limit $2`,
    [opts.before ?? null, Math.min(opts.limit ?? 50, 500)],
  )
  return r.rows
}
