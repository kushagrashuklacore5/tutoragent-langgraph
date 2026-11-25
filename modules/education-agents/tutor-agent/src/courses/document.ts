/**
 * Understanding an uploaded document BEFORE anything is planned from it.
 * The model proposes the subject and sections from the document's own text; deterministic code keeps only sections
 * whose names/key terms really occur in that text (no invented syllabus), and refuses to pretend when the file could
 * not be read or has no clear structure.
 */
import { badRequest } from '@platform/core'
import type { ModuleDeps, Principal, TaskDefinition } from '@platform/contracts'

export const DOC_TASK = 'education.tutor.document_outline'
const DOC_SCHEMA = {
  type: 'object', required: ['subject', 'sections'],
  properties: {
    subject: { type: 'string', maxLength: 300 }, title: { type: 'string', maxLength: 300 }, summary: { type: 'string', maxLength: 2000 }, structured: {},
    sections: { type: 'array', maxItems: 40, items: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 300 }, description: { type: 'string', maxLength: 1000 }, pageStart: {}, pageEnd: {}, keyTerms: { type: 'array', maxItems: 20 } } } },
  },
}
export const DOCUMENT_TASKS: TaskDefinition[] = [{
  id: DOC_TASK, owner: 'education.tutor', category: 'tutoring', dataClass: 'student_content', determinism: 'flexible', fallback: 'eligible_only',
  requires: { operation: 'generate', structuredOutput: 'json_mode', minContext: 16000 }, outputSchema: DOC_SCHEMA, evalSuite: 'tutor/document_outline',
  defaults: { maxOutputTokens: 1800, temperature: 0.1, reasoning: 'low' },
}]

export interface DocSection { name: string; description: string; pageStart: number; pageEnd: number; keyTerms: string[] }
export type DocAnalysis =
  | { ok: true; documentId: string; filename: string; pages: number; subject: string; title: string; summary: string; sections: DocSection[]; listedOnly?: string[]; coverage?: Coverage }
  | { ok: false; documentId: string; filename: string; reason: 'failed' | 'processing' | 'too_little_text' | 'unclear'; message: string }

const MAX_PAGES = 60
const MAX_CHARS = 24000
const norm = (x: string) => x.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}\s=+\-*/^().]/gu, ' ').replace(/\s+/g, ' ').trim()
const termWords = (x: string) => norm(x).split(' ').filter((w) => w.length > 3)

/** Keep only what the document really contains: section names/key terms must occur in its text; pages clipped. */
export function groundOutline(o: { subject?: string; title?: string; summary?: string; sections?: { name?: unknown; description?: unknown; pageStart?: unknown; pageEnd?: unknown; keyTerms?: unknown }[] }, pages: string[]): { subject: string; title: string; summary: string; sections: DocSection[] } | null {
  const full = norm(pages.join(' '))
  const occurs = (t: string) => { const n = norm(t); if (n.length >= 3 && full.includes(n)) return true; const w = termWords(t); return w.length > 0 && w.filter((x) => full.includes(x)).length / w.length >= 0.6 }
  const seen = new Set<string>()
  const sections: DocSection[] = []
  for (const s of o.sections ?? []) {
    const name = String(s.name ?? '').replace(/[*_#`>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160)
    if (name.length < 2 || seen.has(name.toLowerCase())) continue
    const terms = (Array.isArray(s.keyTerms) ? s.keyTerms : []).map((x) => String(x).trim()).filter((x) => x && occurs(x)).slice(0, 12)
    // grounded: the section's own words are in the document, or most of its key terms are
    if (!occurs(name) && terms.length < 2) continue
    seen.add(name.toLowerCase())
    const a = Math.max(1, Math.min(pages.length, Math.round(Number(s.pageStart) || 1)))
    const b = Math.max(a, Math.min(pages.length, Math.round(Number(s.pageEnd) || a)))
    sections.push({ name, description: String(s.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 400), pageStart: a, pageEnd: b, keyTerms: terms })
  }
  if (!sections.length) return null
  // the subject must be supported by the document too (its words, or the grounded sections' terms)
  const subject = String(o.subject ?? '').trim().slice(0, 160)
  const subjectOk = subject && (occurs(subject) || sections.length >= 2)
  return { subject: subjectOk ? subject : sections[0]!.name, title: String(o.title ?? subject ?? sections[0]!.name).trim().slice(0, 160) || sections[0]!.name, summary: String(o.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 600), sections: sections.slice(0, 16) }
}

export type PageKind = 'front' | 'syllabus' | 'index' | 'references' | 'exercises' | 'teaching'
export interface Coverage { kinds: PageKind[]; teachingPages: number[]; indexLastPage: number | null; partial: boolean }

const INDEX_LINE = /\S.*\s\d{1,4}\s*$/
/** What a page IS, from its own text: a syllabus or index lists topics, only teaching pages explain them. */
export function pageKind(text: string): PageKind {
  const lines = text.split(/\n+/).map((x) => x.trim()).filter(Boolean)
  const chars = text.replace(/\s+/g, '').length
  if (/\b(index|table of contents|contents)\b/i.test(lines.slice(0, 4).join(' ')) && lines.filter((x) => INDEX_LINE.test(x)).length >= 4) return 'index'
  if (/\b(course objectives|course outcomes|text ?books|syllabus)\b/i.test(text) && (/\bunit\s*[-–—]?\s*[ivx\d]+\b/i.test(text) || /reference books/i.test(text))) return 'syllabus'
  if (/^(references|bibliography|reference books)\b/i.test(lines[0] ?? '')) return 'references'
  // a cover has names and addresses but hardly any sentences
  if (chars < 350 || (text.match(/[a-z]{3,}[.?!](?:\s|$)/g) ?? []).length < 3) return 'front'
  if (/^(exercises?|review questions|practice questions|assignment)\b/i.test(lines[0] ?? '') || lines.filter((x) => /^(q\.?\s*)?\d{1,2}[.)]\s.+\?$/i.test(x)).length >= 4) return 'exercises'
  return 'teaching'
}
/** A unit's opening outline only lists what comes later, so it is not evidence that the topic is taught here. */
const withoutUnitOutline = (text: string) => {
  const lines = text.split('\n')
  const u = lines.findIndex((x) => /^\s*unit\s*[-–—]?\s*[ivx\d]+\s*$/i.test(x))
  if (u < 0) return text
  let e = u + 1
  while (e < lines.length && lines[e]!.trim().length >= 40) e++
  return [...lines.slice(0, u), ...lines.slice(e)].join('\n')
}
/** Which pages really teach, and whether the file's own index promises more pages than the file holds. */
export function coverageOf(pages: string[]): Coverage {
  const kinds = pages.map(pageKind)
  const nums = pages.flatMap((t, i) => (kinds[i] === 'index' ? t.split('\n').filter((x) => INDEX_LINE.test(x)).map((x) => Number(/(\d{1,4})\s*$/.exec(x)![1])) : []))
  const indexLastPage = nums.length ? Math.max(...nums) : null
  return { kinds, teachingPages: kinds.flatMap((k, i) => (k === 'teaching' ? [i + 1] : [])), indexLastPage, partial: indexLastPage !== null && indexLastPage > pages.length }
}
/** Sections with real teaching text in this file; the rest are only listed by its syllabus or index. */
export function splitByTeaching<T extends { name: string; keyTerms: string[] }>(sections: T[], pages: string[], c: Coverage): { taught: T[]; listedOnly: T[] } {
  const body = norm(c.teachingPages.map((n) => withoutUnitOutline(pages[n - 1] ?? '')).join(' '))
  const has = (x: string) => { const n = norm(x); return n.length >= 3 && body.includes(n) }
  const taught: T[] = [], listedOnly: T[] = []
  for (const s of sections) (has(s.name) || s.keyTerms.filter(has).length >= 2 ? taught : listedOnly).push(s)
  return { taught, listedOnly }
}

/** Read the uploaded document and work out what it is about (grounded in its text). */
export async function analyseDocument(d: ModuleDeps, p: Principal, documentId: string, language: string = 'en'): Promise<DocAnalysis> {
  if (!d.documents) throw badRequest('materials_unavailable', 'Document upload is not available on this server')
  const info = await d.documents.get(p, documentId)
  const base = { documentId, filename: info.filename }
  if (info.status === 'failed') return { ok: false, ...base, reason: 'failed', message: `I could not read "${info.filename}"${info.error ? ` (${String(info.error).slice(0, 160)})` : ''}. Nothing was taken from it. Please upload it again, or as a PDF/DOCX with selectable text.` }
  if (info.status !== 'ready') return { ok: false, ...base, reason: 'processing', message: `"${info.filename}" is still being read. I will use it as soon as it is ready.` }
  // read every page (formats without a page count, e.g. plain text, are read until the pages run out)
  const n = Math.min(info.page_count || MAX_PAGES, MAX_PAGES)
  const pages: string[] = []
  for (let i = 1; i <= n; i++) {
    const pg = await d.documents.page(p, documentId, i).catch(() => null)
    if (!pg) { if (!info.page_count) break; pages.push(''); continue }
    pages.push(pg.text ?? '')
  }
  const chars = pages.join('').replace(/\s+/g, '').length
  if (chars < 40) return { ok: false, ...base, reason: 'too_little_text', message: `I opened "${info.filename}" but found almost no readable text (it may be a scan or images). Nothing was taken from it. Please upload a version with selectable text, or tell me the subject.` }
  let budget = MAX_CHARS
  const text = pages.map((t, i) => { const part = t.slice(0, Math.max(0, budget)); budget -= part.length; return part ? `[page ${i + 1}]\n${part}` : '' }).filter(Boolean).join('\n\n')
  const r = await d.ai(p).run(DOC_TASK, { messages: [
    { role: 'system', content: [
      'You read a student\'s uploaded document and describe ONLY what is in it. Return JSON {"subject","title","summary","structured","sections":[{"name","description","pageStart","pageEnd","keyTerms"}]}.',
      'subject: the academic subject/area the text is about, judged from its content (e.g. "Prehistoric human evolution", "Trigonometry"). Never the format of the file (not "notes", "note-taking", "document").',
      'sections: the document\'s own parts in the document\'s order, named with its own headings or wording; keyTerms: 3-8 important terms, names, formulas or equations exactly as written in the text. Do NOT add topics, chapters or background that the text does not contain.',
      'summary: 1-2 sentences of what the document covers, using its terms. structured: false if the text is too fragmentary to identify clear parts.',
      `Write names in the document's language${language !== 'en' ? ' (keep technical terms as written)' : ''}.`,
    ].join('\n') },
    { role: 'user', content: `DOCUMENT "${info.filename}" (${info.page_count} page${info.page_count === 1 ? '' : 's'}):\n${text}` },
  ] }, { promptVersion: 'document_outline@1' })
  const o = r.json as { subject?: string; title?: string; summary?: string; structured?: unknown; sections?: [] }
  const g = groundOutline(o, pages)
  if (!g || o.structured === false && g.sections.length < 2) return { ok: false, ...base, reason: 'unclear', message: `I read "${info.filename}", but I could not find clear topics in it, so I will not guess a syllabus. What subject is it, and which part do you want to learn?` }
  const coverage = coverageOf(pages)
  const { taught, listedOnly } = splitByTeaching(g.sections, pages, coverage)
  // with no teaching pages at all the outline is still useful as a syllabus; describe() says so plainly
  return { ok: true, ...base, pages: info.page_count || pages.length, ...g, sections: taught.length ? taught : g.sections, listedOnly: taught.length ? listedOnly.map((x) => x.name) : [], coverage }
}

/** Plain summary for the student: subject, what it covers, sections with pages (all from the document). */
export function describe(a: Extract<DocAnalysis, { ok: true }>): string {
  const parts = a.sections.slice(0, 8).map((s) => `${s.name}${s.pageStart ? ` (p. ${s.pageStart}${s.pageEnd > s.pageStart ? `–${s.pageEnd}` : ''})` : ''}`).join('; ')
  const c = a.coverage
  const honest = !c ? '' : !c.teachingPages.length
    ? ' This file is a syllabus or index: it lists topics but does not teach them, so lessons would need another source.'
    : `${c.partial ? ` Its index runs to page ${c.indexLastPage}, but this file has only ${a.pages} pages, so it is an excerpt.` : ''} Teaching content is on ${c.teachingPages.length} page${c.teachingPages.length === 1 ? '' : 's'}.${a.listedOnly?.length ? ` Listed but not taught in this file: ${a.listedOnly.slice(0, 6).join(', ')}${a.listedOnly.length > 6 ? ` +${a.listedOnly.length - 6} more` : ''}.` : ''}`
  return `I read "${a.filename}" (${a.pages} page${a.pages === 1 ? '' : 's'}). It is about ${a.subject}.${a.summary ? ` ${a.summary}` : ''} ${c?.teachingPages.length ? 'It teaches' : 'It lists'}: ${parts}.${honest}`
}
