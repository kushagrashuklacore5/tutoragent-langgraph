/**
 * Makes Gemini (gemini-embedding-001, 1024 dimensions) the embedding model for uploaded material, then re-embeds
 * already indexed chunks so search keeps finding them (search only compares vectors from the same model).
 *   set -a; . ./.env; set +a; node tooling/setup-gemini-embeddings.ts
 * The key is read from GEMINI_API_KEY, stored encrypted by the gateway and never printed.
 */
import { loadConfig } from '@platform/core'
import { configureLogging } from '@platform/observability'
import { createDatabase } from '@platform/tenancy-db'
import { createSystemDatabase } from '@platform/tenancy-db/system'
import { ADAPTERS, createGateway, localKeyManager, type Actor } from '@platform/ai-gateway'
import { buildPlatform } from '@platform/module-runtime'
import { EMBED_TASK_ID, embeddingTask, normalize } from '@platform/retrieval'
import { MODULES } from '../apps/api/src/modules.generated.ts'

const MODEL = 'gemini-embedding-001', ADAPTER = 'google-gemini', DIMS = Number(process.env.EMBEDDING_DIMENSIONS ?? 1024)
const apiKey = process.env.GEMINI_API_KEY?.trim()
if (!apiKey) { process.stderr.write('GEMINI_API_KEY is not set in .env\n'); process.exit(1) }

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
const platform = buildPlatform(MODULES, { db, gateway: () => gw, embeddingDimensions: DIMS, documents: {} as never, retrieval: {} as never })
gw = createGateway({ system, keyManager: localKeyManager(c.masterKey), environment: c.env, adapters: ADAPTERS, tasks: platform.tasks })
if (!platform.tasks.get(EMBED_TASK_ID)) platform.tasks.register(embeddingTask(DIMS))

// Recorded exactly as decided: the operator approved student material for Gemini; the paid tier was not confirmed.
const dataPolicy = { processingLocation: 'global', selfHosted: false, retentionDays: null, zeroRetention: false, trainsOnData: false, dpaInPlace: false, termsVerified: true, sourceOfTerms: 'Operator instruction on 2026-11-24: send uploaded student material to Gemini. Paid (no-training) tier NOT confirmed.' }
const existing = (await gw.admin.listConnections(actor, null)).find((x: { adapter: string }) => x.adapter === ADAPTER) as { id: string } | undefined
let connectionId = existing?.id
if (connectionId) { await gw.admin.rotateKey(actor, connectionId, apiKey); await gw.admin.setDataPolicy(actor, connectionId, dataPolicy) }
else connectionId = (await gw.admin.createConnection(actor, { adapter: ADAPTER, name: 'Gemini embeddings', apiKey, timeoutMs: 30_000, dataPolicy })).id
const test = await gw.admin.testConnection(actor, connectionId)
if (!test.ok) { process.stderr.write(`Gemini rejected the connection: ${test.error?.kind ?? 'unknown'}\n`); process.exit(1) }
await gw.admin.approveModel(actor, { adapter: ADAPTER, modelId: MODEL, declared: { operations: ['embed'], embeddingDimensions: [DIMS] } })
const found = (await system.query<{ id: string }>('select id from platform.ai_deployments where connection_id = $1 and model_id = $2', [connectionId, MODEL])).rows[0]
const deploymentId = found?.id ?? (await gw.admin.createDeployment(actor, { connectionId, modelId: MODEL })).id
// one model only: a fallback to a different embedding model would put vectors from two spaces into one index
await gw.admin.setRoute(actor, { target: 'category:embeddings', candidates: [{ deploymentId }] })
process.stdout.write('Gemini is now the embedding model.\n')

const model = `${ADAPTER}/${MODEL}`
const rows = (await system.query<{ id: string; tenant_id: string; text: string }>(`select id, tenant_id, text from platform.chunks where embedding_model is distinct from $1 order by tenant_id, id`, [model])).rows
let done = 0
for (let i = 0; i < rows.length; i += 10) {
  const batch = rows.slice(i, i + 10)
  const tenantId = batch[0]!.tenant_id
  const part = batch.filter((r) => r.tenant_id === tenantId)
  let r: Awaited<ReturnType<typeof gw.embed>> | null = null
  for (let attempt = 0; attempt < 8 && !r; attempt++) {
    try { r = await gw.embed(EMBED_TASK_ID, part.map((x) => x.text), { tenantId, userId: owner.user_id }, 'document') }
    catch (e) { if ((e as { kind?: string }).kind !== 'rate_limited') throw e; process.stdout.write('rate limited, waiting 20 s' + String.fromCharCode(10)); await new Promise((w) => setTimeout(w, 20_000)) }
  }
  if (!r) throw new Error('Gemini kept rate-limiting; run the script again later to finish')
  for (let k = 0; k < part.length; k++) {
    await system.query('update platform.chunks set embedding = $2, embedding_model = $3, embedding_dims = $4 where id = $1', [part[k]!.id, normalize(r.vectors[k]!), model, DIMS])
  }
  done += part.length
  await new Promise((w) => setTimeout(w, 1500)) // stay under the per-minute limit
  if (part.length < batch.length) i -= batch.length - part.length
}
process.stdout.write(`Re-embedded ${done} of ${rows.length} existing chunks.\n`)
process.exit(0)
