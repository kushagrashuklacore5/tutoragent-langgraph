import pg from 'pg'
import { AppError } from '@platform/core'
import { logger } from '@platform/observability'
import { dropMigrationSet } from '@platform/tenancy-db'
import { recordSystemAudit } from '@platform/audit'
import type { SystemDatabase } from '@platform/tenancy-db/system'

/**
 * Module decommissioning (platform-planning/MODULE_REMOVAL_STRATEGY.md § 2). These work from the
 * module id alone, so they still function after the module's code has been deleted.
 */
const MODULE_ID = /^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*$/
export const schemaOf = (moduleId: string) => moduleId.replace('.', '_')

function assertId(id: string) {
  if (!MODULE_ID.test(id)) throw new AppError('module_id_invalid', `Invalid module id ${id}`)
}

/** Export every row of the module schema belonging to one tenant (tables with a tenant_id column). */
export async function exportModuleData(ownerUrl: string, moduleId: string, tenantId: string): Promise<Record<string, unknown[]>> {
  assertId(moduleId)
  const c = new pg.Client({ connectionString: ownerUrl })
  await c.connect()
  try {
    const schema = schemaOf(moduleId)
    const tables = await c.query<{ table_name: string }>(
      `select table_name from information_schema.columns where table_schema = $1 and column_name = 'tenant_id' order by table_name`, [schema])
    const out: Record<string, unknown[]> = {}
    for (const t of tables.rows) out[t.table_name] = (await c.query(`select * from ${schema}."${t.table_name.replace(/"/g, '')}" where tenant_id = $1`, [tenantId])).rows
    return out
  } finally {
    await c.end()
  }
}

/**
 * Permanently remove a module's data. Requires the module id typed twice (`confirm`).
 * Audit events and metering rows are platform-owned and retained per platform policy.
 */
export async function purgeModule(ownerUrl: string, system: SystemDatabase, moduleId: string, confirm: string, actorUserId: string | null = null) {
  assertId(moduleId)
  if (confirm !== moduleId) throw new AppError('purge_not_confirmed', 'Type the module id to confirm the purge')
  const holds = await system.query<{ id: string }>(`select id from platform.tenants where policy->>'legalHold' = 'true'`)
  if (holds.rowCount) throw new AppError('legal_hold', 'A tenant is under legal hold; purge refused')
  const jobs = await system.query(`delete from platform.jobs where type like $1 or type like $2`, [`${moduleId}/%`, `%/event:${moduleId}.%`])
  const routes = await system.query(`update platform.ai_routes set active = false where target like $1 and active`, [`task:${moduleId}.%`])
  const standings = await system.query(`delete from platform.ai_eval_standings where task_id like $1`, [`${moduleId}.%`])
  const tenants = await system.query(`update platform.tenants set enabled_modules = array_remove(enabled_modules, $1) where $1 = any(enabled_modules)`, [moduleId])
  await dropMigrationSet(ownerUrl, { owner: moduleId, schema: schemaOf(moduleId) })
  await recordSystemAudit(system, { tenantId: null, actorUserId, action: 'module.purged', targetType: 'module', targetId: moduleId,
    metadata: { jobs: jobs.rowCount, routes: routes.rowCount, evalStandings: standings.rowCount, tenants: tenants.rowCount } })
  logger.warn('module purged', { moduleId })
  return { jobsDeleted: jobs.rowCount, routesDeactivated: routes.rowCount, tenantsUpdated: tenants.rowCount }
}

/** Check that nothing of a module remains. Returns the list of leftovers (empty = absent). */
export async function verifyModuleAbsent(system: SystemDatabase, moduleId: string): Promise<string[]> {
  assertId(moduleId)
  const left: string[] = []
  const q = async (label: string, sql: string, params: unknown[]) => {
    const r = await system.query<{ n: number }>(sql, params)
    if ((r.rows[0]?.n ?? 0) > 0) left.push(`${label}: ${r.rows[0]!.n}`)
  }
  await q('schema', `select count(*)::int as n from pg_namespace where nspname = $1`, [schemaOf(moduleId)])
  await q('migration ledger', `select count(*)::int as n from public.schema_migrations where owner = $1`, [moduleId])
  await q('jobs', `select count(*)::int as n from platform.jobs where type like $1 or type like $2`, [`${moduleId}/%`, `%/event:${moduleId}.%`])
  await q('active AI routes', `select count(*)::int as n from platform.ai_routes where target like $1 and active`, [`task:${moduleId}.%`])
  await q('tenant enablement', `select count(*)::int as n from platform.tenants where $1 = any(enabled_modules)`, [moduleId])
  return left
}
