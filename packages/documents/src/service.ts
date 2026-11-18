import { AppError, badRequest, newId, notFound, sha256 } from '@platform/core'
import { counter, histogram, logger } from '@platform/observability'
import type { Database, Sql, TenantContext } from '@platform/tenancy-db'
import type { SystemDatabase } from '@platform/tenancy-db/system'
import { recordAudit, recordSystemAudit } from '@platform/audit'
import { parseDocument, type ParsedDocument } from './parse.ts'
import type { ObjectStore, Scanner } from './storage.ts'
import { validateUpload } from './validate.ts'

export interface DocumentRow {
  id: string
  tenant_id: string
  owner_user_id: string
  owner_module: string
  scope: string
  visibility: 'private' | 'scope'
  trust: 'verified_course' | 'student_upload'
  filename: string
  mime: string
  kind: 'pdf' | 'docx' | 'pptx' | 'text'
  size_bytes: number
  sha256: string
  storage_key: string
  version: number
  supersedes: string | null
  status: 'uploaded' | 'processing' | 'ready' | 'failed' | 'superseded'
  stage: string | null
  error: string | null
  page_count: number | null
  locator_kind: 'page' | 'slide' | 'section' | null
  created_at: Date
  processed_at: Date | null
}

export interface UploadInput {
  ownerModule: string
  scope: string
  visibility: 'private' | 'scope'
  trust: 'verified_course' | 'student_upload'
  filename: string
  data: Buffer
  supersedes?: string
}

export type Principal = TenantContext & { userId: string }
/** Called after parsing (e.g. retrieval indexing); runs in the processing job. */
export type AfterParse = (doc: DocumentRow, parsed: ParsedDocument) => Promise<void>

export const PROCESS_JOB = 'platform.documents/process'

export function createDocumentService(o: {
  db: Database
  system: SystemDatabase
  store: ObjectStore
  scanner: Scanner
  enqueue: (tx: Sql, type: string, payload: unknown, opts?: { idempotencyKey?: string }) => Promise<unknown>
  parseTimeoutMs?: number
}) {
  const inTenant = <T>(p: Principal, fn: (tx: Sql) => Promise<T>) => o.db.withTenant({ tenantId: p.tenantId, userId: p.userId, roles: p.roles }, fn)

  async function load(tx: Sql, id: string): Promise<DocumentRow> {
    const r = await tx.query<DocumentRow>('select * from platform.documents where id = $1', [id])
    if (!r.rows[0]) throw notFound('Document')
    return r.rows[0]
  }

  return {
    async upload(p: Principal, input: UploadInput): Promise<DocumentRow> {
      const { kind, mime, filename } = validateUpload(input.data, input.filename)
      const id = newId()
      const key = `${p.tenantId}/${input.ownerModule}/${id}`
      await o.store.put(key, input.data)
      try {
        return await inTenant(p, async (tx) => {
          let version = 1
          if (input.supersedes) {
            const prev = await load(tx, input.supersedes)
            if (prev.owner_module !== input.ownerModule || prev.scope !== input.scope) throw badRequest('supersede_mismatch', 'A new version must keep the same scope')
            version = prev.version + 1
          }
          const r = await tx.query<DocumentRow>(
            `insert into platform.documents (id, tenant_id, owner_user_id, owner_module, scope, visibility, trust, filename, mime, kind, size_bytes, sha256, storage_key, version, supersedes)
             values ($1, platform.current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning *`,
            [id, p.userId, input.ownerModule, input.scope, input.visibility, input.trust, filename, mime, kind, input.data.length, sha256(input.data), key, version, input.supersedes ?? null])
          await o.enqueue(tx, PROCESS_JOB, { documentId: id }, { idempotencyKey: `${id}:1` })
          await recordAudit(tx, p, { action: 'document.uploaded', targetType: 'document', targetId: id, metadata: { kind, size: input.data.length, scope: input.scope } })
          counter('documents_uploaded_total', { kind }).inc()
          return r.rows[0]!
        })
      } catch (e) {
        await o.store.delete(key).catch(() => undefined)
        throw e
      }
    },

    list(p: Principal, f: { ownerModule: string; scope: string; includeSuperseded?: boolean }) {
      return inTenant(p, async (tx) =>
        (await tx.query<DocumentRow>(
          `select * from platform.documents where owner_module = $1 and scope = $2 and ($3 or status <> 'superseded') order by created_at desc`,
          [f.ownerModule, f.scope, f.includeSuperseded ?? false])).rows)
    },

    get: (p: Principal, id: string) => inTenant(p, (tx) => load(tx, id)),

    async page(p: Principal, id: string, pageNo: number): Promise<{ document: DocumentRow; text: string }> {
      return inTenant(p, async (tx) => {
        const document = await load(tx, id)
        const r = await tx.query<{ text: string }>('select text from platform.document_pages where document_id = $1 and page_no = $2', [id, pageNo])
        if (!r.rows[0]) throw notFound('Page')
        return { document, text: r.rows[0].text }
      })
    },

    /** Hard delete: row, pages, chunks (FK cascade) and the stored original. Only the owner may delete (RLS). */
    async delete(p: Principal, id: string): Promise<void> {
      const doc = await inTenant(p, async (tx) => {
        const d = await load(tx, id)
        const r = await tx.query('delete from platform.documents where id = $1', [id])
        if (!r.rowCount) throw new AppError('forbidden', 'Only the uploader can delete this document', { status: 403 })
        await recordAudit(tx, p, { action: 'document.deleted', targetType: 'document', targetId: id })
        return d
      })
      await o.store.delete(doc.storage_key)
    },

    async reprocess(p: Principal, id: string): Promise<void> {
      await inTenant(p, async (tx) => {
        const d = await load(tx, id)
        const r = await tx.query(`update platform.documents set status = 'uploaded', stage = null, error = null where id = $1`, [id])
        if (!r.rowCount) throw new AppError('forbidden', 'Only the uploader can reprocess this document', { status: 403 })
        await o.enqueue(tx, PROCESS_JOB, { documentId: id }, { idempotencyKey: `${id}:${Date.now()}` })
        void d
      })
    },

    /** Processing pipeline (job): scan -> parse -> pages -> afterParse (indexing) -> ready. Resumable by stage. */
    async process(documentId: string, afterParse: AfterParse): Promise<'ready' | 'failed' | 'gone'> {
      const r = await o.system.query<DocumentRow>('select * from platform.documents where id = $1', [documentId])
      const doc = r.rows[0]
      if (!doc) return 'gone' // deleted before processing: nothing to do
      const started = performance.now()
      const fail = async (msg: string) => {
        await o.system.query(`update platform.documents set status = 'failed', error = $2 where id = $1`, [documentId, msg.slice(0, 300)])
        await recordSystemAudit(o.system, { tenantId: doc.tenant_id, actorUserId: null, action: 'document.processing_failed', targetType: 'document', targetId: documentId, metadata: { error: msg.slice(0, 120) } })
        counter('documents_processed_total', { kind: doc.kind, outcome: 'failed' }).inc()
        return 'failed' as const
      }
      await o.system.query(`update platform.documents set status = 'processing' where id = $1`, [documentId])
      const data = await o.store.get(doc.storage_key)
      if (sha256(data) !== doc.sha256) return fail('stored file does not match its checksum')
      const scan = await o.scanner.scan(data)
      if (!scan.clean) return fail(`file rejected by virus scan${scan.signature ? ` (${scan.signature})` : ''}`)
      await o.system.query(`update platform.documents set stage = 'scanned' where id = $1`, [documentId])
      let parsed: ParsedDocument
      try {
        parsed = await parseDocument(doc.kind, data, { timeoutMs: o.parseTimeoutMs })
      } catch (e) {
        // the host could not start a parser (resource pressure): transient — let the job retry with backoff
        if ((e as { code?: string }).code === 'parse_unavailable') throw e
        return fail((e as Error).message)
      }
      if (!parsed.pages.some((t) => t.trim())) return fail('no readable text found (scanned images need OCR, which is not available yet)')
      await o.system.tx(async (tx) => {
        await tx.query('delete from platform.document_pages where document_id = $1', [documentId])
        for (const [i, text] of parsed.pages.entries()) {
          await tx.query('insert into platform.document_pages (document_id, tenant_id, page_no, text) values ($1, $2, $3, $4)', [documentId, doc.tenant_id, i + 1, text])
        }
        await tx.query(`update platform.documents set stage = 'parsed', page_count = $2, locator_kind = $3 where id = $1`, [documentId, parsed.pages.length, parsed.locatorKind])
      })
      try {
        await afterParse({ ...doc, page_count: parsed.pages.length, locator_kind: parsed.locatorKind }, parsed)
      } catch (e) {
        logger.warn('document indexing failed', { documentId, error: (e as Error).message })
        throw e // retried by the job queue (transient AI/DB errors)
      }
      await o.system.tx(async (tx) => {
        await tx.query(`update platform.documents set status = 'ready', stage = 'indexed', processed_at = now(), error = null where id = $1`, [documentId])
        if (doc.supersedes) await tx.query(`update platform.documents set status = 'superseded' where id = $1`, [doc.supersedes])
      })
      histogram('document_processing_ms', { kind: doc.kind }).observe(performance.now() - started)
      counter('documents_processed_total', { kind: doc.kind, outcome: 'ready' }).inc()
      return 'ready'
    },
  }
}
export type DocumentService = ReturnType<typeof createDocumentService>
