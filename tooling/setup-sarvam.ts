/**
 * Connects Sarvam text-to-speech through the AI Gateway (idempotent).
 *   set -a; . ./.env; set +a; node tooling/setup-sarvam.ts [--terms-verified]
 * The key is read from SARVAM_API_KEY, stored encrypted by the gateway and never printed.
 *
 * Lesson text can come from a student's documents, so the gateway only routes it to a provider whose terms were
 * checked. Pass --terms-verified ONLY after you have confirmed in Sarvam's terms that API data is not used for training.
 */
import { loadConfig } from '@platform/core'
import { configureLogging } from '@platform/observability'
import { createDatabase } from '@platform/tenancy-db'
import { createSystemDatabase } from '@platform/tenancy-db/system'
import { ADAPTERS, createGateway, localKeyManager, type Actor } from '@platform/ai-gateway'
import { buildPlatform } from '@platform/module-runtime'
import { MODULES } from '../apps/api/src/modules.generated.ts'

const MODEL = 'bulbul:v4-flash'
const apiKey = process.env.SARVAM_API_KEY?.trim()
if (!apiKey) { console.error('SARVAM_API_KEY is not set in .env'); process.exit(1) }
const verified = process.argv.includes('--terms-verified')

configureLogging({ level: 'warn' })
const c = loadConfig()
const db = createDatabase(c.appDatabaseUrl)
const system = createSystemDatabase(c.systemDatabaseUrl)
const owner = (await system.query<{ user_id: string; tenant_id: string }>(
  `select m.user_id, m.tenant_id from platform.memberships m join platform.users u on u.id = m.user_id join platform.tenants t on t.id = m.tenant_id
    where t.slug = 'demo-univ' and u.email = 'admin@demo.test' limit 1`)).rows[0]
if (!owner) { console.error('The demo tenant admin was not found'); process.exit(1) }
const actor: Actor = { userId: owner.user_id, tenantId: owner.tenant_id, isPlatformAdmin: true, roles: ['tenant_admin'] }

let gw: ReturnType<typeof createGateway>
const platform = buildPlatform(MODULES, { db, gateway: () => gw, embeddingDimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 1024), documents: {} as never, retrieval: {} as never })
gw = createGateway({ system, keyManager: localKeyManager(c.masterKey), environment: c.env, adapters: ADAPTERS, tasks: platform.tasks })

const dataPolicy = { processingLocation: 'IN', selfHosted: false, retentionDays: null, zeroRetention: false, trainsOnData: verified ? false : null, dpaInPlace: false, termsVerified: verified, sourceOfTerms: verified ? 'confirmed by the operator running this script' : undefined }
const existing = (await gw.admin.listConnections(actor, null)).find((x: { adapter: string }) => x.adapter === 'sarvam') as { id: string } | undefined
let connectionId = existing?.id
if (connectionId) { await gw.admin.rotateKey(actor, connectionId, apiKey); await gw.admin.setDataPolicy(actor, connectionId, dataPolicy) }
else connectionId = (await gw.admin.createConnection(actor, { adapter: 'sarvam', name: 'Sarvam speech', apiKey, timeoutMs: 30_000, dataPolicy })).id

const test = await gw.admin.testConnection(actor, connectionId)
if (!test.ok) { console.error(`Sarvam rejected the connection: ${test.error?.kind ?? 'unknown'}`); process.exit(1) }
await gw.admin.approveModel(actor, { adapter: 'sarvam', modelId: MODEL, declared: { operations: ['synthesize'] } })
const found = (await system.query<{ id: string }>('select id from platform.ai_deployments where connection_id = $1 and model_id = $2', [connectionId, MODEL])).rows[0]
// ₹2 per 1,000 characters = 2,000 micro-rupees per character, metered as input tokens
const deploymentId = found?.id ?? (await gw.admin.createDeployment(actor, { connectionId, modelId: MODEL, pricing: { currency: 'INR', inputPerMTok: 2000, outputPerMTok: 0 } as never })).id
await gw.admin.probeDeployment(actor, deploymentId).catch(() => undefined)
try { await gw.admin.setRoute(actor, { target: 'category:text_to_speech', candidates: [{ deploymentId }] }) }
catch (e) {
  if ((e as { code?: string }).code !== 'route_invalid') throw e
  console.error('Sarvam key works, but lesson speech stays OFF: the data policy blocks student content. Opt out of training in your Sarvam account, then re-run with --terms-verified.')
  process.exit(2)
}
console.log(`Sarvam connected. Student-content routing: ${verified ? 'enabled' : 'BLOCKED until you re-run with --terms-verified'}.`)
process.exit(0)
