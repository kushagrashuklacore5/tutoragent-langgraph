import { newId, sha256 } from '@platform/core'
import { counter, histogram } from '@platform/observability'
import type { Database, Sql, TenantContext } from '@platform/tenancy-db'
import type { SystemDatabase } from '@platform/tenancy-db/system'
import type { DocumentRow, ParsedDocument } from '@platform/documents'
import type { Gateway, TaskDefinition } from '@platform/ai-gateway'
import { chunkPages, normalize, type ChunkOptions } from './chunk.ts'

export const EMBED_TASK_ID = 'platform.retrieval_embed'

/** Platform embedding task. Dimensions are fixed per deployment (index compatibility); routing picks the model. */
export function embeddingTask(dimensions: number): TaskDefinition {
  return {
    id: EMBED_TASK_ID, owner: 'platform', category: 'embeddings',
    requires: { operation: 'embed', embeddingDimensions: dimensions },
    // student uploads can be indexed, so the strictest data class applies
    dataClass: 'student_content', determinism: 'flexible', fallback: 'none',
  }
}

export interface RankingConfig {
  /** candidates taken from each retriever */
  candidates: number
  topK: number
  /** reciprocal rank fusion constant */
  rrfK: number
  vectorWeight: number
  keywordWeight: number
  /** below this best cosine similarity, and without enough keyword coverage, the query is "not answerable from the material" */
  minVectorSimilarity: number
  /** share of the query's words that must appear in one chunk for a keyword-only "answerable" */
  minKeywordCoverage: number
}
export const DEFAULT_RANKING: RankingConfig = { candidates: 40, topK: 8, rrfK: 60, vectorWeight: 1, keywordWeight: 1, minVectorSimilarity: 0.35, minKeywordCoverage: 0.5 }

export interface SearchHit {
  chunkId: string
  documentId: string
  documentVersion: number
  filename: string
  trust: string
  locatorKind: string
  pageStart: number
  pageEnd: number
  charStart: number
  charEnd: number
  text: string
  score: number
  vectorSimilarity: number | null
  keywordRank: number | null
}
export interface SearchResult {
  hits: SearchHit[]
  answerable: boolean
  embeddingModel: string | null
}

type Principal = TenantContext & { userId: string }

export interface QueryCacheOptions {
  /** max cached query vectors (0 disables) */
  maxEntries: number
  ttlMs: number
}

export function createRetrieval(o: { db: Database; system: SystemDatabase; gateway: () => Gateway; ranking?: Partial<RankingConfig>; chunking?: ChunkOptions; embedBatch?: number; queryCache?: Partial<QueryCacheOptions> }) {
  const ranking = { ...DEFAULT_RANKING, ...o.ranking }
  const batch = o.embedBatch ?? 32
  const qc: QueryCacheOptions = { maxEntries: 2000, ttlMs: 10 * 60_000, ...o.queryCache }
  /**
   * Query-embedding cache. Key = tenant + exact deployment (adapter/model) + purpose + text hash, so it
   * is never shared across tenants and a routing/model change can never return a vector from another
   * model. Only vectors are cached; search results are not (permissions are re-checked every time).
   */
  const cache = new Map<string, { v: number[]; model: string; until: number }>()
  const cacheGet = (k: string) => {
    const e = cache.get(k)
    if (!e) return undefined
    if (e.until < Date.now()) {
      cache.delete(k)
      return undefined
    }
    cache.delete(k) // LRU: move to the end
    cache.set(k, e)
    return e
  }
  const cachePut = (k: string, v: number[], model: string) => {
    if (qc.maxEntries <= 0) return
    cache.set(k, { v, model, until: Date.now() + qc.ttlMs })
    while (cache.size > qc.maxEntries) cache.delete(cache.keys().next().value!)
  }

  async function embedQuery(p: Principal, query: string): Promise<{ vector: number[]; model: string; cached: boolean }> {
    const route = await o.gateway().currentRoute(EMBED_TASK_ID, { tenantId: p.tenantId })
    const key = route ? `${p.tenantId}|${route.deploymentId}|${route.adapter}/${route.modelId}|query|${sha256(query)}` : null
    const hit = key ? cacheGet(key) : undefined
    if (hit) {
      counter('retrieval_query_cache_total', { outcome: 'hit' }).inc()
      return { vector: hit.v, model: hit.model, cached: true }
    }
    counter('retrieval_query_cache_total', { outcome: 'miss' }).inc()
    const emb = await o.gateway().embed(EMBED_TASK_ID, [query], { tenantId: p.tenantId, userId: p.userId }, 'query')
    const vector = normalize(emb.vectors[0]!)
    const model = `${emb.route.adapter}/${emb.route.modelId}`
    // cache only when the call really used the deployment named in the key
    if (key && route && emb.route.deploymentId === route.deploymentId) cachePut(key, vector, model)
    return { vector, model, cached: false }
  }

  return {
    /** Index a parsed document (called by the processing job). Replaces previous chunks of that document. */
    async indexDocument(doc: DocumentRow, parsed: ParsedDocument): Promise<{ chunks: number; embeddingModel: string | null; reused: number; computed: number }> {
      const started = performance.now()
      const chunks = chunkPages(parsed.pages, o.chunking)
      const hashes = chunks.map((c) => sha256(c.text))
      const vectors: (number[] | null)[] = chunks.map(() => null)
      // reuse embeddings of identical text already indexed for this tenant with the CURRENT model
      const route = await o.gateway().currentRoute(EMBED_TASK_ID, { tenantId: doc.tenant_id })
      let model: string | null = route ? `${route.adapter}/${route.modelId}` : null
      let reused = 0
      if (model && chunks.length) {
        const prev = await o.system.query<{ text_sha256: string; embedding: number[] }>(
          `select distinct on (text_sha256) text_sha256, embedding from platform.chunks
           where tenant_id = $1 and embedding_model = $2 and text_sha256 = any($3) and embedding is not null`, [doc.tenant_id, model, [...new Set(hashes)]])
        const byHash = new Map(prev.rows.map((r) => [r.text_sha256, r.embedding]))
        hashes.forEach((h, i) => {
          const v = byHash.get(h)
          if (v) {
            vectors[i] = v
            reused++
          }
        })
      }
      // embed each distinct missing text once
      const missing = [...new Set(hashes.filter((_, i) => !vectors[i]))]
      const fresh = new Map<string, number[]>()
      for (let i = 0; i < missing.length; i += batch) {
        const ids = missing.slice(i, i + batch)
        const texts = ids.map((h) => chunks[hashes.indexOf(h)]!.text)
        const r = await o.gateway().embed(EMBED_TASK_ID, texts, { tenantId: doc.tenant_id }, 'document')
        const used = `${r.route.adapter}/${r.route.modelId}`
        if (model && used !== model) {
          // the route changed while indexing: never mix vector spaces in one document
          throw new Error(`embedding model changed during indexing (${model} -> ${used}); the job will retry`)
        }
        model = used
        r.vectors.forEach((v, k) => fresh.set(ids[k]!, normalize(v)))
      }
      hashes.forEach((h, i) => {
        if (!vectors[i]) vectors[i] = fresh.get(h) ?? null
      })
      counter('retrieval_embeddings_reused_total').inc(reused)
      counter('retrieval_embeddings_computed_total').inc(missing.length)
      await o.system.tx(async (tx) => {
        await tx.query('delete from platform.chunks where document_id = $1', [doc.id])
        for (const [i, c] of chunks.entries()) {
          await tx.query(
            `insert into platform.chunks (id, tenant_id, document_id, document_version, owner_module, owner_user_id, scope, visibility, trust, locator_kind,
               page_start, page_end, char_start, char_end, ordinal, text, embedding, embedding_model, embedding_dims, text_sha256)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
            [newId(), doc.tenant_id, doc.id, doc.version, doc.owner_module, doc.owner_user_id, doc.scope, doc.visibility, doc.trust, parsed.locatorKind,
              c.page, c.charStart, c.charEnd, c.ordinal, c.text, vectors[i] ?? null, model, vectors[i]?.length ?? null, hashes[i]])
        }
      })
      histogram('retrieval_index_ms').observe(performance.now() - started)
      counter('retrieval_chunks_indexed_total').inc(chunks.length)
      return { chunks: chunks.length, embeddingModel: model, reused, computed: missing.length }
    },

    /**
     * Hybrid search within the caller's tenant and the given module scopes. RLS restricts to chunks the
     * user may see (scope-visible, or their own private uploads); only `ready` documents are searched.
     */
    async search(p: Principal, q: { ownerModule: string; scopes: string[]; query: string; topK?: number }): Promise<SearchResult> {
      const started = performance.now()
      const query = q.query.trim().slice(0, 2000)
      if (!query || !q.scopes.length) return { hits: [], answerable: false, embeddingModel: null }
      const { vector: qv, model } = await embedQuery(p, query)
      const res = await o.db.withTenant({ tenantId: p.tenantId, userId: p.userId, roles: p.roles }, async (tx: Sql) => {
        const base = `from platform.chunks c join platform.documents d on d.id = c.document_id and d.status = 'ready'
                      where c.owner_module = $1 and c.scope = any($2)`
        const vec = await tx.query<{ id: string; sim: number }>(
          `select c.id, platform.dot(c.embedding, $3::real[]) as sim ${base} and c.embedding_model = $4 and c.embedding_dims = $5
           order by sim desc limit $6`, [q.ownerModule, q.scopes, qv, model, qv.length, ranking.candidates])
        // OR over the query's lexemes (natural questions rarely contain only words in the text);
        // coverage = share of query lexemes present in the chunk, used for the "answerable" decision
        const kw = await tx.query<{ id: string; rank: number; coverage: number }>(
          `with lx as (
             -- matching uses stemmed + raw words; coverage uses stemmed content words only (stop-words removed)
             select array(select distinct lexeme from unnest(to_tsvector('english', $3) || to_tsvector('simple', $3)) where length(lexeme) > 2) as m,
                    array(select distinct lexeme from unnest(to_tsvector('english', $3)) where length(lexeme) > 2) as l
           ), tq as (
             select to_tsquery('simple', array_to_string(array(select quote_literal(x) from unnest(lx.m) x), ' | ')) as q, lx.l from lx where cardinality(lx.l) > 0
           )
           select c.id, ts_rank_cd(c.tsv, tq.q) as rank,
                  (select count(*) from unnest(tsvector_to_array(c.tsv)) t where t = any(tq.l))::float / cardinality(tq.l) as coverage
           from platform.chunks c join platform.documents d on d.id = c.document_id and d.status = 'ready', tq
           where c.owner_module = $1 and c.scope = any($2) and c.tsv @@ tq.q
           order by rank desc, coverage desc limit $4`, [q.ownerModule, q.scopes, query, ranking.candidates])
        const fused = new Map<string, { score: number; sim: number | null; kw: number | null }>()
        vec.rows.forEach((r, i) => fused.set(r.id, { score: ranking.vectorWeight / (ranking.rrfK + i + 1), sim: Number(r.sim), kw: null }))
        kw.rows.forEach((r, i) => {
          const f = fused.get(r.id) ?? { score: 0, sim: null, kw: null }
          f.score += ranking.keywordWeight / (ranking.rrfK + i + 1)
          f.kw = i + 1
          fused.set(r.id, f)
        })
        const top = [...fused.entries()].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0])).slice(0, q.topK ?? ranking.topK)
        if (!top.length) return { hits: [] as SearchHit[], bestSim: null as number | null, bestCoverage: 0 }
        const rows = await tx.query<{ id: string; document_id: string; document_version: number; filename: string; trust: string; locator_kind: string; page_start: number; page_end: number; char_start: number; char_end: number; text: string }>(
          `select c.id, c.document_id, c.document_version, d.filename, c.trust, c.locator_kind, c.page_start, c.page_end, c.char_start, c.char_end, c.text
           from platform.chunks c join platform.documents d on d.id = c.document_id where c.id = any($1)`, [top.map(([id]) => id)])
        const byId = new Map(rows.rows.map((r) => [r.id, r]))
        const hits = top.flatMap(([id, f]) => {
          const r = byId.get(id)
          if (!r) return []
          return [{ chunkId: id, documentId: r.document_id, documentVersion: r.document_version, filename: r.filename, trust: r.trust, locatorKind: r.locator_kind,
            pageStart: r.page_start, pageEnd: r.page_end, charStart: r.char_start, charEnd: r.char_end, text: r.text,
            score: Math.round(f.score * 1e6) / 1e6, vectorSimilarity: f.sim === null ? null : Math.round(f.sim * 1e4) / 1e4, keywordRank: f.kw }]
        })
        const bestSim = vec.rows.length ? Number(vec.rows[0]!.sim) : null
        return { hits, bestSim, bestCoverage: Math.max(0, ...kw.rows.map((r) => Number(r.coverage))) }
      })
      histogram('retrieval_search_ms').observe(performance.now() - started)
      const answerable = res.hits.length > 0 && ((res.bestSim ?? 0) >= ranking.minVectorSimilarity || res.bestCoverage >= ranking.minKeywordCoverage)
      return { hits: answerable ? res.hits : [], answerable, embeddingModel: model }
    },
  }
}
export type Retrieval = ReturnType<typeof createRetrieval>
