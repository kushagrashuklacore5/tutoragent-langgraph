/**
 * API host. Production startup is fail-closed (deploy/RUNBOOK.md): it refuses to start unless a cloud
 * KMS, a real mail transport, an https public URL (Secure cookies), a metrics token, three separate
 * database roles and a production-grade document store + scanner (or DOCUMENTS_ENABLED=false) are
 * configured, the app role is neither superuser, BYPASSRLS nor a table owner, and the KMS answers a
 * wrap/unwrap round trip.
 */
import http from 'node:http'
import { assertProductionReady, loadConfig, loadDocumentStorageConfig, type DocumentStorageConfig } from '@platform/core'
import { configureLogging, createOtlpExporter, logger, otlpOptionsFromEnv, type OtlpExporter } from '@platform/observability'
import { createDatabase, type Database } from '@platform/tenancy-db'
import { createSystemDatabase } from '@platform/tenancy-db/system'
import { createMailTransport, loadMailConfig } from '@platform/identity'
import { keyManagerFromConfig, verifyKeyManager } from '@platform/ai-gateway'
import { clamdScanner, devNoopScanner, localObjectStore, type ObjectStore, type Scanner } from '@platform/documents'
import { createMathClient } from '@platform/math-client'
import { createApp } from './app.ts'
import { MODULES } from './modules.generated.ts'

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

/** Object store + malware scanner for packages/documents (undefined when DOCUMENTS_ENABLED=false). */
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
assertProductionReady(config) // configuration-only rules, before connecting anywhere
const mailConfig = loadMailConfig(process.env, config.env) // fails closed in production (no dev outbox, no plaintext SMTP)
const documents = documentStorage(loadDocumentStorageConfig(process.env, config)) // fails closed in production (no local store / no-op scanner)
const keyManager = await keyManagerFromConfig(config.kms, { env: config.env, masterKey: config.masterKey })

const db = createDatabase(config.appDatabaseUrl)
const system = createSystemDatabase(config.systemDatabaseUrl)
if (prod) {
  assertProductionReady(config, await appRoleProblems(db))
  await verifyKeyManager(keyManager)
}

const otlp = otlpOptionsFromEnv(process.env, { serviceName: 'ekbharat-api', environment: config.env })
const exporter: OtlpExporter | undefined = otlp ? createOtlpExporter({ ...otlp, onError: (m) => logger.warn('telemetry export failed', { detail: m }) }) : undefined
exporter?.start()

const app = createApp({
  env: config.env, db, system, keyManager, mail: createMailTransport(mailConfig, { system }),
  publicBaseUrl: config.publicBaseUrl, allowedOrigins: config.allowedOrigins, modules: MODULES, metricsToken: config.metricsToken,
  documents: documents ? { ...documents, embeddingDimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 1024) } : undefined,
  math: process.env.MATH_SOLVER_URL ? createMathClient({ baseUrl: process.env.MATH_SOLVER_URL, allowRemote: prod }) : undefined,
})
const server = http.createServer((req, res) => void app.handler(req, res))
server.listen(config.httpPort, () => logger.info('api listening', {
  port: config.httpPort, env: config.env, modules: MODULES.map((m) => m.id), keyManager: keyManager.id, mail: mailConfig.kind,
  documents: documents ? documents.scanner.id : 'disabled', telemetry: !!exporter,
}))

let stopping = false
async function stop(signal: string) {
  if (stopping) return
  stopping = true
  const graceMs = Number(process.env.SHUTDOWN_GRACE_MS ?? 10_000)
  logger.info('api stopping', { signal, graceMs })
  // stop accepting connections, let in-flight requests finish, then cut what is left
  const closed = new Promise<void>((r) => server.close(() => r()))
  server.closeIdleConnections()
  const force = setTimeout(() => server.closeAllConnections(), graceMs)
  await closed
  clearTimeout(force)
  await exporter?.shutdown(Math.min(5_000, graceMs)).catch(() => undefined)
  await Promise.allSettled([db.close(), system.close()])
  process.exit(0)
}
process.on('SIGTERM', () => void stop('SIGTERM'))
process.on('SIGINT', () => void stop('SIGINT'))
