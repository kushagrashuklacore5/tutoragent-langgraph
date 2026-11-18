// Re-export the gateway types modules are allowed to see (types only; no runtime coupling).
export type { CallContext, GatewayStreamEvent, RunInput, RunResult, RouteInfo, TaskDefinition } from '@platform/ai-gateway'
import type { RouteInfo } from '@platform/ai-gateway'

export interface EmbedResultWithRoute {
  vectors: number[][]
  dimensions: number
  route: RouteInfo
}

/** Speech-to-text input for a module's transcription task (audio stays in memory; never stored by the gateway). */
export interface TranscribeInput { audio: Buffer; mimeType: string; language?: string; prompt?: string }
export interface TranscribeResultWithRoute { text: string; language: string | null; durationSec: number | null; route: RouteInfo }
