import http from 'node:http'
import { loadConfig } from '@platform/core'
import { configureLogging, logger } from '@platform/observability'
import { createDatabase } from '@platform/tenancy-db'
import { createSystemDatabase } from '@platform/tenancy-db/system'
import { devOutboxTransport } from '@platform/identity'
import { localKeyManager } from '@platform/ai-gateway'
import { createApp } from './app.ts'
import { MODULES } from './modules.generated.ts'

const config = loadConfig()
configureLogging({ level: config.logLevel })
if (config.env === 'production') {
  // a real transactional email provider (O-5) and cloud KMS (F12) must be wired before production use
  throw new Error('Production requires a configured mail transport and KMS; see FOUNDATION_IMPLEMENTATION F12 / O-5')
}
const db = createDatabase(config.appDatabaseUrl)
const system = createSystemDatabase(process.env.SYSTEM_DATABASE_URL ?? config.databaseUrl)
const app = createApp({
  env: config.env, db, system, keyManager: localKeyManager(config.masterKey), mail: devOutboxTransport(system),
  publicBaseUrl: config.publicBaseUrl, allowedOrigins: config.allowedOrigins, modules: MODULES, metricsToken: process.env.METRICS_TOKEN,
})
const server = http.createServer((req, res) => void app.handler(req, res))
server.listen(config.httpPort, () => logger.info('api listening', { port: config.httpPort, modules: MODULES.map((m) => m.id) }))
const stop = () => server.close(() => Promise.all([db.close(), system.close()]).then(() => process.exit(0)))
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
