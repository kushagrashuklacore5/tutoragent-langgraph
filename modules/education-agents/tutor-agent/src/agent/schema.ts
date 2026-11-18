/**
 * Minimal JSON-schema validator for agent tool inputs/outputs (modules cannot import the gateway's validator).
 * Supports: type (object|array|string|integer|number|boolean), properties, required, additionalProperties:false,
 * enum, minLength/maxLength, minimum/maximum, minItems/maxItems, items, pattern.
 */
export interface Schema {
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean'
  properties?: Record<string, Schema>
  required?: string[]
  additionalProperties?: boolean
  enum?: readonly unknown[]
  minLength?: number; maxLength?: number
  minimum?: number; maximum?: number
  minItems?: number; maxItems?: number
  items?: Schema
  pattern?: string
  description?: string
}

export function validate(schema: Schema, value: unknown, path = '$'): string[] {
  const errs: string[] = []
  const t = schema.type
  if (t === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${path} must be an object`]
    const o = value as Record<string, unknown>
    for (const k of schema.required ?? []) if (o[k] === undefined) errs.push(`${path}.${k} is required`)
    for (const [k, v] of Object.entries(o)) {
      const s = schema.properties?.[k]
      if (!s) { if (schema.additionalProperties === false) errs.push(`${path}.${k} is not allowed`); continue }
      if (v !== undefined) errs.push(...validate(s, v, `${path}.${k}`))
    }
    return errs
  }
  if (t === 'array') {
    if (!Array.isArray(value)) return [`${path} must be an array`]
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${path} needs at least ${schema.minItems} items`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errs.push(`${path} allows at most ${schema.maxItems} items`)
    if (schema.items) value.forEach((v, i) => errs.push(...validate(schema.items!, v, `${path}[${i}]`)))
    return errs
  }
  if (t === 'string') {
    if (typeof value !== 'string') return [`${path} must be a string`]
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${path} is too short`)
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errs.push(`${path} is too long`)
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errs.push(`${path} has an invalid format`)
  } else if (t === 'integer' || t === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (t === 'integer' && !Number.isInteger(value))) return [`${path} must be ${t === 'integer' ? 'a whole number' : 'a number'}`]
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path} must be >= ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path} must be <= ${schema.maximum}`)
  } else if (t === 'boolean') {
    if (typeof value !== 'boolean') return [`${path} must be true or false`]
  }
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path} must be one of ${schema.enum.join(', ')}`)
  return errs
}

export const UUID_PATTERN = '^[0-9a-fA-F-]{36}$'
