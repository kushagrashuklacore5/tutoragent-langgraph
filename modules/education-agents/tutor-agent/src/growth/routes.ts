/** HTTP routes: self-tests, exam intelligence, hint ladder, observation/strategy, growth & outcomes, chapter packages. */
import { badRequest } from '@platform/core'
import type { JobContext, ModuleDeps, Principal, RouteDef } from '@platform/contracts'
import { obj, P, uuid } from '../common.ts'
import type { SourceKind } from '../domain/exam.ts'
import { EXTRACT_JOB, growthService, type Purpose } from './service.ts'

const KINDS: SourceKind[] = ['board_past_paper', 'board_sample_paper', 'school_paper', 'textbook_exercise', 'other']
const PURPOSES: Purpose[] = ['diagnostic', 'practice', 'mock', 'post', 'pattern_practice']
const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

export function growthRoutes(d: ModuleDeps): RouteDef[] {
  const g = growthService(d)
  return [
    { method: 'POST', path: '/courses/:courseId/self-tests', permission: P.study, handler: async ({ principal, params, body }) => {
      const b = obj(body)
      if (!PURPOSES.includes(b.purpose as Purpose)) throw badRequest('invalid_field', `purpose must be one of ${PURPOSES.join(', ')}`)
      return g.selfTest(principal, uuid(params.courseId, 'courseId'), { purpose: b.purpose as Purpose, conceptIds: Array.isArray(b.conceptIds) ? b.conceptIds.map((x) => uuid(x, 'conceptId')) : undefined, count: b.count === undefined ? undefined : Number(b.count) })
    } },
    { method: 'POST', path: '/courses/:courseId/exam/papers', permission: P.read, handler: async ({ principal, params, body }) => {
      const b = obj(body)
      if (!KINDS.includes(b.sourceKind as SourceKind)) throw badRequest('invalid_field', `sourceKind must be one of ${KINDS.join(', ')}`)
      const year = b.year === undefined || b.year === null || b.year === '' ? null : Number(b.year)
      if (year !== null && (!Number.isInteger(year) || year < 1990 || year > 2100)) throw badRequest('invalid_field', 'year must be a 4-digit year')
      return g.addPaper(principal, uuid(params.courseId, 'courseId'), { documentId: uuid(b.documentId, 'documentId'), sourceKind: b.sourceKind as SourceKind, title: text(b.title, 200) ?? 'Question paper', year, board: text(b.board, 80), school: text(b.school, 160) })
    } },
    { method: 'GET', path: '/courses/:courseId/exam/insights', permission: P.read, handler: async ({ principal, params, query }) => {
      const scope = query.get('scope')
      return g.insights(principal, uuid(params.courseId, 'courseId'), scope === 'board' || scope === 'school' ? scope : 'all')
    } },
    { method: 'POST', path: '/items/:itemId/hints', permission: P.study, handler: async ({ principal, params, body }) => g.hint(principal, uuid(params.itemId, 'itemId'), Number(obj(body).level)) },
    { method: 'GET', path: '/courses/:courseId/observation', permission: P.study, handler: async ({ principal, params }) => g.observation(principal, uuid(params.courseId, 'courseId')) },
    { method: 'GET', path: '/courses/:courseId/growth', permission: P.study, handler: async ({ principal, params }) => g.growth(principal, uuid(params.courseId, 'courseId')) },
    { method: 'PUT', path: '/growth/prefs', permission: P.study, handler: async ({ principal, body }) => {
      const b = obj(body)
      const pseudonym = text(b.pseudonym, 40)
      if (pseudonym && pseudonym.length < 2) throw badRequest('invalid_field', 'nickname must be 2-40 characters')
      return g.setPrefs(principal, { leaderboard: b.leaderboard === true, pseudonym, outcomesConsent: b.outcomesConsent === true })
    } },
    { method: 'GET', path: '/courses/:courseId/cohort-outcomes', permission: P.manage, handler: async ({ principal, params }) => g.cohort(principal, uuid(params.courseId, 'courseId')) },
    { method: 'POST', path: '/studio/books/:bookId/package', permission: P.study, handler: async ({ principal, params }) => g.buildPackage(principal, uuid(params.bookId, 'bookId')) },
    { method: 'GET', path: '/studio/books/:bookId/package', permission: P.study, handler: async ({ principal, params }) => g.getPackage(principal, uuid(params.bookId, 'bookId')) },
  ]
}

/** Job: extract questions from a paper, as the user who added it (their permissions, their AI budget). */
export const growthJobs = (d: ModuleDeps) => ({
  [EXTRACT_JOB]: async (ctx: JobContext) => {
    const { paperId, userId } = (ctx.job.payload ?? {}) as { paperId?: string; userId?: string }
    if (!paperId || !userId || !ctx.job.tenant_id) throw new Error('exam.extract needs paperId, userId and a tenant')
    const p: Principal = { userId, tenantId: ctx.job.tenant_id, email: '', roles: ['student'], isPlatformAdmin: false }
    const g = growthService(d)
    try { return await g.extract(p, paperId) } catch (e) {
      if ((ctx.job.attempts ?? 1) >= (ctx.job.max_attempts ?? 4)) await g.markExtractFailed(p, paperId, (e as Error).message).catch(() => {})
      throw e
    }
  },
})
