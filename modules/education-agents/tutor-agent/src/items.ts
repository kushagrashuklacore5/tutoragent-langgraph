import { AppError, badRequest, notFound } from '@platform/core'
import type { ModuleDeps, Principal, RouteDef } from '@platform/contracts'
import type { Sql } from '@platform/tenancy-db'
import { validateSpec, type AnswerSpec } from './domain/scoring.ts'
import { obj, P, requireEnrolled, str, uuid } from './common.ts'

/**
 * Educator question management. Only educators OF THE COURSE (not merely educators in the
 * institution) may author, list, edit or retire its items. Answer keys are visible here and nowhere
 * a student can reach. Items are retired, never deleted (attempt history is preserved), and an
 * answer key cannot change once students have answered (past grades would silently change meaning).
 */

export const mathUnavailable = () => new AppError('math_unavailable', 'Answers to this question can\'t be checked right now, so nothing was recorded. Please try again shortly.', { status: 503 })

/** Shape + semantic validation of an educator-authored answer spec (expression answers must parse). */
export async function checkAnswerSpec(d: ModuleDeps, raw: unknown): Promise<AnswerSpec> {
  const spec = raw as AnswerSpec
  if (!spec || typeof spec !== 'object' || !['mcq', 'numeric', 'expression', 'short', 'descriptive'].includes(spec.type)) throw badRequest('answer_spec_invalid', 'answerSpec.type must be mcq, numeric, expression, short or descriptive')
  const problems = validateSpec(spec)
  if (problems.length) throw badRequest('answer_spec_invalid', problems.join('; '))
  if (spec.type === 'expression') {
    if (!d.math) throw mathUnavailable()
    const self = await d.math.equivalent(spec.value, spec.value, spec.assume ? { assume: spec.assume } : undefined)
    if (self.verdict === 'invalid') throw badRequest('answer_spec_invalid', `The answer is not a valid expression (${self.reason})`)
    if (!self.ok) throw mathUnavailable()
  }
  return spec
}

export async function requireCourseEducator(t: Sql, p: Principal, courseId: string) {
  const c = await requireEnrolled(t, p, courseId)
  if (c.role !== 'educator') throw new AppError('forbidden', 'Only educators of this course can manage its questions', { status: 403 })
  return c
}

const difficultyOf = (v: unknown) => {
  const n = Number(v ?? 0.5)
  if (!Number.isFinite(n) || n < 0 || n > 1) throw badRequest('difficulty_invalid', 'difficulty must be between 0 and 1')
  return n
}
export const COGNITIVE = ['recall', 'understand', 'apply', 'transfer', 'explain'] as const
const cognitiveOf = (v: unknown) => {
  if (v === undefined || v === null) return 'recall'
  if (typeof v !== 'string' || !(COGNITIVE as readonly string[]).includes(v)) throw badRequest('cognitive_invalid', `cognitive must be one of ${COGNITIVE.join(', ')}`)
  return v
}
const explanationOf = (v: unknown) => {
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string' || v.length > 8000) throw badRequest('explanation_invalid', 'explanation must be text (max 8000 chars)')
  return v
}

interface ItemRow {
  id: string; course_id: string; concept_id: string; concept_name: string; type: string; stem: string; answer_spec: AnswerSpec; explanation: string
  difficulty: string; retired_at: Date | null; created_at: Date; updated_at: Date | null; attempts: string; correct: string
  status: string; origin: string; learning_objective: string; cognitive: string; source_refs: unknown; validation: unknown
}

export function itemRoutes(d: ModuleDeps): RouteDef[] {
  const tx = <T>(p: Principal, fn: (t: Sql) => Promise<T>) => d.inTenant(p, fn)
  const loadItem = async (t: Sql, p: Principal, itemId: string) => {
    const it = (await t.query<{ id: string; course_id: string; answer_spec: AnswerSpec; retired_at: Date | null }>(
      'select id, course_id, answer_spec, retired_at from education_tutor.items where id = $1', [itemId])).rows[0]
    if (!it) throw notFound('Item')
    try { await requireCourseEducator(t, p, it.course_id) } catch (e) {
      // not enrolled in that course at all: do not reveal the item exists
      if (e instanceof AppError && e.status === 404) throw notFound('Item')
      throw e
    }
    return it
  }
  return [
    { method: 'POST', path: '/courses/:courseId/items', permission: P.manage, handler: async ({ principal, params, body }) => {
      const b = obj(body)
      const courseId = uuid(params.courseId, 'courseId')
      const spec = await checkAnswerSpec(d, b.answerSpec)
      const stem = str(b.stem, 'stem', 4000)
      const conceptId = uuid(b.conceptId, 'conceptId')
      return tx(principal, async (t) => {
        await requireCourseEducator(t, principal, courseId)
        const r = await t.query<{ id: string }>(
          `insert into education_tutor.items (tenant_id, course_id, concept_id, type, stem, answer_spec, explanation, difficulty, learning_objective, cognitive)
           select platform.current_tenant(), $1, c.id, $3, $4, $5, $6, $7, $8, $9 from education_tutor.concepts c where c.id = $2 and c.course_id = $1 returning id`,
          [courseId, conceptId, spec.type, stem, JSON.stringify(spec), explanationOf(b.explanation), difficultyOf(b.difficulty), typeof b.learningObjective === 'string' ? b.learningObjective.slice(0, 500) : '', cognitiveOf(b.cognitive)])
        if (!r.rows[0]) throw notFound('Concept')
        await d.audit(t, principal, { action: 'item.created', targetType: 'item', targetId: r.rows[0].id })
        return { id: r.rows[0].id }
      })
    } },
    { method: 'GET', path: '/courses/:courseId/items', permission: P.manage, handler: async ({ principal, params, query }) => {
      const courseId = uuid(params.courseId, 'courseId')
      const conceptId = query.get('conceptId')
      const includeRetired = query.get('includeRetired') === 'true'
      return tx(principal, async (t) => {
        await requireCourseEducator(t, principal, courseId)
        const rows = (await t.query<ItemRow>(
          `select i.id, i.course_id, i.concept_id, c.name as concept_name, i.type, i.stem, i.answer_spec, i.explanation, i.difficulty, i.retired_at, i.created_at, i.updated_at,
                  i.status, i.origin, i.learning_objective, i.cognitive, i.source_refs, i.validation,
                  (select count(*) from education_tutor.attempts a where a.item_id = i.id) as attempts,
                  (select count(*) from education_tutor.attempts a where a.item_id = i.id and a.outcome >= 1) as correct
             from education_tutor.items i join education_tutor.concepts c on c.id = i.concept_id
            where i.course_id = $1 and ($2::uuid is null or i.concept_id = $2) and ($3 or i.retired_at is null) and ($4::text is null or i.status = $4)
            order by c.name, i.created_at, i.id limit 1000`,
          [courseId, conceptId ? uuid(conceptId, 'conceptId') : null, includeRetired, query.get('status') === 'draft' || query.get('status') === 'approved' ? query.get('status') : null])).rows
        return rows.map((r) => ({
          id: r.id, conceptId: r.concept_id, conceptName: r.concept_name, type: r.type, stem: r.stem, answerSpec: r.answer_spec, explanation: r.explanation,
          difficulty: Number(r.difficulty), retired: r.retired_at !== null, status: r.status, origin: r.origin, learningObjective: r.learning_objective, cognitive: r.cognitive, sourceRefs: r.source_refs, validation: r.validation, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at?.toISOString() ?? null,
          // attempts counts every student's attempts: visible via the course-educator RLS read policy
          stats: { attempts: Number(r.attempts), correctRate: Number(r.attempts) ? Math.round((Number(r.correct) / Number(r.attempts)) * 1000) / 1000 : null },
        }))
      })
    } },
    { method: 'PUT', path: '/items/:itemId', permission: P.manage, handler: async ({ principal, params, body }) => {
      const itemId = uuid(params.itemId, 'itemId')
      const b = obj(body)
      const spec = b.answerSpec === undefined ? undefined : await checkAnswerSpec(d, b.answerSpec)
      return tx(principal, async (t) => {
        const it = await loadItem(t, principal, itemId)
        if (spec && JSON.stringify(spec) !== JSON.stringify(it.answer_spec)) {
          const n = Number((await t.query<{ n: string }>('select count(*) as n from education_tutor.attempts where item_id = $1', [itemId])).rows[0]!.n)
          if (n > 0) throw new AppError('answer_locked', `Students have already answered this question (${n} attempt${n === 1 ? '' : 's'}), so its answer can't change. Retire it and add a corrected question instead.`, { status: 409 })
        }
        const sets: string[] = []
        const vals: unknown[] = [itemId]
        const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`) }
        if (b.stem !== undefined) set('stem', str(b.stem, 'stem', 4000))
        if (b.explanation !== undefined) set('explanation', explanationOf(b.explanation))
        if (b.difficulty !== undefined) set('difficulty', difficultyOf(b.difficulty))
        if (b.cognitive !== undefined) set('cognitive', cognitiveOf(b.cognitive))
        if (typeof b.learningObjective === 'string') set('learning_objective', b.learningObjective.slice(0, 500))
        if (spec) { set('answer_spec', JSON.stringify(spec)); set('type', spec.type) }
        if (!sets.length) throw badRequest('nothing_to_update', 'Send at least one of stem, explanation, difficulty, answerSpec')
        await t.query(`update education_tutor.items set ${sets.join(', ')}, updated_at = now() where id = $1`, vals)
        await d.audit(t, principal, { action: 'item.updated', targetType: 'item', targetId: itemId, metadata: { fields: sets.map((s) => s.split(' ')[0]) } })
        return { id: itemId }
      })
    } },
    { method: 'POST', path: '/items/:itemId/approve', permission: P.manage, handler: async ({ principal, params }) => tx(principal, async (t) => {
      const itemId = uuid(params.itemId, 'itemId')
      await loadItem(t, principal, itemId)
      // re-validate at approval time: a draft edited after generation must still be a valid, gradable item
      const it = (await t.query<{ answer_spec: AnswerSpec }>('select answer_spec from education_tutor.items where id = $1', [itemId])).rows[0]!
      await checkAnswerSpec(d, it.answer_spec)
      await t.query(`update education_tutor.items set status = 'approved', approved_by = platform.current_user_id(), approved_at = now(), updated_at = now() where id = $1`, [itemId])
      await d.audit(t, principal, { action: 'item.approved', targetType: 'item', targetId: itemId })
    }) },
    { method: 'POST', path: '/items/:itemId/retire', permission: P.manage, handler: async ({ principal, params }) => tx(principal, async (t) => {
      const itemId = uuid(params.itemId, 'itemId')
      await loadItem(t, principal, itemId)
      await t.query('update education_tutor.items set retired_at = coalesce(retired_at, now()), updated_at = now() where id = $1', [itemId])
      await d.audit(t, principal, { action: 'item.retired', targetType: 'item', targetId: itemId })
    }) },
    { method: 'POST', path: '/items/:itemId/restore', permission: P.manage, handler: async ({ principal, params }) => tx(principal, async (t) => {
      const itemId = uuid(params.itemId, 'itemId')
      await loadItem(t, principal, itemId)
      await t.query('update education_tutor.items set retired_at = null, updated_at = now() where id = $1', [itemId])
      await d.audit(t, principal, { action: 'item.restored', targetType: 'item', targetId: itemId })
    }) },
  ]
}
