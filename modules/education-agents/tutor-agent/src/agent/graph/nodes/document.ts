/**
 * Document intelligence subgraph (an upload while setting up): analyse → adopt.
 *   analyse  the document's own text → subject, sections, key terms, grounded in the text (courses/document.ts);
 *            transient provider failures are retried by the node's RetryPolicy, everything else becomes an honest
 *            "could not read" reply (never pretend the file was read)
 *   adopt    a personal course takes the document's sections as its topics; the student gets an evidence-based
 *            summary and chooses the scope (the run then waits at the scope interrupt)
 * open_upload: an upload while a plan is active simply opens a book from the file.
 */
import { StateGraph, START, END, type LangGraphRunnableConfig } from '@langchain/langgraph'
import { mergeProfile } from '../../profile.ts'
import { saveProfile } from '../../store.ts'
import { executeTool } from '../../tools.ts'
import { status } from '../../status.ts'
import { analyseDocument, describe, type DocAnalysis } from '../../../courses/document.ts'
import { ctxOf, tx, type TurnContext } from '../context.ts'
import { ALL_LABEL, SCOPE_ASK } from '../rules.ts'
import { CompanionState, type CompanionStateT, type CompanionUpdate } from '../state.ts'

const analysisOf = (c: TurnContext) => c.results.__document as DocAnalysis | undefined

async function analyse(s: CompanionStateT, config: LangGraphRunnableConfig): Promise<CompanionUpdate> {
  const c = ctxOf(config)
  const documentId = s.turn!.documentId!
  status('Reading your file…', 'librarian')
  // the document belongs to the course it was uploaded into: that course is the one being set up
  if (c.d.documents) {
    const info = await c.d.documents.get(c.p, documentId).catch(() => null)
    const cid = info?.scope?.startsWith('course:') ? info.scope.slice('course:'.length) : null
    if (cid && c.courses.some((x) => x.id === cid)) c.profile = { ...c.profile, courseId: cid }
  }
  try {
    c.results.__document = await analyseDocument(c.d, c.p, documentId, c.lang)
  } catch (e) {
    if ((e as { retryable?: boolean }).retryable) throw e // RetryPolicy: the provider may recover
    c.results.__document = { ok: false, reason: 'failed', documentId, filename: s.turn?.documentTitle || 'your file', message: `I could not analyse "${s.turn?.documentTitle || 'your file'}" (${(e as { code?: string }).code ?? 'error'}). Nothing was taken from it; please try again.` } satisfies DocAnalysis
  }
  return {}
}

async function adopt(s: CompanionStateT, config: LangGraphRunnableConfig): Promise<CompanionUpdate> {
  const c = ctxOf(config)
  // resumed after a restart between the two steps: the (cheap, deterministic-on-text) analysis is repeated
  if (!analysisOf(c)) await analyse(s, config)
  const a = analysisOf(c)!
  const conv = { ...s.conv! }
  if (!a.ok) {
    c.reply = a.message
    conv.sourceDoc = null
    await tx(c, (t) => saveProfile(c.d, c.p, t, c.profile))
    return { conv, flags: { askScope: null } }
  }
  let askScope: string[] | null = null
  if (c.profile.courseId) {
    status('Organising the topics of your document…', 'planner')
    const courseId = c.profile.courseId
    const mine = (await tx(c, (t) => t.query(`select 1 from education_tutor.courses where id = $1 and owner_user_id = platform.current_user_id()`, [courseId]))).rowCount
    if (mine) {
      // a personal course takes its topics from the document (own sections, terms and order); with practice history
      // the course keeps its topics and the document still leads the teaching
      await tx(c, (t) => t.query('select education_tutor.set_personal_course_topics($1, $2, $3::jsonb)', [courseId, a.title, JSON.stringify(a.sections.map((x) => ({ name: x.name, description: x.description || x.keyTerms.join(', '), estMinutes: Math.min(240, 20 + 15 * (x.pageEnd - x.pageStart + 1)) })))])).catch(() => {})
      c.courses = c.courses.map((x) => (x.id === courseId ? { ...x, title: a.title } : x))
    }
    c.profile = mergeProfile(c.profile, { material: 'own' }, c.now, c.courses.map((x) => x.id)).profile
    const { topic: _t, ...rest } = c.profile
    c.profile = rest
    conv.sourceDoc = { id: a.documentId, title: a.title, courseId }
    conv.asked = conv.asked.filter((x) => x !== 'topic')
    askScope = [ALL_LABEL[c.lang], ...a.sections.slice(0, 5).map((x) => x.name)]
  }
  c.reply = `${describe(a)} ${SCOPE_ASK[c.lang]}`
  await tx(c, (t) => saveProfile(c.d, c.p, t, c.profile))
  return { conv, flags: { askScope, uploadedBook: true } }
}

/** compiled as its own subgraph: each step is checkpointed in the parent thread's namespace */
export const documentGraph = new StateGraph(CompanionState)
  .addNode('analyse', analyse, { retryPolicy: { maxAttempts: 3, initialInterval: 1000, retryOn: (e) => (e as { retryable?: boolean }).retryable === true } })
  .addNode('adopt', adopt)
  .addEdge(START, 'analyse').addEdge('analyse', 'adopt').addEdge('adopt', END)
  .compile()

/** an upload while following a plan: open a book from the file */
export async function openUpload(s: CompanionStateT, config: LangGraphRunnableConfig): Promise<CompanionUpdate> {
  const c = ctxOf(config)
  const conv = { ...s.conv! }
  c.profile = mergeProfile(c.profile, { material: 'own' }, c.now, c.courses.map((x) => x.id)).profile
  await tx(c, (t) => saveProfile(c.d, c.p, t, c.profile))
  const title = (s.turn?.documentTitle || c.profile.topic || 'My notes').slice(0, 160)
  const o = await executeTool(c.tools, { d: c.d, p: c.p, conversationId: c.conversationId, now: c.now }, 'studio.open', { courseId: c.profile.courseId, title, documentId: s.turn!.documentId }, { origin: 'orchestrator' })
  if (o.status !== 'ok') return { outcomes: [{ tool: o.tool, status: o.status, ms: o.durationMs, error: o.error?.code }], flags: { failedStep: 'Opening a book from your file' } }
  const res = o.result as { bookId: string; href: string; label: string }
  c.results['studio.open'] = { label: res.label }
  conv.activeBook = { id: res.bookId, title, courseId: c.profile.courseId }
  return { conv, cards: [{ type: 'links', links: [{ label: res.label, href: res.href }], auto: true }], outcomes: [{ tool: o.tool, status: o.status, ms: o.durationMs }], flags: { uploadedBook: true } }
}
