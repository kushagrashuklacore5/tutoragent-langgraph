import type { HttpClient } from './http.ts'
import type { DiscoveredModel, EmbedRequest, EmbedResult, GenerateRequest, GenerateResult, Operation, StreamEvent } from './types.ts'

/** A connection after the gateway resolved its secret and network policy. Never logged or persisted. */
export interface ResolvedConnection {
  id: string
  baseUrl: string
  apiKey?: string
  http: HttpClient
  timeoutMs: number
}

export interface AdapterDescriptor {
  /** stable adapter type id, e.g. `openai`, `ollama` */
  type: string
  version: string
  displayName: string
  operations: Operation[]
  /** used when a connection does not set a base URL */
  defaultBaseUrl?: string
  requiresApiKey: boolean
  supportsDiscovery: boolean
  /** may connect to private/loopback hosts when a platform admin allows it (self-hosted servers) */
  supportsPrivateNetwork: boolean
}

export interface ConnectionTestResult {
  ok: boolean
  latencyMs: number
  error?: { kind: string; message: string }
  modelCount?: number
}

/**
 * The contract every provider adapter implements. Adapters are stateless, receive credentials per
 * call, never read env vars or files, and never log request bodies.
 */
export interface ProviderAdapter {
  descriptor: AdapterDescriptor
  testConnection(conn: ResolvedConnection): Promise<ConnectionTestResult>
  listModels?(conn: ResolvedConnection): Promise<DiscoveredModel[]>
  generate(conn: ResolvedConnection, model: string, req: GenerateRequest, signal?: AbortSignal): Promise<GenerateResult>
  stream(conn: ResolvedConnection, model: string, req: GenerateRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>
  embed?(conn: ResolvedConnection, model: string, req: EmbedRequest, signal?: AbortSignal): Promise<EmbedResult>
}

/** Small helper so adapters can implement testConnection via listModels or a cheap call. */
export async function timed<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; ms: number }> {
  const t = performance.now()
  try {
    const value = await fn()
    return { value, ms: Math.round(performance.now() - t) }
  } catch (error) {
    return { error, ms: Math.round(performance.now() - t) }
  }
}
