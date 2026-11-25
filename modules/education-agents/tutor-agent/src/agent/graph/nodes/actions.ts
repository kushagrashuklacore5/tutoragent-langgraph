/**
 * Workspace & action nodes.
 *   act          the model's tool requests, executed only through executeTool (validation, permissions, idempotency,
 *                traces) and only when the journey rules allow them; workspaces open by themselves only on an
 *                explicit request; then decides whether the course & roadmap subgraph runs
 *   book_doubt   a doubt sent from a book page is answered inside that book (lecture position kept)
 *   resume_book  "continue": reopen the active book where the lecture stopped (no model call)
 */
import type { LangGraphRunnableConfig } from '@langchain/langgraph'
import { concreteSubject, missingRequired, plannable, readyToPlan, type LearnerProfile } from '../../profile.ts'
import type { Card, ConvState } from '../../store.ts'
import { executeTool } from '../../tools.ts'
import { status } from '../../status.ts'
import { courseScope } from '../../../materials.ts'
import { ctxOf, type TurnContext } from '../context.ts'
import { AUTO_OPEN, EXPLICIT_OPEN, MATERIAL_WORDS, norm, SETUP_TOOLS, STALE_WORKFLOW_MS, UUID, withoutLinks } from '../rules.ts'
import type { CompanionStateT, CompanionUpdate, OutcomeSummary } from '../state.ts'

/** the latest READY document the student uploaded to this course (their own material) */
async function ownDoc(c: TurnContext, courseId: string): Promise<{ id: string; title: string } | null> {
  if (!c.d.documents) return null
  try {
    const docs = (await c.d.documents.list(c.p, courseScope(courseId))).filter((x) => x.owner_user_id === c.p.userId && x.status === 'ready')
    const last = docs.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]
    return last ? { id: last.id, title: last.filename.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ') } : null
  } catch { return null }
}

export async function act(s: CompanionStateT, config: LangGraphRunnableConfig): Promise<CompanionUpdate> {
  const c = ctxOf(config)
  const dec = s.decision!
  const conv: ConvState = structuredClone(s.conv!)
  const cards: Card[] = []
  const outcomes: OutcomeSummary[] = []
  let courseFailed = false
  for (const req of dec.actions) {
    if (req.tool === 'plan.propose') continue // planning is the course & roadmap subgraph
    // a course only for a concrete subject the student named; never while their own material decides the subject
    if (req.tool === 'course.create' && dec.switchTo?.kind !== 'new' && (c.profile.material === 'own' || conv.sourceDoc || MATERIAL_WORDS.test(c.text))) continue
    if (req.tool === 'course.create' && dec.switchTo?.kind !== 'new' && !concreteSubject(String(req.args.subject ?? ''), c.text)) continue
    // JOURNEY RULE: while the goal, material and plan are being settled, nothing is opened or started
    if (dec.inSetup && !SETUP_TOOLS.has(req.tool)) continue
    const args = { ...req.args }
    if (!args.courseId && c.profile.courseId && req.tool !== 'course.create') args.courseId = c.profile.courseId
    if (typeof args.conceptId === 'string' && !UUID.test(args.conceptId)) {
      const want = norm(args.conceptId)
      const hit = c.concepts.find((x) => norm(x.name) === want) ?? c.concepts.find((x) => norm(x.name).includes(want) || want.includes(norm(x.name)))
      if (hit) args.conceptId = hit.id
      else delete args.conceptId
    }
    const o = await executeTool(c.tools, { d: c.d, p: c.p, conversationId: c.conversationId, now: c.now }, req.tool, args, { origin: 'model' })
    outcomes.push({ tool: o.tool, status: o.status, ms: o.durationMs, error: o.error?.code })
    if (req.tool === 'course.create' && o.status !== 'ok') courseFailed = true
    if (o.status !== 'ok') { c.results.__failed = [...((c.results.__failed as string[]) ?? []), o.tool]; continue }
    c.results[o.tool] = withoutLinks(o.result)
    const res = o.result as { href?: string; label?: string; sources?: { filename: string; pages: string; href: string }[]; bookId?: string; courseId?: string; title?: string }
    // the agent ACTS on an explicit request; otherwise the workspace is offered, never opened
    if (res.href && res.label) cards.push({ type: 'links', links: [{ label: res.label, href: res.href }], auto: AUTO_OPEN.has(req.tool) && !cards.some((x) => x.auto) && EXPLICIT_OPEN.test(c.text) })
    if (req.tool === 'course.create' && res.courseId && res.courseId !== c.profile.courseId) {
      // a NEW goal: the previous goal's chapter, material, depth and date do not carry over unless stated now
      const next: LearnerProfile = { ...c.profile, courseId: res.courseId }
      // (confidence and the goal are per subject; the learner's level and teaching preference carry over)
      for (const k of ['topic', 'material', 'depth', 'examDate', 'confidence', 'objective', 'dailyMinutes', 'totalMinutes'] as const) if (!c.stated.has(k)) delete next[k]
      if (next.objective && !c.stated.has('objective')) delete next.objective
      c.profile = next
      conv.asked = conv.asked.filter((x) => !['topic', 'material', 'depth', 'examDate', 'confidence', 'objective', 'dailyMinutes'].includes(x))
      conv.phase = 'onboarding'
      conv.proposal = null
      conv.intake = null
      c.courses = [...c.courses, { id: res.courseId, code: 'MY', title: res.title ?? '' }]
    }
    if (req.tool === 'studio.open' && res.bookId) conv.activeBook = { id: res.bookId, title: String(req.args.title ?? 'Your book'), courseId: String(args.courseId ?? '') }
    if (res.sources?.length) cards.push({ type: 'sources', sources: res.sources.map((x) => ({ filename: x.filename, pages: x.pages, href: x.href })) })
  }
  // own material: the roadmap waits until the document is uploaded and read
  if (c.profile.material === 'own' && c.profile.courseId && conv.sourceDoc?.courseId !== c.profile.courseId) {
    const doc = await ownDoc(c, c.profile.courseId)
    if (doc) conv.sourceDoc = { ...doc, courseId: c.profile.courseId }
  }
  const needUpload = c.profile.material === 'own' && (!c.profile.courseId || conv.sourceDoc?.courseId !== c.profile.courseId)
  return { conv, cards, outcomes, flags: { courseFailed, needUpload, failedStep: courseFailed ? 'Creating your course' : null } }
}

/** should the course & roadmap subgraph run now? (rules, not the model) */
export function shouldPlan(s: CompanionStateT, config: LangGraphRunnableConfig): boolean {
  const c = ctxOf(config)
  const conv = s.conv!, dec = s.decision!, f = s.flags
  if (f.courseFailed || f.needUpload || !c.profile.courseId || !plannable(c.profile) || missingRequired(c.profile).length) return false
  const stale = conv.workflow?.kind === 'planning' && conv.workflow.status === 'running' && c.now.getTime() - Date.parse(conv.workflow.updatedAt) > STALE_WORKFLOW_MS
  if (conv.workflow?.kind === 'planning' && (conv.workflow.status === 'failed' || stale)) return true
  const explicit = dec.actions.some((x) => x.tool === 'plan.propose') || dec.intent === 'request_plan' || dec.intent === 'modify_plan'
  // the submitted intake answered everything this goal needs: prepare it now
  if (c.results.__intake === 'applied') return true
  if (conv.phase === 'onboarding') return readyToPlan(c.profile, conv.asked) || explicit || conv.sourceDoc?.courseId === c.profile.courseId
  return dec.planChanged || explicit
}

export async function bookDoubt(s: CompanionStateT, config: LangGraphRunnableConfig): Promise<CompanionUpdate> {
  const c = ctxOf(config)
  const bc = s.turn!.context!
  status('Looking at this page of your book…', 'teacher')
  try {
    const r = await c.studio.ask(c.p, bc.bookId, { question: c.text, selection: bc.selection ?? null, pageNo: bc.pageNo, blockId: bc.blockId ?? null, source: s.turn!.source === 'voice' ? 'voice' : bc.selection ? 'highlight' : 'question' })
    const NL = String.fromCharCode(10)
    c.reply = [...r.answer.blocks.map((b) => (b.term ? `${b.term}: ${b.text}` : b.text) + (b.items?.length ? NL + b.items.map((x) => `- ${x}`).join(NL) : '')), r.answer.followUp].filter(Boolean).join(NL + NL).slice(0, 2500)
    const conv = { ...s.conv!, activeBook: { id: bc.bookId, title: s.conv!.activeBook?.id === bc.bookId ? s.conv!.activeBook.title : 'Your book' } }
    return { conv, cards: [{ type: 'book_answer', bookAnswer: { bookId: bc.bookId, resumeTo: r.resumeTo ? { pageNo: r.resumeTo.pageNo, blockId: r.resumeTo.blockId ?? null } : null, notebookVersion: r.notebookVersion } }] }
  } catch (e) {
    if ((e as { status?: number }).status === 404) throw e // not this student's book: no answer at all
    return { flags: { failedStep: 'Answering in your book' } }
  }
}

export function resumeBook(s: CompanionStateT): CompanionUpdate {
  const b = s.conv!.activeBook!
  return { cards: [{ type: 'links', links: [{ label: `Continue: ${b.title}`, href: `/studio/${b.id}` }], auto: true }] }
}
