import { fileURLToPath } from 'node:url'
import type { MigrationSet } from '@platform/tenancy-db'

export * from './gateway.ts'
export * from './tasks.ts'
export * from './capabilities.ts'
export * from './policy.ts'
export * from './secrets.ts'
export { costMicros } from './metering.ts'
export type { Pricing, RouteCandidate } from './store.ts'
export { ADAPTERS } from './adapters.generated.ts'
export { GatewayError } from '@platform/ai-adapter-kit'
export type { Capabilities, Message, ToolCall, ToolDefinition, Usage } from '@platform/ai-adapter-kit'

export const aiGatewayMigrations: MigrationSet = {
  owner: 'platform.ai-gateway',
  schema: 'platform',
  dir: fileURLToPath(new URL('../migrations', import.meta.url)),
}
