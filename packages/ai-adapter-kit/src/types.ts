/**
 * Provider-neutral AI types shared by the gateway and every adapter.
 * Nothing here is specific to any vendor.
 */

export type Operation = 'generate' | 'stream' | 'embed' | 'transcribe'
export type StructuredLevel = 'none' | 'json_mode' | 'json_schema'
export type ToolLevel = 'none' | 'single' | 'parallel'

/** What a model (as deployed on a connection) can do. */
export interface Capabilities {
  operations: Operation[]
  structuredOutput: StructuredLevel
  tools: ToolLevel
  forcedToolChoice: boolean
  vision: boolean
  reasoningControl: boolean
  contextWindow: number | null
  maxOutputTokens: number | null
  /** supported output dimensions for embedding models; empty for non-embedding models */
  embeddingDimensions: number[]
}

export const NO_CAPABILITIES: Capabilities = {
  operations: [],
  structuredOutput: 'none',
  tools: 'none',
  forcedToolChoice: false,
  vision: false,
  reasoningControl: false,
  contextWindow: null,
  maxOutputTokens: null,
  embeddingDimensions: [],
}

export interface ImagePart { type: 'image'; mediaType: string; dataBase64: string }
export interface TextPart { type: 'text'; text: string }
export type ContentPart = TextPart | ImagePart

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string }

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema for the arguments object */
  parameters: Record<string, unknown>
}

export type ToolChoice = 'auto' | 'none' | 'required' | { tool: string }

/**
 * `mode` is decided by the gateway from the deployment's verified capability, never by the adapter:
 * - json_schema: use the provider's native schema-constrained output
 * - json_mode: ask for JSON via the provider's JSON mode / equivalent; the gateway validates
 */
export type ResponseFormat = { type: 'text' } | { type: 'json'; mode: 'json_schema' | 'json_mode'; schema: Record<string, unknown>; name: string }

export interface GenerateRequest {
  messages: Message[]
  tools?: ToolDefinition[]
  toolChoice?: ToolChoice
  responseFormat?: ResponseFormat
  maxOutputTokens: number
  temperature?: number
  reasoning?: 'off' | 'low' | 'medium' | 'high'
  stop?: string[]
  seed?: number
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error'

export interface Usage {
  inputTokens: number | null
  outputTokens: number | null
  cachedInputTokens: number | null
  reasoningTokens: number | null
}
export const EMPTY_USAGE: Usage = { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null }

export interface GenerateResult {
  text: string
  toolCalls: ToolCall[]
  finish: FinishReason
  usage: Usage
}

export type StreamEvent =
  | { t: 'start' }
  | { t: 'text'; delta: string }
  | { t: 'tool_call'; call: ToolCall }
  | { t: 'usage'; usage: Usage }
  | { t: 'finish'; finish: FinishReason }

export interface EmbedRequest {
  inputs: string[]
  purpose: 'document' | 'query'
  dimensions?: number
}
export interface EmbedResult {
  vectors: number[][]
  dimensions: number
  usage: Usage
}

/** Speech-to-text. `language` is an ISO-639-1 hint (e.g. 'hi', 'en'); omitted = auto-detect. */
export interface TranscribeRequest {
  audio: Buffer
  mimeType: string
  filename?: string
  language?: string
  /** domain words to bias recognition (course title, concept names) */
  prompt?: string
}
export interface TranscribeResult {
  text: string
  language: string | null
  durationSec: number | null
  usage: Usage
}

export interface DiscoveredModel {
  id: string
  displayName?: string
  contextWindow?: number
  maxOutputTokens?: number
  /** hints only; never trusted for routing until probed */
  operationsHint?: Operation[]
  capabilitiesHint?: Partial<Capabilities>
}
