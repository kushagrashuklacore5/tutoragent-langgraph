/**
 * Platform operations CLI.
 *   node apps/api/src/cli.ts migrate
 *   node apps/api/src/cli.ts tenant:create --slug univ-a --name "University A" --admin admin@univ-a.in
 *   node apps/api/src/cli.ts tenant:enable-module --slug univ-a --module education.tutor
 *   node apps/api/src/cli.ts platform-admin --email ops@example.com
 *   node apps/api/src/cli.ts module:export <module-id> --slug univ-a > export.json
 *   node apps/api/src/cli.ts module:purge <module-id> --confirm <module-id>
 *   node apps/api/src/cli.ts module:verify-absent <module-id>
 */
import { parseArgs } from 'node:util'
import { loadConfig } from '@platform/core'
import { ensureRoles, migrate, createDatabase } from '@platform/tenancy-db'
import { createSystemDatabase } from '@platform/tenancy-db/system'
import { createIdentityService, devOutboxTransport } from '@platform/identity'
import { migrationSetsFor } from '@platform/module-runtime'
import { exportModuleData, purgeModule, verifyModuleAbsent } from '@platform/module-runtime/lifecycle'
import { MODULES } from './modules.generated.ts'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { slug: { type: 'string' }, name: { type: 'string' }, admin: { type: 'string' }, email: { type: 'string' }, module: { type: 'string' }, confirm: { type: 'string' } },
})
const [cmd, arg] = positionals
const config = loadConfig()
const system = createSystemDatabase(process.env.SYSTEM_DATABASE_URL ?? config.databaseUrl)

async function tenantId(slug?: string): Promise<string> {
  if (!slug) throw new Error('--slug is required')
  const r = await system.query<{ id: string }>('select id from platform.tenants where slug = $1', [slug])
  if (!r.rows[0]) throw new Error(`tenant ${slug} not found`)
  return r.rows[0].id
}

try {
  switch (cmd) {
    case 'migrate': {
      await ensureRoles(config.databaseUrl)
      const r = await migrate(config.databaseUrl, migrationSetsFor(MODULES))
      console.log(r.applied.length ? r.applied.join('\n') : 'up to date')
      break
    }
    case 'tenant:create': {
      const db = createDatabase(config.appDatabaseUrl)
      const id = createIdentityService({ system, db, mail: devOutboxTransport(system), publicBaseUrl: config.publicBaseUrl })
      console.log(await id.createTenant({ slug: values.slug!, name: values.name ?? values.slug!, adminEmail: values.admin! }))
      await db.close()
      break
    }
    case 'tenant:enable-module': {
      const t = await tenantId(values.slug)
      if (!MODULES.some((m) => m.id === values.module)) throw new Error(`module ${values.module} is not installed`)
      await system.query('update platform.tenants set enabled_modules = array(select distinct unnest(enabled_modules || $2::text)) where id = $1', [t, values.module])
      console.log('enabled')
      break
    }
    case 'platform-admin':
      await system.query('update platform.users set is_platform_admin = true where email = $1', [values.email?.toLowerCase()])
      console.log('ok')
      break
    case 'module:export':
      console.log(JSON.stringify(await exportModuleData(config.databaseUrl, arg!, await tenantId(values.slug)), null, 2))
      break
    case 'module:purge':
      console.log(await purgeModule(config.databaseUrl, system, arg!, values.confirm ?? ''))
      break
    case 'module:verify-absent': {
      const left = await verifyModuleAbsent(system, arg!)
      console.log(left.length ? `NOT absent:\n${left.join('\n')}` : 'absent')
      if (left.length) process.exitCode = 1
      break
    }
    default:
      console.error('unknown command; see header of apps/api/src/cli.ts')
      process.exitCode = 1
  }
} finally {
  await system.close()
}
