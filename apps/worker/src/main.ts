/**
 * Job worker host. Same fail-closed production rules as the API (see apps/api/src/main.ts).
 * Optional `WORKER_HEALTH_PORT` serves GET /health for container health checks.
 */
import http from 'node:http'
import { assertProductionReady, loadConfig, loadDocumentStorageConfig, type DocumentStorageConfig } from '@platform/core'
import { configureLogging, createOtlpExporter, logger, otlpOptionsFromEnv, type OtlpExporter } from '@platform/observability'
import { createDatabase, type Database } from '@platform/tenancy-db'
import { createSystemDatabase } from '@platform/tenancy-db/system'
import { createWorker } from '@platform/jobs'
import { createScheduler } from '@platform/jobs'
import { loadMailConfig } from '@platform/identity'
import { createGateway, ADAPTERS, keyManagerFromConfig, verifyKeyManager } from '@platform/ai-gateway'
import { clamdScanner, createDocumentService, devNoopScanner, localObjectStore, type ObjectStore, type Scanner } from '@platform/documents'
import { createRetrieval } from '@platform/retrieval'
import { createMathClient } from '@platform/math-client'
import { enqueue } from '@platform/jobs'
import { buildPlatform } from '@platform/module-runtime'
import { createFieldCrypto } from '@platform/module-runtime'
import { MODULES } from '../../api/src/modules.generated.ts'

/** The runtime role must be subject to RLS: not superuser, not BYPASSRLS, owns no tables. */
async function appRoleProblems(db: Database): Promise<string[]> {
  const r = await db.withAnonymous((tx) => tx.query<{ rolsuper: boolean; rolbypassrls: boolean; owned: number }>(`
    select r.rolsuper, r.rolbypassrls,
      (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relowner = r.oid and c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema')) as owned
    from pg_roles r where r.rolname = current_user`))
  const row = r.rows[0]
  if (!row) return ['APP_DATABASE_URL role not found']
  return [
    ...(row.rolsuper ? ['APP_DATABASE_URL role is a superuser'] : []),
    ...(row.rolbypassrls ? ['APP_DATABASE_URL role has BYPASSRLS'] : []),
    ...(row.owned ? [`APP_DATABASE_URL role owns ${row.owned} table(s)`] : []),
  ]
}

/** Object store + scanner for the documents processing job (undefined when DOCUMENTS_ENABLED=false). */
function documentStorage(c: DocumentStorageConfig): { store: ObjectStore; scanner: Scanner } | undefined {
  if (!c.enabled) return undefined
  return {
    store: localObjectStore(c.store.dir, c.store.key),
    scanner: c.scanner.kind === 'clamd' ? clamdScanner(c.scanner.host, c.scanner.port, c.scanner.timeoutMs) : devNoopScanner,
  }
}

const config = loadConfig()
configureLogging({ level: config.logLevel })
const prod = config.env === 'production'
assertProductionReady(config)
loadMailConfig(process.env, config.env) // a module job may send mail; validate the same settings as the API
const documents = documentStorage(loadDocumentStorageConfig(process.env, config))
const keyManager = await keyManagerFromConfig(config.kms, { env: config.env, masterKey: config.masterKey })

const db = createDatabase(config.appDatabaseUrl)
const system = createSystemDatabase(config.systemDatabaseUrl)
if (prod) {
  assertProductionReady(config, await appRoleProblems(db))
  await verifyKeyManager(keyManager)
}

const otlp = otlpOptionsFromEnv(process.env, { serviceName: 'ekbharat-worker', environment: config.env })
const exporter: OtlpExporter | undefined = otlp ? createOtlpExporter({ ...otlp, onError: (m) => logger.warn('telemetry export failed', { detail: m }) }) : undefined
exporter?.start()

let gateway: ReturnType<typeof createGateway>
// the documents processing job (scan -> parse -> chunk -> embed) runs here when documents are enabled
const docService = documents ? createDocumentService({ db, system, ...documents, enqueue: (tx, type, payload, opts) => enqueue(tx, type, payload, opts) }) : undefined
const retrieval = documents ? createRetrieval({ db, system, gateway: () => gateway }) : undefined
const platform = buildPlatform(MODULES, {
  db, gateway: () => gateway, crypto: createFieldCrypto({ system, keyManager }),
  documents: docService, retrieval, embeddingDimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 1024),
  math: process.env.MATH_SOLVER_URL ? createMathClient({ baseUrl: process.env.MATH_SOLVER_URL, allowRemote: prod }) : undefined,
})
gateway = createGateway({ system, keyManager, environment: config.env, adapters: ADAPTERS, tasks: platform.tasks })
// INTEGRATION HOOK: register the documents processing job (PROCESS_JOB) with `documents` when wired
const worker = createWorker({ system, db, handlers: platform.jobs })
worker.start()
const scheduler = createScheduler({ system, schedules: platform.schedules }) // recurring jobs; safe with many workers (idempotent per period)
scheduler.start()
logger.info('worker started', {
  workerId: worker.workerId, env: config.env, jobTypes: [...platform.jobs.keys()], keyManager: keyManager.id,
  documents: documents ? documents.scanner.id : 'disabled', telemetry: !!exporter,
})

let stopping = false
const health = process.env.WORKER_HEALTH_PORT
  ? http.createServer((req, res) => {
    const ok = req.url === '/health' && !stopping
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify({ status: ok ? 'ok' : 'stopping' }))
  }).listen(Number(process.env.WORKER_HEALTH_PORT))
  : undefined

async function stop(signal: string) {
  if (stopping) return
  stopping = true
  logger.info('worker stopping', { signal })
  await scheduler.stop()
  await worker.stop() // stops claiming; leases of in-flight jobs expire and are retried elsewhere
  health?.close()
  await exporter?.shutdown(5_000).catch(() => undefined)
  await Promise.allSettled([db.close(), system.close()])
  process.exit(0)
}
process.on('SIGTERM', () => void stop('SIGTERM'))
process.on('SIGINT', () => void stop('SIGINT'))
