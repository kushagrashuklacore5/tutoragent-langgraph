/** HTTP routes of the Learning Studio (students' own books; owner-only). */
import { badRequest } from '@platform/core'
import type { ModuleDeps, RouteDef } from '@platform/contracts'
import { obj, P, str, uuid } from '../common.ts'
import { cleanNotebook } from './blocks.ts'
import { studioService } from './service.ts'

const LANG = ['en', 'hi', 'hinglish'] as const
const MODES = ['read', 'listen', 'read_listen', 'conversation'] as const
const COLORS = ['yellow', 'green', 'blue', 'pink'] as const
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** Recognise an uploaded photo by its bytes (never trust the declared type). */
export function sniffImage(b: Buffer): string | null {
  if (b.length > 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'image/png'
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

export function studioRoutes(d: ModuleDeps): RouteDef[] {
  const s = studioService(d)
  const int = (v: unknown, name: string) => { const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 10_000) throw badRequest('invalid_field', `${name} must be a page number`); return n }
  return [
    { method: 'GET', path: '/studio/books', permission: P.study, handler: async ({ principal }) => s.list(principal) },
    { method: 'POST', path: '/studio/books', permission: P.study, handler: async ({ principal, body }) => {
      const b = obj(body)
      return s.create(principal, {
        courseId: uuid(b.courseId, 'courseId'), title: typeof b.title === 'string' ? b.title.trim().slice(0, 200) : '',
        documentId: b.documentId ? uuid(b.documentId, 'documentId') : undefined, language: LANG.includes(b.language as never) ? (b.language as (typeof LANG)[number]) : 'en',
      })
    } },
    { method: 'GET', path: '/studio/books/:bookId', permission: P.study, handler: async ({ principal, params }) => s.view(principal, uuid(params.bookId, 'bookId')) },
    { method: 'DELETE', path: '/studio/books/:bookId', permission: P.study, handler: async ({ principal, params }) => s.remove(principal, uuid(params.bookId, 'bookId')) },
    { method: 'POST', path: '/studio/books/:bookId/sections/:sectionId/generate', permission: P.study, handler: async ({ principal, params, signal }) => {
      const sectionId = String(params.sectionId)
      if (!/^s\d{1,2}$/.test(sectionId)) throw badRequest('invalid_field', 'Unknown section')
      return { stream: s.generate(principal, uuid(params.bookId, 'bookId'), sectionId, signal) }
    } },
    { method: 'POST', path: '/studio/books/:bookId/events', permission: P.study, handler: async ({ principal, params, body }) => {
      const b = obj(body)
      const kind = b.kind as 'view' | 'advance' | 'mode'
      return s.onEvent(principal, uuid(params.bookId, 'bookId'), {
        kind, pageNo: b.pageNo === undefined ? undefined : int(b.pageNo, 'pageNo'), blockId: typeof b.blockId === 'string' ? b.blockId.slice(0, 40) : undefined,
        mode: MODES.includes(b.mode as never) ? (b.mode as (typeof MODES)[number]) : undefined,
      })
    } },
    { method: 'POST', path: '/studio/books/:bookId/ask', permission: P.study, handler: async ({ principal, params, body }) => {
      const b = obj(body)
      return s.ask(principal, uuid(params.bookId, 'bookId'), {
        question: str(b.question, 'question', 1500), selection: typeof b.selection === 'string' && b.selection.trim() ? b.selection.trim().slice(0, 1500) : null,
        pageNo: int(b.pageNo, 'pageNo'), blockId: typeof b.blockId === 'string' ? b.blockId.slice(0, 40) : null,
        source: b.source === 'voice' ? 'voice' : b.selection ? 'highlight' : 'question',
      })
    } },
    { method: 'POST', path: '/studio/books/:bookId/resume', permission: P.study, handler: async ({ principal, params }) => s.resume(principal, uuid(params.bookId, 'bookId')) },
    { method: 'POST', path: '/studio/books/:bookId/activities/:blockId/answer', permission: P.study, handler: async ({ principal, params, body }) =>
      s.answer(principal, uuid(params.bookId, 'bookId'), String(params.blockId).slice(0, 40), obj(body).answer) },
    { method: 'PUT', path: '/studio/books/:bookId/notebook', permission: P.study, handler: async ({ principal, params, body }) => {
      const b = obj(body)
      const doc = cleanNotebook(b.doc, 'Notebook')
      if (!doc) throw badRequest('invalid_notebook', 'The notebook could not be read')
      return s.saveNotebook(principal, uuid(params.bookId, 'bookId'), doc, Number(b.version))
    } },
    { method: 'GET', path: '/studio/books/:bookId/notebook/versions', permission: P.study, handler: async ({ principal, params }) => s.notebookVersions(principal, uuid(params.bookId, 'bookId')) },
    { method: 'POST', path: '/studio/books/:bookId/annotations', permission: P.study, handler: async ({ principal, params, body }) => {
      const b = obj(body)
      const kind = ['bookmark', 'highlight', 'note'].includes(String(b.kind)) ? (b.kind as 'bookmark' | 'highlight' | 'note') : null
      if (!kind) throw badRequest('invalid_field', 'kind must be bookmark, highlight or note')
      return s.annotate(principal, uuid(params.bookId, 'bookId'), {
        pageNo: int(b.pageNo, 'pageNo'), blockId: typeof b.blockId === 'string' ? b.blockId.slice(0, 40) : null, kind,
        quote: typeof b.quote === 'string' && b.quote.trim() ? b.quote.trim().slice(0, 2000) : null,
        note: typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 4000) : null,
        color: COLORS.includes(b.color as never) ? (b.color as string) : kind === 'highlight' ? 'yellow' : null,
      })
    } },
    { method: 'DELETE', path: '/studio/books/:bookId/annotations/:annotationId', permission: P.study, handler: async ({ principal, params }) =>
      s.unannotate(principal, uuid(params.bookId, 'bookId'), uuid(params.annotationId, 'annotationId')) },
    { method: 'POST', path: '/courses/:courseId/studio/ocr', permission: P.study, rawBody: { maxBytes: MAX_IMAGE_BYTES }, handler: async ({ principal, params, body, query }) => {
      if (!Buffer.isBuffer(body) || !body.length) throw badRequest('file_required', 'Send the photo as the request body')
      const type = sniffImage(body)
      if (!type) throw badRequest('unsupported_image', 'Send a PNG, JPEG or WebP photo')
      return s.ocr(principal, uuid(params.courseId, 'courseId'), body, type, (query.get('filename') ?? 'notes').slice(0, 120))
    } },
  ]
}
