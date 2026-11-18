/** Learning Studio client: types, streamed section generation, lecture navigation and notebook export. */
import { ApiError, TUTOR, toApiError } from './api.ts'
import { SseParser } from './sse.ts'

export const S = `${TUTOR}/studio`
export type Label = 'source' | 'ai' | 'uncertain'
export interface Cite { ref: string; documentId: string; filename: string; page: number }
export interface Figure { query: string; caption: string; alt: string; url?: string; thumb?: string; width?: number; height?: number; pageUrl?: string; license?: string; licenseUrl?: string; credit?: string; status: string }
export interface Activity { kind: 'mcq' | 'numeric' | 'short' | 'explain'; prompt: string; options?: string[]; unit?: string; refBlockId?: string }
export interface Block { id: string; type: 'heading' | 'text' | 'definition' | 'example' | 'formula' | 'list' | 'tip' | 'exam' | 'summary' | 'figure' | 'excerpt' | 'activity'; text: string; term?: string; items?: string[]; label: Label; cites: Cite[]; figure?: Figure; activity?: Activity }
export interface Page { pageNo: number; sectionId: string; blocks: Block[] }
export interface Section { id: string; title: string; pageStart?: number; pageEnd?: number; conceptId?: string | null; firstPage?: number; pages?: number; status: 'pending' | 'generating' | 'ready' }
export type StudyMode = 'read' | 'listen' | 'read_listen' | 'conversation'
export interface Position { pageNo: number; blockId: string | null }
export interface StudioState { mode: StudyMode; lecture: Position; view: Position; interruption: null | { kind: string; pageNo: number; returnTo: Position; asked: number }; sectionId: string | null }
export interface NoteTopic { id: string; title: string; definitions: { term: string; text: string }[]; keyPoints: string[]; formulae: string[]; examples: string[]; memoryTricks: string[]; examPoints: string[]; doubts: { q: string; a: string }[]; practice: string[]; summary: string; myNotes: string }
export interface Notebook { title: string; topics: NoteTopic[]; summary: string }
export interface Annotation { id: string; pageNo: number; blockId: string | null; kind: 'bookmark' | 'highlight' | 'note'; color: string | null; quote: string | null; note: string | null }
export interface BookView {
  book: { id: string; courseId: string; title: string; mode: 'source' | 'generated'; documentId: string | null; language: 'en' | 'hi' | 'hinglish'; outline: Section[]; state: StudioState }
  pages: Page[]; notebook: { version: number; doc: Notebook }; annotations: Annotation[]
}
export interface AskResponse { answer: { intent: string; blocks: Block[]; followUp: string }; state: StudioState; resumeTo: Position | null; notebookVersion: number }
export interface AnswerResult { verdict: 'correct' | 'incorrect' | 'partial'; feedback: string | null; hint: string | null; explanation: string | null; correct: { option?: number; value?: number; unit?: string | null; text?: string } | null; refBlockId: string | null; pageNo: number; revisionCard: boolean; guidance: { label: string; href: string }[] }

export type SectionEvent = { type: 'start'; title: string } | { type: 'sources'; count: number; files: string[] } | { type: 'block'; block: Block } | { type: 'section'; pages: Page[]; notebookVersion?: number }

/** Stream a section into the book; `onEvent` receives blocks as they are validated on the server. */
export async function streamSection(bookId: string, sectionId: string, onEvent: (e: SectionEvent) => void, signal?: AbortSignal): Promise<Page[]> {
  let res: Response
  try {
    res = await fetch(`${S}/books/${bookId}/sections/${sectionId}/generate`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: '{}', credentials: 'same-origin', signal })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw toApiError(0, null)
  }
  if (!res.ok) {
    let body: unknown = null
    try { body = await res.json() } catch { /* not json */ }
    throw toApiError(res.status, body)
  }
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const parser = new SseParser()
  let pages: Page[] | null = null
  const handle = (evs: { event: string; data: string }[]) => {
    for (const ev of evs) {
      const data = JSON.parse(ev.data) as SectionEvent & { code?: string; message?: string }
      if (ev.event === 'error') throw new ApiError(502, data.code ?? 'stream_failed', data.message ?? 'The tutor stopped. Please try again.')
      if (data.type === 'section') pages = data.pages
      onEvent(data)
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    handle(parser.feed(decoder.decode(value, { stream: true })))
  }
  handle(parser.feed(decoder.decode()))
  handle(parser.end())
  if (!pages) throw new ApiError(502, 'stream_incomplete', 'The tutor stopped before finishing this section. Please try again.')
  return pages
}

/** Block order across the book for lecture navigation. */
export function flatBlocks(pages: Page[]): { pageNo: number; block: Block }[] {
  return [...pages].sort((a, b) => a.pageNo - b.pageNo).flatMap((p) => p.blocks.map((block) => ({ pageNo: p.pageNo, block })))
}
export function nextPosition(pages: Page[], p: Position): Position | null {
  const all = flatBlocks(pages)
  const i = p.blockId ? all.findIndex((x) => x.block.id === p.blockId) : all.findIndex((x) => x.pageNo >= p.pageNo) - 1
  const n = all[i + 1]
  return n ? { pageNo: n.pageNo, blockId: n.block.id } : null
}
export function prevPosition(pages: Page[], p: Position): Position | null {
  const all = flatBlocks(pages)
  const i = all.findIndex((x) => x.block.id === p.blockId)
  const n = i > 0 ? all[i - 1] : null
  return n ? { pageNo: n.pageNo, blockId: n.block.id } : null
}

/** What is read aloud for a block (no UI chrome, no answer keys). */
export function blockSpeech(b: Block): string {
  if (b.type === 'figure') return b.figure?.caption ?? ''
  if (b.type === 'activity') return `Quick check. ${b.activity?.prompt ?? ''} ${(b.activity?.options ?? []).map((o, i) => `Option ${String.fromCharCode(65 + i)}: ${o}.`).join(' ')}`
  return [b.term ? `${b.term}.` : '', b.text, ...(b.items ?? [])].filter(Boolean).join(' ')
}

/** Case-insensitive search over the book's pages. */
export function searchBook(pages: Page[], q: string): { pageNo: number; blockId: string; snippet: string }[] {
  const needle = q.trim().toLowerCase()
  if (needle.length < 2) return []
  const out: { pageNo: number; blockId: string; snippet: string }[] = []
  for (const { pageNo, block } of flatBlocks(pages)) {
    const text = [block.term, block.text, ...(block.items ?? [])].filter(Boolean).join(' ')
    const i = text.toLowerCase().indexOf(needle)
    if (i >= 0) out.push({ pageNo, blockId: block.id, snippet: `${i > 30 ? '…' : ''}${text.slice(Math.max(0, i - 30), i + needle.length + 50)}…` })
  }
  return out.slice(0, 30)
}

export function notebookMarkdown(nb: Notebook): string {
  const out = [`# ${nb.title}`, '']
  const list = (h: string, xs: string[]) => { if (xs.length) out.push(`**${h}**`, ...xs.map((x) => `- ${x}`), '') }
  for (const t of nb.topics) {
    out.push(`## ${t.title}`, '')
    if (t.definitions.length) out.push('**Definitions**', ...t.definitions.map((d) => `- **${d.term}**: ${d.text}`), '')
    list('Key points', t.keyPoints); list('Formulae', t.formulae); list('Examples', t.examples)
    list('Memory tricks', t.memoryTricks); list('Exam points', t.examPoints); list('Practice', t.practice)
    if (t.doubts.length) out.push('**My doubts**', ...t.doubts.map((d) => `- Q: ${d.q}\n  A: ${d.a}`), '')
    if (t.myNotes) out.push('**My notes**', t.myNotes, '')
    if (t.summary) out.push(`> ${t.summary}`, '')
  }
  if (nb.summary) out.push('## Chapter summary', nb.summary, '')
  return out.join('\n')
}
