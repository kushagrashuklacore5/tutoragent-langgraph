import { loadConfig } from '@platform/core'
import { configureLogging, logger } from '@platform/observability'
import { createDatabase } from '@platform/tenancy-db'
import { createSystemDatabase } from '@platform/tenancy-db/system'
import { createWorker } from '@platform/jobs'
import { createGateway, ADAPTERS, localKeyManager } from '@platform/ai-gateway'
import { buildPlatform } from '@platform/module-runtime'
import { MODULES } from '../../api/src/modules.generated.ts'

const config = loadConfig()
configureLogging({ level: config.logLevel })
const db = createDatabase(config.appDatabaseUrl)
const system = createSystemDatabase(process.env.SYSTEM_DATABASE_URL ?? config.databaseUrl)
let gateway: ReturnType<typeof createGateway>
const platform = buildPlatform(MODULES, { db, gateway: () => gateway })
gateway = createGateway({ system, keyManager: localKeyManager(config.masterKey), environment: config.env, adapters: ADAPTERS, tasks: platform.tasks })
const worker = createWorker({ system, db, handlers: platform.jobs })
worker.start()
logger.info('worker started', { workerId: worker.workerId, jobTypes: [...platform.jobs.keys()] })
const stop = async () => {
  await worker.stop()
  await Promise.all([db.close(), system.close()])
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
