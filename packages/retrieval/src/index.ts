import { fileURLToPath } from 'node:url'
import type { MigrationSet } from '@platform/tenancy-db'
import { PROCESS_JOB, type DocumentService } from '@platform/documents'
import type { Retrieval } from './service.ts'

export * from './chunk.ts'
export * from './service.ts'

export const retrievalMigrations: MigrationSet = {
  owner: 'platform.retrieval',
  schema: 'platform',
  dir: fileURLToPath(new URL('../migrations', import.meta.url)),
}

/** Job handler for the document pipeline: scan -> parse -> pages -> chunk + embed -> ready. */
export function ingestionJob(documents: DocumentService, retrieval: Retrieval) {
  return {
    type: PROCESS_JOB,
    handler: async (ctx: { job: { payload: unknown } }) => {
      const { documentId } = ctx.job.payload as { documentId: string }
      return { outcome: await documents.process(documentId, async (doc, parsed) => { await retrieval.indexDocument(doc, parsed) }) }
    },
  }
}
