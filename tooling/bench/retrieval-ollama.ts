/**
 * Retrieval benchmark with a REAL embedding model (local Ollama), on the project-local Postgres:
 *   node tooling/bench/retrieval-ollama.ts [pages=120] [model=qwen3-embedding:0.6b]
 * Measures ingestion (parse + chunk + embed + index) and hybrid search latency, and page-level
 * precision@1 on a small labelled query set. Requires `node tooling/dev-db.ts up` and Ollama.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { newId } from '@platform/core'
import { enqueue } from '@platform/jobs'
import { setupTestDb, makePdf } from '@platform/testing'
import { createDocumentService, documentsMigrations, localObjectStore, devNoopScanner } from '@platform/documents'
import { ADAPTERS, aiGatewayMigrations, createGateway, localKeyManager, TaskRegistry, type Actor } from '@platform/ai-gateway'
import { createRetrieval, embeddingTask, retrievalMigrations } from '@platform/retrieval'

const pagesN = Number(process.argv[2] ?? 120)
const model = process.argv[3] ?? 'qwen3-embedding:0.6b'
const TOPICS = [
  ['Kinematics', 'Velocity is the rate of change of displacement with time; acceleration is the rate of change of velocity.'],
  ['Newton laws', 'Newton second law states that the net force equals mass times acceleration.'],
  ['Work and energy', 'Kinetic energy equals one half of mass times the square of speed.'],
  ['Thermodynamics', 'The entropy of an isolated system never decreases over time.'],
  ['Optics', 'Snell law relates the angles of incidence and refraction to refractive indices.'],
  ['Electricity', 'Ohm law states that current through a conductor is proportional to voltage.'],
] as const
const QUERIES: [string, number][] = [
  ['how is force related to mass and acceleration', 1], ['what never decreases in an isolated system', 3],
  ['refraction angle relation', 4], ['current proportional to voltage', 5], ['formula for kinetic energy', 2], ['definition of velocity', 0],
]

const t = await setupTestDb([aiGatewayMigrations, documentsMigrations, retrievalMigrations])
const dir = await mkdtemp(join(tmpdir(), 'bench-'))
try {
  const tenant = newId()
  const user = newId()
  await t.system.query(`insert into platform.tenants (id, slug, name, type) values ($1, 'bench', 'Bench', 'institution')`, [tenant])
  const probe = await ADAPTERS.ollama!.embed!({ id: 'p', baseUrl: 'http://127.0.0.1:11434', http: (await import('@platform/ai-adapter-kit')).createHttpClient({ requireHttps: false, allowPrivateNetwork: true }), timeoutMs: 120_000 }, model, { inputs: ['x'], purpose: 'query' })
  const dims = probe.dimensions
  const tasks = new TaskRegistry()
  tasks.register(embeddingTask(dims))
  const gw = createGateway({ system: t.system, keyManager: localKeyManager(randomBytes(32)), environment: 'test', adapters: ADAPTERS, tasks })
  const admin: Actor = { userId: null, tenantId: null, isPlatformAdmin: true, roles: [] }
  const conn = await gw.admin.createConnection(admin, { adapter: 'ollama', name: 'local', baseUrl: 'http://127.0.0.1:11434', allowPrivateNetwork: true, timeoutMs: 300_000, dataPolicy: { processingLocation: 'IN', selfHosted: true, retentionDays: 0, zeroRetention: true, trainsOnData: false, dpaInPlace: true, termsVerified: true } })
  await gw.admin.approveModel(admin, { adapter: 'ollama', modelId: model, declared: { operations: ['embed'], embeddingDimensions: [dims] } })
  const dep = await gw.admin.createDeployment(admin, { connectionId: conn.id, modelId: model })
  await gw.admin.setRoute(admin, { target: 'category:embeddings', candidates: [{ deploymentId: dep.id }] })
  const docs = createDocumentService({ db: t.db, system: t.system, store: localObjectStore(dir, randomBytes(32)), scanner: devNoopScanner, enqueue: (tx, ty, pl, o) => enqueue(tx, ty, pl, o) })
  const rt = createRetrieval({ db: t.db, system: t.system, gateway: () => gw })
  const p = { tenantId: tenant, userId: user, roles: ['educator'] }
  const pages = Array.from({ length: pagesN }, (_, i) => {
    const [title, fact] = TOPICS[i % TOPICS.length]!
    return [`${title} (page ${i + 1})`, fact, ...Array.from({ length: 10 }, (_, j) => `Worked example ${j} on ${title.toLowerCase()} with numbers and units for revision practice.`)]
  })
  const d = await docs.upload(p, { ownerModule: 'education.tutor', scope: 'course:bench', visibility: 'scope', trust: 'verified_course', filename: 'bench.pdf', data: makePdf(pages) })
  const t0 = performance.now()
  await docs.process(d.id, async (doc, parsed) => { await rt.indexDocument(doc, parsed) })
  const ingestMs = performance.now() - t0
  const chunks = (await t.system.query<{ n: number }>('select count(*)::int as n from platform.chunks')).rows[0]!.n
  const lat: number[] = []
  let correct = 0
  for (let round = 0; round < 3; round++) {
    for (const [q, topic] of QUERIES) {
      const s = performance.now()
      const r = await rt.search(p, { ownerModule: 'education.tutor', scopes: ['course:bench'], query: q })
      lat.push(performance.now() - s)
      if (round === 0 && r.hits[0] && (r.hits[0].pageStart - 1) % TOPICS.length === topic) correct++
    }
  }
  lat.sort((a, b) => a - b)
  const pct = (x: number) => lat[Math.min(lat.length - 1, Math.floor(x * lat.length))]!.toFixed(0)
  console.log(JSON.stringify({ model, dims, pages: pagesN, chunks, ingestMs: Math.round(ingestMs), msPerChunk: Math.round(ingestMs / chunks), searchP50ms: pct(0.5), searchP95ms: pct(0.95), topicPrecisionAt1: `${correct}/${QUERIES.length}` }))
} finally {
  await t.close()
  await rm(dir, { recursive: true, force: true })
}
