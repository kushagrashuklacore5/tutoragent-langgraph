/** Data-policy rules for routing (AI_GATEWAY.md § 8 step 3, § 11.4). */

export type DataClass = 'public' | 'course_content' | 'student_content'

/** Attributes of a connection, taken from the provider's verified terms (task V-1). */
export interface DataPolicy {
  /** ISO country code where inference is processed, e.g. 'IN', 'US'; 'unknown' if not stated */
  processingLocation: string
  /** runs on infrastructure we or the customer operate (e.g. Ollama); data does not leave it */
  selfHosted: boolean
  retentionDays: number | null
  zeroRetention: boolean
  /** null = unknown (treated as "may train") */
  trainsOnData: boolean | null
  dpaInPlace: boolean
  /** the terms above were verified in writing (V-1) */
  termsVerified: boolean
  sourceOfTerms?: string
}

export interface TenantAiPolicy {
  allowedLocations?: string[]
  requireZeroRetention?: boolean
  requireDpa?: boolean
  /** BYOK mode (default off) */
  byok?: 'off' | 'byok_only' | 'byok_preferred' | 'platform_only'
}

/** Reasons a connection may not process this data class for this tenant (empty = eligible). */
export function policyViolations(p: DataPolicy, dataClass: DataClass, tenant: TenantAiPolicy): string[] {
  const v: string[] = []
  const sensitive = dataClass === 'student_content'
  if (sensitive && !p.selfHosted) {
    if (!p.termsVerified) v.push('provider terms not verified (V-1) for student content')
    if (p.trainsOnData !== false) v.push('provider may train on data')
  }
  if (tenant.allowedLocations?.length && !tenant.allowedLocations.includes(p.processingLocation)) v.push(`processing location ${p.processingLocation} not allowed by tenant`)
  if (tenant.requireZeroRetention && !(p.zeroRetention || p.selfHosted)) v.push('tenant requires zero retention')
  if (tenant.requireDpa && !(p.dpaInPlace || p.selfHosted)) v.push('tenant requires a DPA')
  return v
}

/** Fallback rule: a candidate's data policy must be at least as strict as the primary's on every dimension. */
export function notLessStrict(candidate: DataPolicy, primary: DataPolicy): boolean {
  const dims = (p: DataPolicy) => [p.zeroRetention || p.selfHosted, p.trainsOnData === false || p.selfHosted, p.dpaInPlace || p.selfHosted, p.termsVerified || p.selfHosted]
  const c = dims(candidate)
  const pr = dims(primary)
  return pr.every((needed, i) => !needed || c[i])
}

export function isDataPolicy(x: unknown): x is DataPolicy {
  const p = x as DataPolicy
  return !!p && typeof p.processingLocation === 'string' && typeof p.selfHosted === 'boolean' && typeof p.zeroRetention === 'boolean' &&
    (p.trainsOnData === null || typeof p.trainsOnData === 'boolean') && typeof p.dpaInPlace === 'boolean' && typeof p.termsVerified === 'boolean' &&
    (p.retentionDays === null || typeof p.retentionDays === 'number')
}
