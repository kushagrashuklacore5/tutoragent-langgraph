// Re-export the gateway types modules are allowed to see (types only; no runtime coupling).
export type { CallContext, GatewayStreamEvent, RunInput, RunResult, RouteInfo, TaskDefinition } from '@platform/ai-gateway'
import type { RouteInfo } from '@platform/ai-gateway'

export interface EmbedResultWithRoute {
  vectors: number[][]
  dimensions: number
  route: RouteInfo
}
