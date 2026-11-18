/**
 * Learning Studio service: books from the student's own material (existing document pipeline + retrieval) or
 * generated from course topics; sections stream into the book block by block; the book's reading state
 * (lecture position, open page, detours) lives on the server; notebooks are versioned; quick checks are formative.
 * Everything runs as the student in their RLS transaction; content is encrypted at rest; nothing is shared.
 */
import { randomUUID } from 'node:crypto'
import { AppError, badRequest, notFound } from '@platform/core'
import type { ModuleDeps, Principal } from '@platform/contracts'
import type { Sql } from '@platform/tenancy-db'
import { courseGraph, requireEnrolled } from '../common.ts'
import { courseScope } from '../materials.ts'
import { loadProfile } from '../agent/store.ts'
import { addDoubt, LineReader, mergeSectionNotes, pageText, paginate, publicBlock, toBlock, type Block, type Notebook, type SourceRef } from './blocks.ts'
import { checkActivity, verifyMcqKey } from './activity.ts'
import { searchImages } from './images.ts'
import { ASK_TASK, buildAskPrompt, buildFeedbackPrompt, buildOcrPrompt, buildOutlinePrompt, buildSectionPrompt, FEEDBACK_TASK, OCR_TASK, OUTLINE_TASK, SECTION_TASK, STUDIO_PROMPT_VERSION } from './prompts.ts'
import { advance, ask as askState, initialStudio, pagePrompt, resume as resumeState, viewPage, type BookIndex, type StudioState, type StudyMode } from './session.ts'

type Lang = 'en' | 'hi' | 'hinglish'
export interface Section { id: string; title: string; pageStart?: number; pageEnd?: number; conceptId?: string | null; firstPage?: number; pages?: number; status: 'pending' | 'generating' | 'ready'; startedAt?: string }
interface BookRow { id: string; course_id: string; title: string; mode: 'source' | 'generated'; document_id: string | null; language: Lang; outline: Section[]; state: StudioState; version: number }
export interface PublicPage { pageNo: number; sectionId: string; blocks: Block[] }

const MAX_SECTION_BLOCKS = 14
const MAX_SOURCE_PAGES = 6
const STALE_GENERATION_MS = 3 * 60_000
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

export function studioService(d: ModuleDeps) {
  const tx = <T>(p: Principal, fn: (t: Sql) => Promise<T>) => d.inTenant(p, fn)
  const crypto = () => {
    if (!d.crypto) throw new AppError('crypto_unavailable', 'Encryption at rest is not configured on this server', { status: 503 })
    return d.crypto
  }
  const enc = (p: Principal, table: string, column: string, id: string, v: unknown) => crypto().encrypt(p, { table, column, recordId: id }, JSON.stringify(v))
  const dec = async <T>(p: Principal, table: string, column: string, id: string, v: string): Promise<T> => JSON.parse(await crypto().decrypt(p, { table, column, recordId: id }, v)) as T

  async function book(t: Sql, id: string, lock = false): Promise<BookRow> {
    const r = (await t.query<BookRow>(`select id, course_id, title, mode, document_id, language, outline, state, version from education_tutor.studio_books where id = $1${lock ? ' for update' : ''}`, [id])).rows[0]
    if (!r) throw notFound('Book')
    return r
  }
  const event = (t: Sql, bookId: string, kind: string, pageNo: number | null, detail: Record<string, unknown> = {}) =>
    t.query(`insert into education_tutor.studio_events (tenant_id, user_id, book_id, kind, page_no, detail) values (platform.current_tenant(), platform.current_user_id(), $1, $2, $3, $4)`, [bookId, kind, pageNo, JSON.stringify(detail)])

  async function pages(p: Principal, t: Sql, bookId: string, only?: number[]): Promise<{ pageNo: number; sectionId: string; blocks: Block[] }[]> {
    const rows = (await t.query<{ page_no: number; section_id: string; blocks_enc: string }>(
      `select page_no, section_id, blocks_enc from education_tutor.studio_pages where book_id = $1 and ($2::int[] is null or page_no = any($2)) order by page_no`, [bookId, only ?? null])).rows
    return Promise.all(rows.map(async (r) => ({ pageNo: r.page_no, sectionId: r.section_id, blocks: await dec<Block[]>(p, 'studio_pages', 'blocks', `${bookId}:${r.page_no}`, r.blocks_enc) })))
  }
  async function index(t: Sql, bookId: string): Promise<BookIndex> {
    const rows = (await t.query<{ page_no: number; block_ids: string[] }>('select page_no, block_ids from education_tutor.studio_pages where book_id = $1', [bookId])).rows
    return new Map(rows.map((r) => [r.page_no, r.block_ids]))
  }
  async function latestNotebook(p: Principal, t: Sql, bookId: string): Promise<{ version: number; doc: Notebook }> {
    const r = (await t.query<{ version: number; doc_enc: string }>('select version, doc_enc from education_tutor.studio_notebooks where book_id = $1 order by version desc limit 1', [bookId])).rows[0]
    if (!r) throw notFound('Notebook')
    return { version: r.version, doc: await dec<Notebook>(p, 'studio_notebooks', 'doc', `${bookId}:${r.version}`, r.doc_enc) }
  }
  async function writeNotebook(p: Principal, t: Sql, bookId: string, version: number, doc: Notebook, author: 'ai' | 'student') {
    await t.query(`insert into education_tutor.studio_notebooks (tenant_id, user_id, book_id, version, author, doc_enc) values (platform.current_tenant(), platform.current_user_id(), $1, $2, $3, $4)`,
      [bookId, version, author, await enc(p, 'studio_notebooks', 'doc', `${bookId}:${version}`, doc)])
  }
  const saveState = (t: Sql, b: BookRow, state: StudioState, outline?: Section[]) =>
    t.query('update education_tutor.studio_books set state = $2, outline = coalesce($3, outline), version = version + 1, updated_at = now() where id = $1', [b.id, JSON.stringify(state), outline ? JSON.stringify(outline) : null])

  async function docPages(p: Principal, documentId: string, from: number, to: number, maxChars: number): Promise<{ page: number; text: string }[]> {
    if (!d.documents) return []
    const out: { page: number; text: string }[] = []
    for (let n = from; n <= to; n++) {
      try { out.push({ page: n, text: (await d.documents.page(p, documentId, n)).text.slice(0, maxChars) }) } catch { break }
    }
    return out
  }

  /** Material for a section or question: the uploaded document's own pages first, then retrieval hits (that document first). */
  async function gatherSources(p: Principal, b: BookRow, query: string, pageRange: [number, number] | null): Promise<SourceRef[]> {
    const out: SourceRef[] = []
    let filename = ''
    if (b.document_id && d.documents) {
      try { filename = (await d.documents.get(p, b.document_id)).filename } catch { /* deleted: fall back to retrieval */ }
      if (filename && pageRange) for (const pg of await docPages(p, b.document_id, pageRange[0], Math.min(pageRange[1], pageRange[0] + MAX_SOURCE_PAGES - 1), 1800)) {
        if (pg.text.trim()) out.push({ ref: `p${pg.page}`, documentId: b.document_id, filename, page: pg.page, text: pg.text })
      }
    }
    if (d.retrieval && query.trim()) {
      try {
        const r = await d.retrieval.search(p, { scopes: [courseScope(b.course_id)], query: query.slice(0, 1000), topK: 6 })
        const hits = [...r.hits].sort((x, y) => Number(y.documentId === b.document_id) - Number(x.documentId === b.document_id))
        for (const h of hits.slice(0, 5)) if (!out.some((s) => s.documentId === h.documentId && s.page === h.pageStart && s.ref.startsWith('p'))) out.push({ ref: h.chunkId, documentId: h.documentId, filename: h.filename, page: h.pageStart, text: h.text.slice(0, 1500) })
      } catch { /* retrieval unavailable: teach from the pages / own knowledge */ }
    }
    return out
  }

  // ── books ──
  async function create(p: Principal, input: { courseId: string; title: string; documentId?: string; language: Lang }) {
    const course = await tx(p, (t) => requireEnrolled(t, p, input.courseId))
    let mode: 'source' | 'generated' = 'generated'
    let pageCount = 0
    if (input.documentId) {
      if (!d.documents) throw new AppError('documents_unavailable', 'Document storage is not configured', { status: 503 })
      const doc = await d.documents.get(p, input.documentId) // permission-checked by the document service
      if (doc.scope !== courseScope(input.courseId)) throw badRequest('document_not_in_course', 'That document belongs to another course')
      if (doc.status !== 'ready') throw new AppError('document_not_ready', 'The document is still being processed', { status: 409 })
      mode = 'source'
      pageCount = doc.page_count ?? 0
    }
    const concepts = await tx(p, async (t) => (await courseGraph(t, input.courseId)).concepts)
    const profile = await tx(p, (t) => loadProfile(d, p, t)).catch(() => null)
    const pagesForOutline = mode === 'source' ? (await docPages(p, input.documentId!, 1, Math.min(pageCount || 40, 40), 240)).map((x) => ({ page: x.page, text: x.text.replace(/\s+/g, ' ') })) : []
    let sections: Section[] = []
    let title = input.title
    try {
      const r = await d.ai(p).run(OUTLINE_TASK, { messages: buildOutlinePrompt({ mode, title: input.title, courseTitle: course.title, concepts: concepts.map((c) => c.name), pages: pagesForOutline, objective: profile?.objective, level: profile?.level }) }, { promptVersion: STUDIO_PROMPT_VERSION })
      const o = r.json as { title?: string; sections: { title: string; pageStart?: number; pageEnd?: number; concept?: string }[] }
      sections = o.sections.slice(0, 12).map((s, i) => {
        const range = mode === 'source' && pageCount ? clampRange(s.pageStart, s.pageEnd, pageCount) : null
        const concept = s.concept ? concepts.find((c) => norm(c.name) === norm(s.concept!)) ?? concepts.find((c) => norm(s.title).includes(norm(c.name))) : concepts.find((c) => norm(s.title).includes(norm(c.name)))
        return { id: `s${i + 1}`, title: s.title.trim().slice(0, 160), ...(range ? { pageStart: range[0], pageEnd: range[1] } : {}), conceptId: concept?.id ?? null, status: 'pending' as const }
      })
      if (o.title && !input.title.trim()) title = o.title
    } catch {
      // deterministic outline: page ranges of the document, or the course topics
      sections = mode === 'source'
        ? Array.from({ length: Math.max(1, Math.ceil(Math.min(pageCount || 1, 36) / 3)) }, (_, i) => ({ id: `s${i + 1}`, title: `Pages ${i * 3 + 1}-${Math.min((i + 1) * 3, pageCount || 1)}`, pageStart: i * 3 + 1, pageEnd: Math.min((i + 1) * 3, pageCount || 1), conceptId: null, status: 'pending' as const }))
        : (concepts.length ? concepts.slice(0, 8).map((c, i) => ({ id: `s${i + 1}`, title: c.name, conceptId: c.id, status: 'pending' as const })) : [{ id: 's1', title: input.title, conceptId: null, status: 'pending' as const }])
    }
    const id = randomUUID()
    return tx(p, async (t) => {
      await t.query(`insert into education_tutor.studio_books (id, tenant_id, user_id, course_id, title, mode, document_id, language, outline, state) values ($1, platform.current_tenant(), platform.current_user_id(), $2, $3, $4, $5, $6, $7, $8)`,
        [id, input.courseId, (title || 'My chapter').slice(0, 200), mode, input.documentId ?? null, input.language, JSON.stringify(sections), JSON.stringify(initialStudio())])
      await writeNotebook(p, t, id, 1, { title: (title || 'My chapter').slice(0, 200), topics: [], summary: '' }, 'ai')
      await event(t, id, 'created', null, { mode, sections: sections.length })
      return { id, mode, sections: sections.length }
    })
  }

  async function view(p: Principal, id: string) {
    return tx(p, async (t) => {
      const b = await book(t, id)
      const ps = await pages(p, t, id)
      const nb = await latestNotebook(p, t, id)
      const ann = (await t.query<{ id: string; page_no: number; block_id: string | null; kind: string; quote_enc: string | null; note_enc: string | null; color: string | null; created_at: Date }>(
        'select id, page_no, block_id, kind, quote_enc, note_enc, color, created_at from education_tutor.studio_annotations where book_id = $1 order by created_at', [id])).rows
      const annotations = await Promise.all(ann.map(async (a) => ({
        id: a.id, pageNo: a.page_no, blockId: a.block_id, kind: a.kind, color: a.color, createdAt: a.created_at.toISOString(),
        quote: a.quote_enc ? await dec<string>(p, 'studio_annotations', 'quote', a.id, a.quote_enc) : null,
        note: a.note_enc ? await dec<string>(p, 'studio_annotations', 'note', a.id, a.note_enc) : null,
      })))
      return {
        book: { id: b.id, courseId: b.course_id, title: b.title, mode: b.mode, documentId: b.document_id, language: b.language, outline: b.outline, state: b.state },
        pages: ps.map((x) => ({ ...x, blocks: x.blocks.map(publicBlock) })), notebook: nb, annotations,
      }
    })
  }

  const list = (p: Principal) => tx(p, async (t) => (await t.query(
    `select b.id, b.title, b.mode, b.course_id as "courseId", b.updated_at as "updatedAt", jsonb_array_length(b.outline) as sections,
            (select count(*)::int from jsonb_array_elements(b.outline) s where s->>'status' = 'ready') as ready
       from education_tutor.studio_books b order by b.updated_at desc limit 50`)).rows)

  // ── teaching: stream a section into the book ──
  async function* generate(p: Principal, id: string, sectionId: string, signal: AbortSignal): AsyncGenerator<Record<string, unknown>> {
    const now = new Date()
    // claim the section (one generation at a time; a stale claim can be taken over)
    const claim = await tx(p, async (t) => {
      const b = await book(t, id, true)
      const s = b.outline.find((x) => x.id === sectionId)
      if (!s) throw notFound('Section')
      if (s.status === 'ready') return { b, s, done: true }
      if (s.status === 'generating' && s.startedAt && now.getTime() - Date.parse(s.startedAt) < STALE_GENERATION_MS) throw new AppError('section_generating', 'This section is already being written', { status: 409 })
      const outline = b.outline.map((x) => (x.id === sectionId ? { ...x, status: 'generating' as const, startedAt: now.toISOString() } : x))
      await saveState(t, b, b.state, outline)
      return { b: { ...b, outline }, s, done: false }
    })
    if (claim.done) {
      const existing = await tx(p, (t) => pages(p, t, id))
      yield { type: 'section', sectionId, pages: existing.filter((x) => x.sectionId === sectionId).map((x) => ({ ...x, blocks: x.blocks.map(publicBlock) })) }
      return
    }
    const { b, s } = claim
    const release = () => tx(p, async (t) => {
      const cur = await book(t, id, true)
      await saveState(t, cur, cur.state, cur.outline.map((x) => (x.id === sectionId && x.status === 'generating' ? { ...x, status: 'pending' as const } : x)))
    })
    try {
      yield { type: 'start', sectionId, title: s.title }
      const sources = await gatherSources(p, b, s.title, s.pageStart ? [s.pageStart, s.pageEnd ?? s.pageStart] : null)
      yield { type: 'sources', count: sources.length, files: [...new Set(sources.map((x) => x.filename))] }
      const profile = await tx(p, (t) => loadProfile(d, p, t)).catch(() => null)
      const covered = b.outline.filter((x) => x.status === 'ready').map((x) => x.title)
      const messages = buildSectionPrompt({ language: b.language, bookTitle: b.title, sectionTitle: s.title, mode: b.mode, sources, level: profile?.level ?? profile?.grade, style: profile?.learningStyle, objective: profile?.objective, covered, allowFigure: true })
      const reader = new LineReader()
      const blocks: Block[] = []
      let figures = 0
      const dropped = { figures: 0, checks: 0, reasons: [] as string[] }
      const accept = async (raw: unknown): Promise<Block | null> => {
        if (blocks.length >= MAX_SECTION_BLOCKS) return null
        const blk = toBlock(raw, `${sectionId}-${blocks.length + 1}`, sources)
        if (!blk) {
          const t = (raw as { type?: unknown; kind?: unknown } | null)?.type
          if (t === 'activity') { dropped.checks++; dropped.reasons.push(`invalid_${String((raw as { kind?: unknown }).kind ?? 'activity').slice(0, 12)}`) }
          return null
        }
        if (blk.type === 'heading' && blocks.some((x) => x.type === 'heading')) blk.type = 'text'
        if (blk.figure) {
          if (figures >= 1) return null
          figures++
          const hit = (await searchImages(blk.figure.query, signal))[0]
          if (!hit) { dropped.figures++; return null } // no relevant, openly licensed image: no figure
          // the caption names what the image actually is (its source title); the model's sentence stays as the "why it helps" note
          blk.figure = { ...blk.figure, caption: hit.title || blk.figure.query, alt: hit.title || blk.figure.alt, url: hit.url, thumb: hit.thumb, width: hit.width, height: hit.height, pageUrl: hit.pageUrl, license: hit.license, licenseUrl: hit.licenseUrl, credit: hit.credit, status: 'found' }
        }
        if (blk.activity?.kind === 'numeric') {
          // fail closed: a numeric key is kept only if the maths service confirms it
          const k = blk.activity.key!
          const r = d.math ? await d.math.evaluate(k.expr!).catch(() => null) : null
          if (!r?.ok || r.value === undefined || Math.abs(Number(r.value) - k.value!) > Math.max(1e-6, Math.abs(k.value!) * 1e-3)) { dropped.checks++; dropped.reasons.push(r?.ok ? 'numeric_key_mismatch' : 'numeric_expr_invalid'); return null }
        }
        if (blk.activity?.kind === 'mcq') {
          // model-written MCQ keys are verified (numeric options against the maths service) or the check is dropped
          const expr = blk.activity.key?.expr
          const r = expr && d.math ? await d.math.evaluate(expr).catch(() => null) : null
          if (verifyMcqKey(blk.activity, r?.ok && r.value !== undefined ? Number(r.value) : null) === null) { dropped.checks++; dropped.reasons.push(!expr ? 'mcq_no_expr' : r?.ok ? 'mcq_key_mismatch' : 'mcq_expr_invalid'); return null }
        }
        if (blk.activity) blk.activity.refBlockId = [...blocks].reverse().find((x) => ['text', 'definition', 'formula', 'example'].includes(x.type))?.id
        if (!blocks.length && blk.type !== 'heading') blocks.push({ id: `${sectionId}-0`, type: 'heading', text: s.title, label: 'ai', cites: [] })
        blocks.push(blk)
        return blk
      }
      for await (const ev of d.ai(p).stream(SECTION_TASK, { messages }, { promptVersion: STUDIO_PROMPT_VERSION })) {
        if (signal.aborted) break
        if (ev.t === 'text') for (const raw of reader.push(ev.delta)) {
          const before = blocks.length
          const blk = await accept(raw)
          if (blk) for (const x of blocks.slice(before)) yield { type: 'block', sectionId, block: publicBlock(x) }
        }
      }
      for (const raw of reader.end()) {
        const before = blocks.length
        if (await accept(raw)) for (const x of blocks.slice(before)) yield { type: 'block', sectionId, block: publicBlock(x) }
      }
      if (signal.aborted) { await release(); return }
      if (blocks.filter((x) => x.type !== 'heading').length < 2) throw new AppError('section_empty', 'The tutor could not write this section. Please try again.', { status: 502 })

      const saved = await tx(p, async (t) => {
        const cur = await book(t, id, true)
        const first = ((await t.query<{ n: number }>('select coalesce(max(page_no), 0)::int as n from education_tutor.studio_pages where book_id = $1', [id])).rows[0]!.n) + 1
        const laid = paginate(blocks, first)
        for (const pg of laid) {
          await t.query(`insert into education_tutor.studio_pages (tenant_id, user_id, book_id, page_no, section_id, block_ids, blocks_enc) values (platform.current_tenant(), platform.current_user_id(), $1, $2, $3, $4, $5)`,
            [id, pg.pageNo, sectionId, pg.blocks.map((x) => x.id), await enc(p, 'studio_pages', 'blocks', `${id}:${pg.pageNo}`, pg.blocks)])
        }
        const outline = cur.outline.map((x) => (x.id === sectionId ? { ...x, status: 'ready' as const, firstPage: first, pages: laid.length, startedAt: undefined } : x))
        // first generated section: the lecture starts on its first page
        const state = cur.state.lecture.blockId === null && first === 1 ? { ...cur.state, sectionId } : cur.state
        await saveState(t, cur, state, outline)
        const nb = await latestNotebook(p, t, id)
        await writeNotebook(p, t, id, nb.version + 1, mergeSectionNotes(nb.doc, sectionId, s.title, blocks), 'ai')
        await event(t, id, 'section_generated', first, { sectionId, blocks: blocks.length, sourceBlocks: blocks.filter((x) => x.label === 'source').length, figures: blocks.filter((x) => x.type === 'figure').length, checks: blocks.filter((x) => x.type === 'activity').length, dropped, pages: laid.length })
        return { laid, notebookVersion: nb.version + 1 }
      })
      yield { type: 'section', sectionId, pages: saved.laid.map((pg) => ({ pageNo: pg.pageNo, sectionId, blocks: pg.blocks.map(publicBlock) })), notebookVersion: saved.notebookVersion }
    } catch (e) {
      await release().catch(() => {})
      throw e
    }
  }

  // ── reading state & interruptions ──
  async function onEvent(p: Principal, id: string, e: { kind: 'view' | 'advance' | 'mode'; pageNo?: number; blockId?: string; mode?: StudyMode }) {
    const now = new Date()
    return tx(p, async (t) => {
      const b = await book(t, id, true)
      let state = b.state
      let prompt: string | null = null
      if (e.kind === 'mode' && e.mode) state = { ...state, mode: e.mode }
      else if (e.kind === 'view' && e.pageNo) {
        const r = viewPage(state, e.pageNo, now)
        state = r.state
        if (r.detour) {
          const [pg] = await pages(p, t, id, [e.pageNo])
          if (pg) {
            const section = b.outline.find((x) => x.id === pg.sectionId)
            const heading = pg.blocks.find((x) => x.type === 'heading')?.text ?? section?.title ?? ''
            const firstText = pg.blocks.find((x) => x.type !== 'heading' && x.type !== 'figure')
            const first = (firstText?.term ? `${firstText.term} — ` : '') + (firstText?.text.split(/(?<=[.!?।])\s/)[0] ?? '')
            prompt = pagePrompt(b.language, e.pageNo, heading, first, state.interruption!.returnTo.pageNo)
          }
          await event(t, id, 'page_detour', e.pageNo, { from: b.state.lecture.pageNo })
        }
      } else if (e.kind === 'advance' && e.pageNo && e.blockId) {
        const idx = await index(t, id)
        if (!(idx.get(e.pageNo) ?? []).includes(e.blockId)) throw badRequest('invalid_position', 'Unknown block')
        state = advance(state, { pageNo: e.pageNo, blockId: e.blockId }, idx)
        const sec = (await t.query<{ section_id: string }>('select section_id from education_tutor.studio_pages where book_id = $1 and page_no = $2', [id, state.lecture.pageNo])).rows[0]
        if (sec) state = { ...state, sectionId: sec.section_id }
      } else throw badRequest('invalid_event', 'kind must be view, advance or mode')
      await saveState(t, b, state)
      return { state, prompt }
    })
  }

  async function ask(p: Principal, id: string, q: { question: string; selection: string | null; pageNo: number; blockId: string | null; source: 'question' | 'highlight' | 'voice' }) {
    const now = new Date()
    const b = await tx(p, (t) => book(t, id))
    const pg = (await tx(p, (t) => pages(p, t, id, [q.pageNo])))[0]
    const lecturePage = b.state.interruption?.returnTo.pageNo ?? b.state.lecture.pageNo
    const lectureSection = b.outline.find((x) => x.id === (b.state.sectionId ?? '')) ?? b.outline.find((x) => x.firstPage !== undefined && x.firstPage <= lecturePage)
    const block = pg?.blocks.find((x) => x.id === q.blockId)
    const citedPages = (block?.cites ?? []).map((c) => c.page)
    const sources = await gatherSources(p, b, `${q.question} ${q.selection ?? ''}`, b.document_id && citedPages.length ? [Math.min(...citedPages), Math.max(...citedPages)] : null)
    let out: { intent: string; blocks: Block[]; followUp: string }
    try {
      const r = await d.ai(p).run(ASK_TASK, { messages: buildAskPrompt({ language: b.language, question: q.question, selection: q.selection, pageText: pg ? pageText(pg.blocks) : '', lectureTopic: lectureSection?.title ?? '', sources }) }, { promptVersion: STUDIO_PROMPT_VERSION })
      const j = r.json as { intent: string; blocks: unknown[]; followUp?: string }
      const blocks = j.blocks.map((x, i) => toBlock(x, `ask-${Date.now()}-${i}`, sources)).filter((x): x is Block => !!x && x.type !== 'activity' && x.type !== 'figure')
      if (!blocks.length) throw new Error('empty answer')
      out = { intent: j.intent, blocks, followUp: (j.followUp ?? '').slice(0, 300) }
    } catch (e) {
      if ((e as { code?: string }).code === 'not_found') throw e
      throw new AppError('tutor_unavailable', 'The tutor could not answer right now. Your place in the lesson is kept.', { status: 503 })
    }
    return tx(p, async (t) => {
      const cur = await book(t, id, true)
      const state = askState(cur.state, q.source, q.pageNo, now)
      await saveState(t, cur, state)
      const nb = await latestNotebook(p, t, id)
      const question = q.selection ? `${q.question} — “${q.selection.slice(0, 160)}”` : q.question
      await writeNotebook(p, t, id, nb.version + 1, addDoubt(nb.doc, pg?.sectionId ?? null, cur.outline.find((x) => x.id === pg?.sectionId)?.title ?? '', question, out.blocks.map((x) => (x.term ? `${x.term}: ${x.text}` : x.text)).join(' ')), 'ai')
      await event(t, id, 'ask', q.pageNo, { intent: out.intent, source: q.source, sourceBlocks: out.blocks.filter((x) => x.label === 'source').length })
      return { answer: out, state, resumeTo: state.interruption?.returnTo ?? null, notebookVersion: nb.version + 1 }
    })
  }

  const resume = (p: Principal, id: string) => tx(p, async (t) => {
    const b = await book(t, id, true)
    const r = resumeState(b.state)
    await saveState(t, b, r.state)
    await event(t, id, 'resume', r.position.pageNo, { blockId: r.position.blockId })
    return r
  })

  // ── quick checks (formative) ──
  async function answer(p: Principal, id: string, blockId: string, response: unknown) {
    const found = await tx(p, async (t) => {
      const b = await book(t, id)
      const row = (await t.query<{ page_no: number }>('select page_no from education_tutor.studio_pages where book_id = $1 and $2 = any(block_ids)', [id, blockId])).rows[0]
      if (!row) throw notFound('Activity')
      const [pg] = await pages(p, t, id, [row.page_no])
      const blk = pg!.blocks.find((x) => x.id === blockId)
      if (!blk?.activity) throw notFound('Activity')
      const wrong = Number((await t.query<{ n: string }>(`select count(*) as n from education_tutor.studio_events where book_id = $1 and kind = 'activity' and detail->>'blockId' = $2 and detail->>'verdict' <> 'correct'`, [id, blockId])).rows[0]!.n)
      return { b, blk, pageNo: row.page_no, sectionId: pg!.sectionId, wrong }
    })
    const a = found.blk.activity!
    let { verdict, reveal } = checkActivity(a, response, found.wrong) as { verdict: 'correct' | 'incorrect' | 'needs_feedback' | 'partial'; reveal: string }
    let feedback: string | null = null
    if (verdict === 'needs_feedback') {
      try {
        const r = await d.ai(p).run(FEEDBACK_TASK, { messages: buildFeedbackPrompt({ language: found.b.language, prompt: a.prompt, modelAnswer: a.key?.modelAnswer ?? '', answer: String(response).slice(0, 2000) }) }, { promptVersion: STUDIO_PROMPT_VERSION })
        const j = r.json as { verdict: 'correct' | 'partial' | 'incorrect'; feedback: string }
        verdict = j.verdict; feedback = j.feedback; reveal = j.verdict === 'correct' ? 'explanation' : found.wrong >= 1 ? 'explanation' : 'hint'
      } catch {
        verdict = 'partial'; feedback = null; reveal = 'explanation'
      }
    }
    const section = found.b.outline.find((x) => x.id === found.sectionId)
    const base = `/app/education/tutor/courses/${found.b.course_id}`
    const struggling = verdict !== 'correct' && found.wrong >= 1
    return tx(p, async (t) => {
      // a missed check becomes a spaced-revision card once (FSRS), never learner evidence
      let card = false
      if (verdict !== 'correct') {
        const back = [a.explanation, a.kind === 'mcq' ? `Answer: ${a.options![a.key!.correct![0]!]}` : a.kind === 'numeric' ? `Answer: ${a.key!.value}${a.unit ? ` ${a.unit}` : ''}` : a.kind === 'short' ? `Answer: ${a.key!.accept![0]}` : a.key?.modelAnswer].filter(Boolean).join('\n')
        const r = await t.query(`insert into education_tutor.cards (tenant_id, user_id, course_id, concept_id, front, back, due_at, source_ref) values (platform.current_tenant(), platform.current_user_id(), $1, $2, $3, $4, now() + interval '1 day', $5)
          on conflict (user_id, source_ref) where source_ref is not null do nothing`, [found.b.course_id, section?.conceptId ?? null, `${a.prompt}${a.options ? `\n${a.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join('\n')}` : ''}`.slice(0, 2000), (back || a.prompt).slice(0, 4000), `studio:${id}:${blockId}`])
        card = r.rowCount === 1
      }
      await event(t, id, 'activity', found.pageNo, { blockId, verdict, attempt: found.wrong + 1, card })
      const showKey = verdict === 'correct' || found.wrong >= 1
      return {
        verdict, feedback,
        hint: reveal === 'hint' ? a.hint ?? null : null,
        explanation: reveal === 'explanation' ? a.explanation ?? null : null,
        correct: showKey ? (a.kind === 'mcq' ? { option: a.key!.correct![0] } : a.kind === 'numeric' ? { value: a.key!.value, unit: a.unit ?? null } : a.kind === 'short' ? { text: a.key!.accept![0] } : null) : null,
        refBlockId: a.refBlockId ?? null, pageNo: found.pageNo, revisionCard: card,
        guidance: struggling && section?.conceptId ? [{ label: 'Guided session on this topic', href: `${base}/tutor?conceptId=${section.conceptId}` }, { label: 'Practise this topic', href: `${base}/practice?conceptId=${section.conceptId}` }] : [],
      }
    })
  }

  // ── notebook & annotations ──
  const saveNotebook = (p: Principal, id: string, doc: Notebook, baseVersion: number) => tx(p, async (t) => {
    await book(t, id, true)
    const nb = await latestNotebook(p, t, id)
    if (nb.version !== baseVersion) throw new AppError('notebook_changed', 'Your notebook changed (new notes were added). Reload and apply your edit again.', { status: 409 })
    await writeNotebook(p, t, id, nb.version + 1, doc, 'student')
    await event(t, id, 'notebook_edit', null, { version: nb.version + 1 })
    return { version: nb.version + 1 }
  })
  const notebookVersions = (p: Principal, id: string) => tx(p, async (t) => {
    await book(t, id)
    return (await t.query('select version, author, created_at as "createdAt" from education_tutor.studio_notebooks where book_id = $1 order by version desc limit 50', [id])).rows
  })
  const annotate = (p: Principal, id: string, a: { pageNo: number; blockId: string | null; kind: 'bookmark' | 'highlight' | 'note'; quote: string | null; note: string | null; color: string | null }) => tx(p, async (t) => {
    await book(t, id)
    if (a.blockId && !((await index(t, id)).get(a.pageNo) ?? []).includes(a.blockId)) throw badRequest('invalid_position', 'Unknown block')
    const aid = randomUUID()
    await t.query(`insert into education_tutor.studio_annotations (id, tenant_id, user_id, book_id, page_no, block_id, kind, quote_enc, note_enc, color) values ($1, platform.current_tenant(), platform.current_user_id(), $2, $3, $4, $5, $6, $7, $8)`,
      [aid, id, a.pageNo, a.blockId, a.kind, a.quote ? await enc(p, 'studio_annotations', 'quote', aid, a.quote) : null, a.note ? await enc(p, 'studio_annotations', 'note', aid, a.note) : null, a.color])
    await event(t, id, a.kind, a.pageNo, {})
    return { id: aid }
  })
  const unannotate = (p: Principal, id: string, annotationId: string) => tx(p, async (t) => {
    const r = await t.query('delete from education_tutor.studio_annotations where id = $1 and book_id = $2', [annotationId, id])
    if (!r.rowCount) throw notFound('Annotation')
  })
  const remove = (p: Principal, id: string) => tx(p, async (t) => {
    const r = await t.query('delete from education_tutor.studio_books where id = $1', [id])
    if (!r.rowCount) throw notFound('Book')
  })

  // ── photographed / scanned notes → text document in the existing pipeline ──
  async function ocr(p: Principal, courseId: string, image: Buffer, mediaType: string, filename: string) {
    await tx(p, (t) => requireEnrolled(t, p, courseId))
    if (!d.documents) throw new AppError('documents_unavailable', 'Document storage is not configured', { status: 503 })
    let j: { title?: string; text: string; legible?: boolean }
    try {
      const r = await d.ai(p).run(OCR_TASK, { messages: buildOcrPrompt(mediaType, image.toString('base64')) as never }, { promptVersion: STUDIO_PROMPT_VERSION })
      j = r.json as typeof j
    } catch (e) {
      const x = e as { code?: string; kind?: string }
      if (x.kind === 'no_eligible_route' || x.code === 'no_eligible_route' || x.kind === 'unsupported_capability') throw new AppError('ocr_unavailable', 'Reading photographed notes needs a vision-capable model; ask your administrator to enable one.', { status: 503 })
      throw new AppError('ocr_failed', 'The photo could not be read right now. Please try again.', { status: 503 })
    }
    if (j.legible === false || j.text.trim().length < 20) throw new AppError('ocr_illegible', 'The photo is not clear enough to read. Try a sharper, well-lit photo.', { status: 422 })
    const doc = await d.documents.upload(p, { scope: courseScope(courseId), visibility: 'private', trust: 'student_upload', filename: `${filename.replace(/\.[a-z0-9]+$/i, '')} (transcribed).md`, data: Buffer.from(j.text, 'utf8') })
    return { documentId: doc.id, status: doc.status, title: j.title ?? null, characters: j.text.length }
  }

  return { create, view, list, generate, onEvent, ask, resume, answer, saveNotebook, notebookVersions, annotate, unannotate, remove, ocr }
}

function clampRange(a: unknown, b: unknown, max: number): [number, number] | null {
  const s = Number(a), e = Number(b ?? a)
  if (!Number.isInteger(s) || s < 1 || s > max) return null
  return [s, Number.isInteger(e) && e >= s ? Math.min(e, max, s + 11) : s]
}
