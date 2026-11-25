/**
 * respond: the one place a turn ends. Picks the next question (rules), composes the reply from tool results (second
 * model call, only when something happened), applies the reply rules, and persists conversation state, profile and
 * the reply ONCE (dedupe key per turn: a re-run after a crash never posts the reply twice).
 * approval_gate / scope_gate: the thread waits here (LangGraph interrupt) for the student's next turn.
 */
import { interrupt, type LangGraphRunnableConfig } from '@langchain/langgraph'
import { AppError } from '@platform/core'
import { randomUUID } from 'node:crypto'
import { buildIntake, intakeRecord } from '../../intake.ts'
import { asksForExplanation, missingRequired, nextSlot, type Slot } from '../../profile.ts'
import { TEMPLATES, tpl } from '../../prompts.ts'
import { buildComposePrompt, COMPOSE_TASK, SLOT_QUESTIONS } from '../../prompts.ts'
import { addMessage, getConversation, saveProfile, saveState, type Card } from '../../store.ts'
import { status } from '../../status.ts'
import { ctxOf, tx } from '../context.ts'
import { choicesFor, fallbackText, oneQuestion, planClaimsOk, SUBJECT_ASK, UPLOAD_ACK, UPLOAD_ASK } from '../rules.ts'
import type { CompanionStateT, CompanionUpdate, TurnInput } from '../state.ts'
import { modelJson } from './understand.ts'

export async function respond(s: CompanionStateT, config: LangGraphRunnableConfig): Promise<CompanionUpdate> {
  const c = ctxOf(config)
  const conv = structuredClone(s.conv!)
  const f = s.flags
  const docTurn = f.askScope !== undefined // the document subgraph decided this reply
  const nodeReply = c.reply // a reply decided by a node (book answer, document summary, rejection)
  let cards: Card[] = [...s.cards]

  // the next question (rules): required facts first, never during a document summary or after a rejection
  let question: Slot | null = null
  let repeatSubject = false
  let intakeCard: Card | null = null
  let needUpload = !!f.needUpload
  if (!docTurn && !f.rejected && (conv.phase === 'onboarding' || (!f.proposed && !f.applied && missingRequired(c.profile).length))) {
    question = nextSlot(c.profile, conv.asked)
    // never the same question twice in a row after a real answer: an optional question is dropped, and an unresolved course
    // becomes "which subject or skill?", whose free-text answer always resolves (no clarification loop)
    const answering = c.results.__answering as string | null
    if (question && question === answering && c.text.trim()) {
      if (question === 'courseId') { question = null; repeatSubject = true }
      // an unreadable answer to "what is your goal?" takes the general goal (changeable later) instead of asking again
      else if (question === 'objective') { c.profile = { ...c.profile, objective: 'general' }; question = nextSlot(c.profile, conv.asked) }
      else if (!missingRequired(c.profile).includes(question)) { c.profile = { ...c.profile, skipped: [...new Set([...(c.profile.skipped ?? []), question])] }; question = nextSlot(c.profile, conv.asked) }
    }
    // own material and no course yet: the uploaded document will decide the course, so ask for the file
    if (question === 'courseId' && c.profile.material === 'own') { question = null; needUpload = true }
    // the upload comes before optional questions (the plan cannot be made without it)
    if (question && needUpload && !missingRequired(c.profile).includes(question)) question = null
    // ONE consolidated intake instead of one question per reply: every question that still matters, answered together
    const submitted = conv.intake?.courseId === c.profile.courseId && conv.intake?.status === 'submitted'
    if (question && question !== 'courseId' && c.profile.courseId && conv.phase === 'onboarding' && !needUpload && !f.proposed && !f.applied && !submitted) {
      const same = conv.intake?.courseId === c.profile.courseId && conv.intake?.status === 'pending' ? conv.intake.id : null
      const ik = buildIntake(c.profile, { id: same ?? randomUUID(), courseId: c.profile.courseId, explain: asksForExplanation(c.text) })
      if (ik) { intakeCard = { type: 'intake', intake: ik }; conv.intake = intakeRecord(ik); question = null }
    }
    if (question && !conv.asked.includes(question)) conv.asked = [...conv.asked, question]
  }
  conv.lastAsked = question
  if (question) { const ch = choicesFor(question, c.lang, c.courses); if (ch.length) cards.push({ type: 'choices', choices: ch }) }
  const askUpload = !docTurn && !question && needUpload && !f.proposed
  if (askUpload) cards.push({ type: 'upload' })

  // COMPOSE when something happened that the student should hear about
  const failed = (c.results.__failed as string[] | undefined) ?? []
  const okResults = Object.keys(c.results).filter((k) => !k.startsWith('__') && k !== 'planProposal')
  let reply = nodeReply
  // started from the intake: a short factual hand-over, Vidya takes it from here (no second model call)
  if (!reply && f.applied && f.autoStart && !f.failedStep && conv.proposal) reply = tpl(TEMPLATES.started[c.lang], { course: conv.proposal.courseTitle, first: conv.activeBook?.title && conv.activeBook.title !== conv.proposal.courseTitle ? conv.activeBook.title : conv.proposal.roadmap.milestones[0]?.conceptNames[0] ?? conv.proposal.courseTitle })
  if (!reply && intakeCard) {
    const created = c.results['course.create'] as { title?: string } | undefined
    const said = (c.draft ?? '').split(/(?<=[.!?।])\s+/).filter((x) => !x.trim().endsWith('?')).join(' ').trim()
    reply = `${said || (created?.title ? `I've set up "${created.title}" for you.` : '')} ${TEMPLATES.intakeAsk[c.lang]}`.trim()
  }
  if (c.results.__intake === 'invalid') reply = 'Please answer the questions marked as required, then press Start learning.'
  if (!reply && (f.proposed || f.applied || okResults.length || failed.length)) {
    const results: Record<string, unknown> = {}
    for (const k of okResults) results[k] = c.results[k]
    if (f.proposed && conv.proposal) {
      results.planProposal = c.results.planProposal
      results.sourceMaterial = conv.sourceDoc?.courseId === conv.proposal.courseId ? `the student's own uploaded file "${conv.sourceDoc.title}" (its examples and exercises become practice)` : c.profile.material === 'curriculum' ? 'the NCERT / course syllabus' : 'notes prepared by the tutor'
      if (s.decision?.planChanged && c.results.__startPhase !== 'onboarding') results.planWasJustUpdated = { because: 'the student changed their goal, deadline or daily time', newInputs: conv.proposal.inputs, say: 'Tell the student the plan has been re-made with the new values and ask them to approve it.' }
    }
    if (f.applied) results.appliedPlan = { ...f.applied, nextSession: conv.nextSession }
    if (question) results.thenAsk = SLOT_QUESTIONS[question].en
    if (askUpload) results.thenAsk = UPLOAD_ASK.en
    if (failed.length) results.couldNotDo = failed.map((t) => ({ what: c.tools.get(t)?.description ?? 'that request', why: 'not possible right now' }))
    status('Writing my reply…')
    const out = await modelJson(c, COMPOSE_TASK, buildComposePrompt({ language: c.lang, message: c.text, results }))
    reply = typeof out?.reply === 'string' && out.reply.trim() ? out.reply.trim() : null
    // live: the model described a plan with durations it made up
    if (reply && f.proposed && conv.proposal && !planClaimsOk(reply, conv.proposal.roadmap)) reply = null
  }
  if (!reply && f.failedStep) reply = fallbackText(c.lang, { failedStep: f.failedStep })
  if (!reply && !f.proposed && !f.applied) {
    // one question per reply while gathering the goal; the model's draft keeps only its first question
    reply = c.draft ? (question ? oneQuestion(c.draft) : c.draft) : fallbackText(c.lang, { question })
    if (c.draft && question && !c.draft.includes('?')) reply = `${c.draft} ${SLOT_QUESTIONS[question][c.lang]}`
  }
  if (!reply) reply = fallbackText(c.lang, { proposal: f.proposed ? conv.proposal : null, applied: f.applied ?? null })
  if (question && !reply.includes('?')) reply = `${reply} ${SLOT_QUESTIONS[question][c.lang]}`
  // a REQUIRED fact is missing: the reply ends with exactly that question
  else if (question && missingRequired(c.profile).includes(question) && !reply.includes(SLOT_QUESTIONS[question][c.lang])) {
    reply = `${reply.replace(/[^.!?]*\?\s*$/, '').trim()} ${SLOT_QUESTIONS[question][c.lang]}`.trim()
  }
  // the upload request is ours, word for word (live: the model claimed it had opened a workspace)
  if (askUpload) reply = `${UPLOAD_ACK[c.lang]} ${UPLOAD_ASK[c.lang]}`
  if (docTurn) {
    cards = cards.filter((x) => x.type !== 'choices' && x.type !== 'upload')
    if (f.askScope?.length) { cards.push({ type: 'choices', choices: f.askScope }); conv.lastAsked = 'topic' } else conv.lastAsked = null
  }
  // "another subject": the next answer is the subject itself (its expectation is recorded, so it is never read as a course choice)
  if (s.decision?.askSubject || repeatSubject) { reply = SUBJECT_ASK[c.lang]; cards = cards.filter((x) => x.type !== 'choices'); conv.lastAsked = 'subject' }

  if (intakeCard) { cards = cards.filter((x) => x.type !== 'choices'); cards.push(intakeCard) }
  // an AI outage is said as it is (rate limit, timeout), never hidden behind a generic line
  const modelError = c.results.__modelError as string | undefined
  if (modelError && reply === TEMPLATES.aiDown[c.lang]) reply = tpl(TEMPLATES.aiBusy[c.lang], { why: modelError === 'rate_limited' ? 'too many requests' : modelError === 'timeout' ? 'it took too long' : 'it is unavailable' })

  // persist once (dedupe per turn) with optimistic concurrency against a concurrent turn
  const dedupeKey = `reply:${s.turn!.messageId}`
  await tx(c, async (t) => {
    const done = await t.query('select 1 from education_tutor.agent_messages where conversation_id = $1 and dedupe_key = $2', [c.conversationId, dedupeKey])
    if (done.rowCount) return
    const cur = await getConversation(t, c.conversationId, true)
    if (!cur || cur.version !== c.convVersion) throw new AppError('conversation_busy', 'Another message is still being handled. Please try again.', { status: 409 })
    await saveProfile(c.d, c.p, t, c.profile)
    await saveState(t, c.conversationId, conv)
    await addMessage(c.d, c.p, t, c.conversationId, { role: 'agent', content: reply!, cards, dedupeKey, usage: { calls: c.usage, tools: s.outcomes } })
  })
  return { conv, cards: [] }
}

/** the thread waits for the student's decision on the roadmap; the resume value is their next turn */
export function approvalGate(s: CompanionStateT): CompanionUpdate {
  const next = interrupt({ kind: 'plan_approval', proposalId: s.conv?.proposal?.id ?? null }) as TurnInput
  return { turn: next }
}
/** the thread waits for "complete material or which section?" after a document summary */
export function scopeGate(s: CompanionStateT): CompanionUpdate {
  const next = interrupt({ kind: 'document_scope', documentId: s.conv?.sourceDoc?.id ?? null }) as TurnInput
  return { turn: next }
}
