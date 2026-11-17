import type { Sql } from './db.ts'

export interface RlsViolation {
  schema: string
  table: string
  problem: 'rls_disabled' | 'rls_not_forced' | 'no_policy'
}

/**
 * Every table with a `tenant_id` column must have RLS enabled, forced (applies to the table owner)
 * and at least one policy. Used by the CI isolation test and at API startup in non-production.
 */
export async function findRlsViolations(db: Sql): Promise<RlsViolation[]> {
  const r = await db.query<{ schema: string; table: string; enabled: boolean; forced: boolean; policies: number }>(`
    select n.nspname as schema, c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
           (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
    where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema')`)
  const out: RlsViolation[] = []
  for (const t of r.rows) {
    if (!t.enabled) out.push({ schema: t.schema, table: t.table, problem: 'rls_disabled' })
    else if (!t.forced) out.push({ schema: t.schema, table: t.table, problem: 'rls_not_forced' })
    else if (t.policies === 0) out.push({ schema: t.schema, table: t.table, problem: 'no_policy' })
  }
  return out
}
