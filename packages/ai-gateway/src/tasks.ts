import { AppError } from '@platform/core'
import type { TaskRequirements } from './capabilities.ts'
import type { DataClass } from './policy.ts'

/**
 * A unit of AI work declared by a module. It states NEEDS only — never a provider, model,
 * connection, key or URL (rule M9). Providers are chosen by routing configuration.
 */
export interface TaskDefinition {
  /** `<module-id>.<task>`, e.g. `education.tutor.socratic_turn` */
  id: string
  /** module id that owns the task */
  owner: string
  /** routing category, e.g. tutoring, reasoning, embeddings, document_processing, assessment */
  category: string
  requires: TaskRequirements
  dataClass: DataClass
  /** 'pinned' tasks (grading, scoring) never switch model */
  determinism: 'flexible' | 'pinned'
  fallback: 'none' | 'eligible_only'
  /** JSON Schema the output must satisfy (validated by the gateway for every provider) */
  outputSchema?: Record<string, unknown>
  evalSuite?: string
  defaults?: { maxOutputTokens?: number; temperature?: number; reasoning?: 'off' | 'low' | 'medium' | 'high' }
}

const ALLOWED_KEYS = new Set(['id', 'owner', 'category', 'requires', 'dataClass', 'determinism', 'fallback', 'outputSchema', 'evalSuite', 'defaults'])
const FORBIDDEN = /^(provider|model|modelId|connection|connectionId|apiKey|baseUrl|adapter|deployment)$/i
const ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/
const CATEGORY = /^[a-z][a-z0-9_]*$/

export class TaskRegistry {
  private tasks = new Map<string, TaskDefinition>()

  register(t: TaskDefinition): void {
    for (const k of Object.keys(t)) {
      if (FORBIDDEN.test(k)) throw new AppError('task_provider_field', `Task ${t.id}: "${k}" is not allowed — tasks declare needs, routing chooses providers`)
      if (!ALLOWED_KEYS.has(k)) throw new AppError('task_invalid', `Task ${t.id}: unknown field "${k}"`)
    }
    if (!ID.test(t.id)) throw new AppError('task_invalid', `Task id ${t.id} must look like <module>.<task>`)
    if (!t.id.startsWith(t.owner + '.')) throw new AppError('task_namespace', `Task ${t.id} must be namespaced by its owner ${t.owner}`)
    if (!CATEGORY.test(t.category)) throw new AppError('task_invalid', `Task ${t.id}: invalid category`)
    if (t.requires.operation === 'embed' && t.fallback !== 'none') throw new AppError('task_invalid', `Task ${t.id}: embedding tasks cannot fall back (vectors are not comparable)`)
    if (t.determinism === 'pinned' && t.fallback !== 'none') throw new AppError('task_invalid', `Task ${t.id}: pinned tasks cannot fall back`)
    if (t.outputSchema && !t.requires.structuredOutput) throw new AppError('task_invalid', `Task ${t.id}: outputSchema requires requires.structuredOutput`)
    if (this.tasks.has(t.id)) throw new AppError('task_duplicate', `Task ${t.id} already registered`)
    this.tasks.set(t.id, t)
  }

  get(id: string): TaskDefinition | undefined {
    return this.tasks.get(id)
  }
  inCategory(category: string): TaskDefinition[] {
    return [...this.tasks.values()].filter((t) => t.category === category)
  }
  list(): TaskDefinition[] {
    return [...this.tasks.values()].sort((a, b) => a.id.localeCompare(b.id))
  }
  ids(): string[] {
    return this.list().map((t) => t.id)
  }
}
