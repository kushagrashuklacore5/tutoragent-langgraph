/**
 * Print a fresh one-time sign-in link for a demo user (dev outbox mail transport only).
 *   node --env-file=.data/demo.env tooling/demo/login-link.ts stu@demo.test
 */
import { loadConfig } from '@platform/core'
import { configureLogging } from '@platform/observability'
import { createDatabase } from '@platform/tenancy-db'
import { createSystemDatabase } from '@platform/tenancy-db/system'
import { createIdentityService, devOutboxTransport } from '@platform/identity'

configureLogging({ level: 'warn' })
const email = (process.argv[2] ?? 'stu@demo.test').toLowerCase()
const slug = process.argv[3] ?? 'demo-univ'
const c = loadConfig()
if (c.env === 'production') throw new Error('demo login links are for development only')
const db = createDatabase(c.appDatabaseUrl)
const system = createSystemDatabase(c.systemDatabaseUrl)
await createIdentityService({ system, db, mail: devOutboxTransport(system), publicBaseUrl: c.publicBaseUrl }).requestMagicLink({ tenantSlug: slug, email })
const r = await system.query<{ body: string }>('select body from platform.dev_mail_outbox where to_address = $1 order by created_at desc limit 1', [email])
const link = /(https?:\/\/\S+#token=[A-Za-z0-9_-]+)/.exec(r.rows[0]?.body ?? '')?.[1]
console.log(link ?? `no link (is ${email} a member of ${slug}? rate limit is 5 links / 15 min)`)
await db.close()
await system.close()
