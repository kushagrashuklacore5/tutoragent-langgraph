import { NO_CAPABILITIES, type Capabilities, type Operation, type StructuredLevel, type ToolLevel } from '@platform/ai-adapter-kit'

const SO_RANK: Record<StructuredLevel, number> = { none: 0, json_mode: 1, json_schema: 2 }
const TOOL_RANK: Record<ToolLevel, number> = { none: 0, single: 1, parallel: 2 }

/** What a task needs from a model. */
export interface TaskRequirements {
  operation: Operation
  structuredOutput?: StructuredLevel
  tools?: ToolLevel
  forcedToolChoice?: boolean
  vision?: boolean
  minContext?: number
  /** embeddings: exact output dimension the task's index expects */
  embeddingDimensions?: number
}

/** Reasons why `caps` does not satisfy `req` (empty = satisfied). */
export function capabilityGaps(caps: Capabilities, req: TaskRequirements): string[] {
  const gaps: string[] = []
  if (!caps.operations.includes(req.operation)) gaps.push(`operation ${req.operation} not supported`)
  if (req.structuredOutput && SO_RANK[caps.structuredOutput] < SO_RANK[req.structuredOutput]) gaps.push(`structured output ${caps.structuredOutput} < ${req.structuredOutput}`)
  if (req.tools && TOOL_RANK[caps.tools] < TOOL_RANK[req.tools]) gaps.push(`tools ${caps.tools} < ${req.tools}`)
  if (req.forcedToolChoice && !caps.forcedToolChoice) gaps.push('forced tool choice not supported')
  if (req.vision && !caps.vision) gaps.push('vision not supported')
  if (req.minContext && (caps.contextWindow ?? 0) < req.minContext) gaps.push(`context window ${caps.contextWindow ?? 'unknown'} < ${req.minContext}`)
  if (req.embeddingDimensions && !caps.embeddingDimensions.includes(req.embeddingDimensions)) gaps.push(`embedding dimensions ${caps.embeddingDimensions.join('/') || 'unknown'} do not include ${req.embeddingDimensions}`)
  return gaps
}

/** Narrow capabilities by an admin allowlist (a connection may disable features a model has). */
export function narrow(caps: Capabilities, allow: Partial<Capabilities> | null | undefined): Capabilities {
  if (!allow) return caps
  return {
    operations: allow.operations ? caps.operations.filter((o) => allow.operations!.includes(o)) : caps.operations,
    structuredOutput: allow.structuredOutput && SO_RANK[allow.structuredOutput] < SO_RANK[caps.structuredOutput] ? allow.structuredOutput : caps.structuredOutput,
    tools: allow.tools && TOOL_RANK[allow.tools] < TOOL_RANK[caps.tools] ? allow.tools : caps.tools,
    forcedToolChoice: caps.forcedToolChoice && allow.forcedToolChoice !== false,
    vision: caps.vision && allow.vision !== false,
    reasoningControl: caps.reasoningControl && allow.reasoningControl !== false,
    contextWindow: caps.contextWindow,
    maxOutputTokens: caps.maxOutputTokens,
    embeddingDimensions: caps.embeddingDimensions,
  }
}

/** Fill a partial capability object with conservative defaults. */
export function normalizeCapabilities(p: Partial<Capabilities> | null | undefined): Capabilities {
  return { ...NO_CAPABILITIES, ...(p ?? {}), operations: [...(p?.operations ?? [])], embeddingDimensions: [...(p?.embeddingDimensions ?? [])] }
}

/** The strongest structured-output mode both sides support (for building the request). */
export function structuredMode(caps: Capabilities): 'json_schema' | 'json_mode' | null {
  return caps.structuredOutput === 'json_schema' ? 'json_schema' : caps.structuredOutput === 'json_mode' ? 'json_mode' : null
}
