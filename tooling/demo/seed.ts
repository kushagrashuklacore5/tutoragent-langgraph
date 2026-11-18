/**
 * Seed a local demo (idempotent-ish: run once on a fresh database).
 *   node --env-file=.data/demo.env tooling/demo/seed.ts
 * Creates tenant "demo-univ" with admin/educator/students, routes AI to the local Ollama models,
 * and a Calculus course with concepts, prerequisites and practice items.
 */
import { loadConfig } from '@platform/core'
import { configureLogging } from '@platform/observability'
import { createDatabase } from '@platform/tenancy-db'
import { createSystemDatabase } from '@platform/tenancy-db/system'
import { createIdentityService, devOutboxTransport } from '@platform/identity'
import { ADAPTERS, createGateway, localKeyManager, type Actor } from '@platform/ai-gateway'
import { buildPlatform } from '@platform/module-runtime'
import { MODULES } from '../../apps/api/src/modules.generated.ts'

configureLogging({ level: 'warn' })
const c = loadConfig()
const db = createDatabase(c.appDatabaseUrl)
const system = createSystemDatabase(c.systemDatabaseUrl)
const chat = process.env.DEMO_CHAT_MODEL ?? 'qwen3:1.7b'
const emb = process.env.DEMO_EMBED_MODEL ?? 'qwen3-embedding:0.6b'
const dims = Number(process.env.EMBEDDING_DIMENSIONS ?? 1024)

const id = createIdentityService({ system, db, mail: devOutboxTransport(system), publicBaseUrl: c.publicBaseUrl })
const { tenantId, adminUserId } = await id.createTenant({ slug: 'demo-univ', name: 'Demo University', adminEmail: 'admin@demo.test', adminName: 'Asha (Admin)' })
await system.query(`update platform.tenants set enabled_modules = '{education.tutor}' where id = $1`, [tenantId])
await id.setPlatformAdmin('admin@demo.test', true)
const admin = { userId: adminUserId, tenantId, email: 'admin@demo.test', roles: ['tenant_admin'], isPlatformAdmin: true, sessionId: '' }
const prof = await id.upsertMember(admin, { email: 'prof@demo.test', roles: ['educator'], displayName: 'Dr. Rao' })
const stu = await id.upsertMember(admin, { email: 'stu@demo.test', roles: ['student'], displayName: 'Ankit' })
const stu2 = await id.upsertMember(admin, { email: 'stu2@demo.test', roles: ['student'], displayName: 'Priya' })
// demo users have already confirmed they are 18+ (PD-09)
await system.query(`update platform.users set age_attestation = 'adult', age_attested_at = now() where email like '%@demo.test'`)

// AI: local Ollama for tutoring + embeddings (routing configuration only; no code names a provider)
let gw: ReturnType<typeof createGateway>
const platform = buildPlatform(MODULES, { db, gateway: () => gw, embeddingDimensions: dims, documents: {} as never, retrieval: {} as never })
gw = createGateway({ system, keyManager: localKeyManager(c.masterKey), environment: c.env, adapters: ADAPTERS, tasks: platform.tasks })
const actor: Actor = { userId: adminUserId, tenantId, isPlatformAdmin: true, roles: ['tenant_admin'] }
const conn = await gw.admin.createConnection(actor, {
  adapter: 'ollama', name: 'Local Ollama', baseUrl: 'http://127.0.0.1:11434', allowPrivateNetwork: true, timeoutMs: 600_000,
  dataPolicy: { processingLocation: 'IN', selfHosted: true, retentionDays: 0, zeroRetention: true, trainsOnData: false, dpaInPlace: true, termsVerified: true },
})
await gw.admin.approveModel(actor, { adapter: 'ollama', modelId: chat, declared: { operations: ['generate', 'stream'], structuredOutput: 'json_schema', tools: 'single', reasoningControl: true, contextWindow: 40960 } })
await gw.admin.approveModel(actor, { adapter: 'ollama', modelId: emb, declared: { operations: ['embed'], embeddingDimensions: [dims] } })
const chatDep = await gw.admin.createDeployment(actor, { connectionId: conn.id, modelId: chat })
const embDep = await gw.admin.createDeployment(actor, { connectionId: conn.id, modelId: emb })
await gw.admin.setRoute(actor, { target: 'category:tutoring', candidates: [{ deploymentId: chatDep.id, params: { reasoning: 'off' } }] })
await gw.admin.setRoute(actor, { target: 'category:embeddings', candidates: [{ deploymentId: embDep.id }] })

// course content (as the educator, through RLS)
await db.withTenant({ tenantId, userId: prof.userId, roles: ['educator'] }, async (tx) => {
  const course = (await tx.query<{ id: string }>(`insert into education_tutor.courses (tenant_id, code, title, term, integrity_mode, created_by)
    values (platform.current_tenant(), 'MA101', 'Calculus I', 'Semester 1', 'guided', $1) returning id`, [prof.userId])).rows[0]!.id
  for (const [uid, role] of [[prof.userId, 'educator'], [stu.userId, 'student'], [stu2.userId, 'student']] as const) {
    await tx.query(`insert into education_tutor.enrolments (tenant_id, course_id, user_id, role) values (platform.current_tenant(), $1, $2, $3)`, [course, uid, role])
  }
  const concept = async (name: string, minutes: number, weight: number, pre: string[] = []) => {
    const cid = (await tx.query<{ id: string }>(`insert into education_tutor.concepts (tenant_id, course_id, name, description, est_minutes, exam_weight, status)
      values (platform.current_tenant(), $1, $2, '', $3, $4, 'approved') returning id`, [course, name, minutes, weight])).rows[0]!.id
    for (const p of pre) await tx.query(`insert into education_tutor.concept_edges (tenant_id, from_concept, to_concept) values (platform.current_tenant(), $1, $2)`, [p, cid])
    return cid
  }
  const functions = await concept('Functions', 40, 1)
  const limits = await concept('Limits', 60, 3, [functions])
  const derivatives = await concept('Derivatives', 90, 4, [limits])
  const item = (cid: string, stem: string, spec: unknown, explanation: string, difficulty: number) =>
    tx.query(`insert into education_tutor.items (tenant_id, course_id, concept_id, type, stem, answer_spec, explanation, difficulty)
      values (platform.current_tenant(), $1, $2, $3, $4, $5, $6, $7)`, [course, cid, (spec as { type: string }).type, stem, JSON.stringify(spec), explanation, difficulty])
  await item(functions, 'If f(x) = 2x + 3, what is f(4)?', { type: 'numeric', value: 11, tolerance: 0 }, 'Substitute x = 4: 2·4 + 3 = 11.', 0.3)
  await item(functions, 'Which of these is a function of x?', { type: 'mcq', options: ['y² = x', 'y = x²', 'x² + y² = 1'], correct: ['y = x²'] }, 'Each x gives exactly one y only for y = x².', 0.4)
  await item(limits, 'Find lim x→2 of (x + 40).', { type: 'numeric', value: 42, tolerance: 0 }, 'The function is continuous, so substitute x = 2.', 0.3)
  await item(limits, 'Find lim x→3 of (x² − 9)/(x − 3).', { type: 'numeric', value: 6, tolerance: 0 }, 'Factor: (x−3)(x+3)/(x−3) = x+3 → 6.', 0.6)
  await item(limits, 'lim x→0 of sin(x)/x equals', { type: 'mcq', options: ['0', '1', 'does not exist'], correct: ['1'] }, 'A standard limit (squeeze theorem).', 0.5)
  await item(derivatives, 'd/dx of x³ at x = 2?', { type: 'numeric', value: 12, tolerance: 0 }, '3x² at x = 2 gives 12.', 0.5)
  await item(derivatives, 'The derivative of a constant is', { type: 'mcq', options: ['0', '1', 'the constant'], correct: ['0'] }, 'A constant does not change.', 0.2)
})
console.log('Seeded demo-univ: admin@demo.test (platform+tenant admin), prof@demo.test (educator), stu@demo.test, stu2@demo.test (students)')
await db.close()
await system.close()
