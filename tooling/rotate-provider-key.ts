/**
 * Replaces the API key of every gateway connection of one provider, then tests each connection.
 *   set -a; . ./.env; set +a; node tooling/rotate-provider-key.ts groq GROQ_API_KEY
 * The key is read from the named environment variable, stored encrypted by the gateway and never printed.
 */
import { loadConfig } from '@platform/core'
import { configureLogging } from '@platform/observability'
import { createDatabase } from '@platform/tenancy-db'
import { createSystemDatabase } from '@platform/tenancy-db/system'
import { ADAPTERS, createGateway, localKeyManager, type Actor } from '@platform/ai-gateway'
import { buildPlatform } from '@platform/module-runtime'
import { MODULES } from '../apps/api/src/modules.generated.ts'

const [adapter, envName] = process.argv.slice(2)
const apiKey = envName ? process.env[envName]?.trim() : undefined
if (!adapter || !apiKey) { process.stderr.write('usage: rotate-provider-key.ts <adapter> <ENV_VAR_WITH_KEY>\n'); process.exit(1) }

configureLogging({ level: 'warn' })
const c = loadConfig()
const db = createDatabase(c.appDatabaseUrl)
const system = createSystemDatabase(c.systemDatabaseUrl)
const owner = (await system.query<{ user_id: string; tenant_id: string }>(
  `select m.user_id, m.tenant_id from platform.memberships m join platform.users u on u.id = m.user_id join platform.tenants t on t.id = m.tenant_id
    where t.slug = 'demo-univ' and u.email = 'admin@demo.test' limit 1`)).rows[0]
if (!owner) { process.stderr.write('The demo tenant admin was not found\n'); process.exit(1) }
const actor: Actor = { userId: owner.user_id, tenantId: owner.tenant_id, isPlatformAdmin: true, roles: ['tenant_admin'] }
let gw: ReturnType<typeof createGateway>
const platform = buildPlatform(MODULES, { db, gateway: () => gw, embeddingDimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 1024), documents: {} as never, retrieval: {} as never })
gw = createGateway({ system, keyManager: localKeyManager(c.masterKey), environment: c.env, adapters: ADAPTERS, tasks: platform.tasks })

const list = (await gw.admin.listConnections(actor, null)).filter((x: { adapter: string }) => x.adapter === adapter) as { id: string; name: string }[]
if (!list.length) { process.stderr.write(`No ${adapter} connections found\n`); process.exit(1) }
for (const x of list) {
  await gw.admin.rotateKey(actor, x.id, apiKey)
  const t = await gw.admin.testConnection(actor, x.id)
  process.stdout.write(`${x.name}: ${t.ok ? 'ok' : `failed (${t.error?.kind ?? 'unknown'})`}\n`)
}
process.exit(0)
