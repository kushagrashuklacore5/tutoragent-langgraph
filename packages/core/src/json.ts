export type Json = string | number | boolean | null | Json[] | { [k: string]: Json }

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
