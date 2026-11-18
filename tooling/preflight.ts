/**
 * Production preflight: an executable checklist run before (and after) every deploy.
 *   node tooling/preflight.ts            human-readable report
 *   node tooling/preflight.ts --json     machine-readable report
 *   node tooling/preflight.ts --production   apply production rules even if PLATFORM_ENV is not production
 * Exit code 0 = every check passed (warnings allowed), 1 = at least one failure, 2 = preflight itself crashed.
 * Reads the same environment as the API/worker hosts (deploy/ENVIRONMENT.md) and connects to the database
 * with the owner, app and system URLs. It changes nothing except a KMS wrap/unwrap of a random probe key.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import pg from 'pg'
import { AppError, loadConfig, loadDocumentStorageConfig, productionConfigProblems, sha256, type PlatformConfig } from '@platform/core'
import { otlpOptionsFromEnv } from '@platform/observability'
import { findRlsViolations, APP_ROLE, SYSTEM_ROLE, type MigrationSet } from '@platform/tenancy-db'
import { loadMailConfig } from '@platform/identity'
import { keyManagerFromConfig, verifyKeyManager } from '@platform/ai-gateway'
import { validateManifest, type ModuleManifest } from '@platform/contracts'
import { migrationSetsFor } from '@platform/module-runtime'

export type Status = 'pass' | 'fail' | 'warn' | 'skip'
export interface CheckResult { id: string; title: string; status: Status; details: string[] }
export interface PreflightReport { ok: boolean; env: string; production: boolean; startedAt: string; durationMs: number; checks: CheckResult[] }

export interface PreflightOptions {
  env?: NodeJS.ProcessEnv
  /** enabled modules; defaults to the generated registry */
  modules?: ModuleManifest[]
  /** extra migration sets (tests) */
  extraMigrationSets?: MigrationSet[]
  /** force production rules */
  production?: boolean
  fetch?: typeof fetch
}

const sslmode = (url: string) => {
  try {
    return new URL(url).searchParams.get('sslmode') ?? ''
  } catch {
    return ''
  }
}
const userOf = (url: string) => {
  try {
    return decodeURIComponent(new URL(url).username)
  } catch {
    return ''
  }
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 })
  await c.connect()
  try {
    return await fn(c)
  } finally {
    await c.end().catch(() => undefined)
  }
}

/** Pending files and checksum mismatches per migration set (same rules as tenancy-db `migrate`). */
export async function migrationStatus(c: pg.Client, sets: MigrationSet[]): Promise<{ pending: string[]; changed: string[]; unknownOwners: string[] }> {
  const hasLedger = (await c.query(`select to_regclass('public.schema_migrations') is not null as ok`)).rows[0].ok as boolean
  const done = new Map<string, string>()
  if (hasLedger) for (const r of (await c.query('select owner, name, checksum from public.schema_migrations')).rows) done.set(`${r.owner}/${r.name}`, r.checksum)
  const pending: string[] = []
  const changed: string[] = []
  for (const set of sets) {
    if (!existsSync(set.dir)) continue
    for (const f of readdirSync(set.dir).filter((x) => /^\d{4}_.+\.sql$/.test(x)).sort()) {
      const sum = sha256(readFileSync(join(set.dir, f), 'utf8').replace(/\r\n/g, '\n'))
      const prev = done.get(`${set.owner}/${f}`)
      if (!prev) pending.push(`${set.owner}/${f}`)
      else if (prev !== sum) changed.push(`${set.owner}/${f}`)
    }
  }
  const owners = new Set(sets.map((s) => s.owner))
  const unknownOwners = [...new Set([...done.keys()].map((k) => k.slice(0, k.lastIndexOf('/'))))].filter((o) => !owners.has(o))
  return { pending, changed, unknownOwners }
}

export async function runPreflight(o: PreflightOptions = {}): Promise<PreflightReport> {
  const env = o.env ?? process.env
  const t0 = Date.now()
  const checks: CheckResult[] = []
  const add = (id: string, title: string, status: Status, details: string[] = []) => checks.push({ id, title, status, details })
  const guard = async (id: string, title: string, fn: () => Promise<{ status: Status; details?: string[] }>) => {
    try {
      const r = await fn()
      add(id, title, r.status, r.details)
    } catch (e) {
      add(id, title, 'fail', [e instanceof AppError ? `${e.code}: ${e.message}` : (e as Error).message])
    }
  }

  // 1. configuration
  let config: PlatformConfig | undefined
  try {
    config = loadConfig(env)
    add('env.load', 'Required environment variables present and valid', 'pass')
  } catch (e) {
    add('env.load', 'Required environment variables present and valid', 'fail', [(e as Error).message])
  }
  const production = o.production || config?.env === 'production'
  if (!config) {
    return { ok: false, env: env.PLATFORM_ENV ?? 'development', production: !!production, startedAt: new Date(t0).toISOString(), durationMs: Date.now() - t0, checks }
  }
  const cfg = config
  const prodCfg: PlatformConfig = production ? { ...cfg, env: 'production' } : cfg

  if (production) {
    const p = productionConfigProblems(prodCfg)
    add('env.production', 'Production configuration rules (KMS, https, metrics token, separate DB roles)', p.length ? 'fail' : 'pass', p)
  } else add('env.production', 'Production configuration rules', 'skip', [`PLATFORM_ENV=${cfg.env}; use --production to apply`])

  // 2. TLS / HTTPS
  {
    const d: string[] = []
    let fail = false
    const https = cfg.publicBaseUrl.startsWith('https://')
    if (!https) { d.push(`PUBLIC_BASE_URL is ${new URL(cfg.publicBaseUrl).protocol} (session cookies will not be Secure)`); fail = !!production }
    for (const [k, u] of [['DATABASE_URL', cfg.databaseUrl], ['APP_DATABASE_URL', cfg.appDatabaseUrl], ['SYSTEM_DATABASE_URL', cfg.systemDatabaseUrl]] as const) {
      const m = sslmode(u)
      if (!['require', 'verify-ca', 'verify-full'].includes(m)) { d.push(`${k} has sslmode=${m || '(unset)'}; production needs require/verify-full`); fail ||= !!production }
    }
    add('tls', 'TLS for public URL (Secure cookies) and database connections', fail ? 'fail' : d.length ? 'warn' : 'pass', d)
  }

  // 3. mail, documents, telemetry config
  await guard('mail', 'Mail transport configuration', async () => {
    const m = loadMailConfig(env, prodCfg.env)
    return { status: 'pass', details: [`transport=${m.kind}`] }
  })
  await guard('documents', 'Document store and malware scanner configuration', async () => {
    const d = loadDocumentStorageConfig(env, prodCfg)
    return { status: 'pass', details: [d.enabled ? `store=${d.store.kind} scanner=${d.scanner.kind}` : 'disabled (DOCUMENTS_ENABLED=false)'] }
  })
  await guard('telemetry', 'OTLP exporter configuration', async () => {
    const t = otlpOptionsFromEnv(env, { serviceName: 'preflight' })
    return t ? { status: 'pass', details: [`metrics=${!!t.metricsUrl} traces=${!!t.tracesUrl}`] } : { status: production ? 'warn' : 'pass', details: ['not configured (Prometheus /metrics only)'] }
  })

  // 4. modules
  let modules: ModuleManifest[] = o.modules ?? []
  await guard('modules.manifests', 'Enabled modules have valid manifests', async () => {
    if (!o.modules) modules = (await import('../apps/api/src/modules.generated.ts')).MODULES
    const ids = new Set<string>()
    const d: string[] = []
    for (const m of modules) {
      try { validateManifest(m) } catch (e) { d.push((e as Error).message) }
      if (ids.has(m.id)) d.push(`${m.id} registered twice`)
      ids.add(m.id)
    }
    return { status: d.length ? 'fail' : 'pass', details: d.length ? d : [modules.map((m) => m.id).join(', ') || '(none)'] }
  })

  // 5. database
  let ownerOk = false
  await guard('db.connect', 'Database reachable with owner, app and system roles', async () => {
    const d: string[] = []
    for (const [k, u] of [['DATABASE_URL', cfg.databaseUrl], ['APP_DATABASE_URL', cfg.appDatabaseUrl], ['SYSTEM_DATABASE_URL', cfg.systemDatabaseUrl]] as const) {
      try {
        await withClient(u, (c) => c.query('select 1'))
        if (k === 'DATABASE_URL') ownerOk = true
      } catch (e) {
        d.push(`${k} (user ${userOf(u)}): ${(e as Error).message}`)
      }
    }
    return { status: d.length ? 'fail' : 'pass', details: d }
  })

  if (ownerOk) {
    await guard('db.migrations', 'Migrations up to date for platform + enabled modules', async () => {
      const s = await withClient(cfg.databaseUrl, (c) => migrationStatus(c, [...migrationSetsFor(modules), ...(o.extraMigrationSets ?? [])]))
      const d = [...s.pending.map((p) => `pending: ${p}`), ...s.changed.map((p) => `changed after apply: ${p}`)]
      const info = s.unknownOwners.map((x) => `ledger has migrations of a module that is not enabled: ${x} (disabled, data kept; purge with module:purge)`)
      return { status: d.length ? 'fail' : info.length ? 'warn' : 'pass', details: [...d, ...info] }
    })
    await guard('db.rls', 'Row-level security: every tenant table enabled + forced + has a policy', async () => {
      const v = await withClient(cfg.databaseUrl, (c) => findRlsViolations({ query: async (t, p) => { const r = await c.query(t, p as unknown[]); return { rows: r.rows, rowCount: r.rowCount ?? 0 } } }))
      return { status: v.length ? 'fail' : 'pass', details: v.map((x) => `${x.schema}.${x.table}: ${x.problem}`) }
    })
    await guard('db.roles', 'Runtime roles: app role not superuser / BYPASSRLS / table owner; three distinct roles', async () => {
      const appUser = userOf(cfg.appDatabaseUrl)
      const sysUser = userOf(cfg.systemDatabaseUrl)
      const d: string[] = []
      const rows = await withClient(cfg.databaseUrl, async (c) => (await c.query(`
        select r.rolname, r.rolsuper, r.rolbypassrls,
          (select count(*)::int from pg_class cl join pg_namespace n on n.oid = cl.relnamespace
            where cl.relowner = r.oid and cl.relkind in ('r','p') and n.nspname not in ('pg_catalog','information_schema')) as owned
        from pg_roles r where r.rolname = any($1)`, [[appUser, sysUser]])).rows)
      const app = rows.find((r) => r.rolname === appUser)
      const sys = rows.find((r) => r.rolname === sysUser)
      if (!app) d.push(`app role ${appUser} does not exist`)
      else {
        if (app.rolsuper) d.push(`app role ${appUser} is a superuser`)
        if (app.rolbypassrls) d.push(`app role ${appUser} has BYPASSRLS`)
        if (app.owned) d.push(`app role ${appUser} owns ${app.owned} table(s) (RLS is not applied to owners unless forced)`)
      }
      if (sys?.rolsuper) d.push(`system role ${sysUser} is a superuser (needs only BYPASSRLS)`)
      if (appUser === userOf(cfg.databaseUrl)) d.push('APP_DATABASE_URL uses the owner role')
      if (production && sysUser === userOf(cfg.databaseUrl)) d.push('SYSTEM_DATABASE_URL uses the owner role')
      if (appUser !== APP_ROLE || sysUser !== SYSTEM_ROLE) d.push(`note: expected role names ${APP_ROLE}/${SYSTEM_ROLE}, got ${appUser}/${sysUser}`)
      const hard = d.filter((x) => !x.startsWith('note:'))
      return { status: hard.length ? 'fail' : d.length ? 'warn' : 'pass', details: d }
    })
    await guard('db.audit', 'Audit log is append-only for runtime roles', async () => {
      const r = await withClient(cfg.databaseUrl, async (c) => {
        if (!(await c.query(`select to_regclass('platform.audit_events') is not null as ok`)).rows[0].ok) return null
        return (await c.query(`
          select u.role, p.priv, has_table_privilege(u.role, 'platform.audit_events', p.priv) as granted
          from (values ($1::text), ($2::text)) u(role), (values ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)
          where exists (select 1 from pg_roles where rolname = u.role)`, [userOf(cfg.appDatabaseUrl), userOf(cfg.systemDatabaseUrl)])).rows
          .concat((await c.query(`select 'trigger' as role, 'audit_no_update' as priv, not exists (select 1 from pg_trigger where tgname = 'audit_no_update' and tgrelid = 'platform.audit_events'::regclass and tgenabled <> 'D') as granted`)).rows)
      })
      if (!r) return { status: 'fail', details: ['platform.audit_events does not exist (migrations not applied?)'] }
      const bad = r.filter((x) => x.granted).map((x) => (x.role === 'trigger' ? 'append-only trigger audit_no_update is missing or disabled' : `${x.role} has ${x.priv} on platform.audit_events`))
      return { status: bad.length ? 'fail' : 'pass', details: bad }
    })
  } else {
    for (const id of ['db.migrations', 'db.rls', 'db.roles', 'db.audit']) add(id, id, 'skip', ['owner connection failed'])
  }

  // 6. KMS
  await guard('kms', 'Key manager reachable (wrap/unwrap round trip)', async () => {
    const km = await keyManagerFromConfig(cfg.kms, { env: prodCfg.env, masterKey: cfg.masterKey, processEnv: env, fetch: o.fetch })
    await verifyKeyManager(km)
    return { status: 'pass', details: [km.id] }
  })

  return {
    ok: !checks.some((c) => c.status === 'fail'),
    env: cfg.env,
    production: !!production,
    startedAt: new Date(t0).toISOString(),
    durationMs: Date.now() - t0,
    checks,
  }
}

export function formatReport(r: PreflightReport): string {
  const icon: Record<Status, string> = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', skip: 'SKIP' }
  const lines = [`Preflight (${r.env}${r.production ? ', production rules' : ''})`]
  for (const c of r.checks) {
    lines.push(`[${icon[c.status]}] ${c.title}`)
    for (const d of c.details) lines.push(`        ${d}`)
  }
  const n = (s: Status) => r.checks.filter((c) => c.status === s).length
  lines.push(`${r.ok ? 'OK' : 'FAILED'}: ${n('pass')} passed, ${n('fail')} failed, ${n('warn')} warnings, ${n('skip')} skipped (${r.durationMs} ms)`)
  return lines.join('\n')
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { json: { type: 'boolean' }, production: { type: 'boolean' } } })
  try {
    const r = await runPreflight({ production: values.production })
    console.log(values.json ? JSON.stringify(r, null, 2) : formatReport(r))
    process.exitCode = r.ok ? 0 : 1
  } catch (e) {
    console.error(`preflight crashed: ${(e as Error).message}`)
    process.exitCode = 2
  }
}
