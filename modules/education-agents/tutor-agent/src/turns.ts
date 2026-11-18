import { AppError, newId, notFound } from '@platform/core'
import type { ModuleDeps, Principal, RouteDef, SearchHit } from '@platform/contracts'
import type { Sql } from '@platform/tenancy-db'
import { estimate, probeCandidates } from './domain/learner-model.ts'
import { advance, chooseMove, evidenceOutcome, type AttemptAssessment, type MoveDecision, type Segment, type SessionState } from './domain/tutoring.ts'
import { PROMPT_VERSION, buildSocraticPrompt } from './ai.ts'
import { evidenceFor, obj, P, requireEnrolled, str, uuid } from './common.ts'
import { groundSegments, materialBlock, retrieveForTurn, type CitedSegment } from './materials.ts'
import { parseClaims, verifyClaims, type CheckedSegment } from './mathcheck.ts'

/**
 * Tutor session turns: one shared implementation for the JSON route and the SSE streaming route.
 *   prepareTurn  → load session context (RLS), decide the teaching move (deterministic, integrity policy)
 *   (model call: run or stream, through the gateway)
 *   finalizeTurn → verify source labels, then persist turns (encrypted), state and evidence atomically
 * Conversation content is encrypted at rest (deps.crypto); legacy plaintext rows are still readable.
 */

const TASK = 'education.tutor.socratic_turn'
const TABLE = 'turns'

type Crypto = NonNullable<ModuleDeps['crypto']>
const cryptoOf = (d: ModuleDeps): Crypto => {
  if (!d.crypto) throw new AppError('crypto_unavailable', 'Encryption at rest is not configured on this server', { status: 503 })
  return d.crypto
}

export interface TurnRow { id: string; content: string | null; content_enc: string | null; segments: unknown; segments_enc: string | null }

/** Plaintext content of a stored turn (encrypted or legacy plaintext). */
export async function turnContent(d: ModuleDeps, p: Pick<Principal, 'tenantId'>, row: Pick<TurnRow, 'id' | 'content' | 'content_enc'>): Promise<string> {
  if (row.content_enc === null) return row.content ?? ''
  return cryptoOf(d).decrypt(p, { table: TABLE, column: 'content', recordId: row.id }, row.content_enc)
}
/** Stored tutor segments: citation objects since socratic_turn@2, bare chunk ids before (clients normalise both). */
export type StoredSegment = CitedSegment | Segment
export async function turnSegments(d: ModuleDeps, p: Pick<Principal, 'tenantId'>, row: Pick<TurnRow, 'id' | 'segments' | 'segments_enc'>): Promise<StoredSegment[] | null> {
  if (row.segments_enc === null) return (row.segments as StoredSegment[] | null) ?? null
  return JSON.parse(await cryptoOf(d).decrypt(p, { table: TABLE, column: 'segments', recordId: row.id }, row.segments_enc)) as StoredSegment[]
}

/** Insert one turn with content (and segments) encrypted; plaintext never reaches the database. */
export async function insertTurn(d: ModuleDeps, t: Sql, p: Pick<Principal, 'tenantId' | 'userId'>, o: {
  sessionId: string; role: 'student' | 'tutor'; content: string; segments?: StoredSegment[]; move?: string; hintLevel?: number; operationId?: string | null
}): Promise<string> {
  const c = cryptoOf(d)
  const id = newId()
  const contentEnc = await c.encrypt(p, { table: TABLE, column: 'content', recordId: id }, o.content)
  const segmentsEnc = o.segments ? await c.encrypt(p, { table: TABLE, column: 'segments', recordId: id }, JSON.stringify(o.segments)) : null
  await t.query(`insert into education_tutor.turns (id, tenant_id, user_id, session_id, role, content_enc, segments_enc, move, hint_level, operation_id, created_at)
    values ($1, platform.current_tenant(), $2, $3, $4, $5, $6, $7, $8, $9, clock_timestamp())`,
  [id, p.userId, o.sessionId, o.role, contentEnc, segmentsEnc, o.move ?? null, o.hintLevel ?? null, o.operationId ?? null])
  return id
}

/** Re-encrypt the current user's legacy plaintext turns (transition after migration 0002). Returns rows converted. */
export async function encryptLegacyTurns(d: ModuleDeps, t: Sql, p: Pick<Principal, 'tenantId'>, limit = 500): Promise<number> {
  const c = cryptoOf(d)
  const rows = (await t.query<{ id: string; content: string; segments: unknown }>(
    `select id, content, segments from education_tutor.turns where user_id = platform.current_user_id() and content is not null limit $1`, [limit])).rows
  for (const r of rows) {
    const ce = await c.encrypt(p, { table: TABLE, column: 'content', recordId: r.id }, r.content)
    const se = r.segments === null ? null : await c.encrypt(p, { table: TABLE, column: 'segments', recordId: r.id }, JSON.stringify(r.segments))
    await t.query('update education_tutor.turns set content_enc = $2, segments_enc = $3, content = null, segments = null where id = $1 and content is not null', [r.id, ce, se])
  }
  return rows.length
}

export interface TurnRequest { message: string; stuck: boolean; requestFullAnswer: boolean }
export function parseTurnRequest(body: unknown): TurnRequest {
  const b = obj(body)
  return { message: str(b.message, 'message', 8000), stuck: b.stuck === true, requestFullAnswer: b.requestFullAnswer === true }
}

export interface PreparedTurn {
  sessionId: string
  request: TurnRequest
  session: { course_id: string; concept_id: string | null; problem: string | null; language: string; state: SessionState }
  rescue: { id: string; name: string } | null
  decision: MoveDecision
  messages: ReturnType<typeof buildSocraticPrompt>
  /** material retrieved for THIS turn; a "course" segment must cite (and overlap with) one of these */
  hits: SearchHit[]
  /** retrieval was attempted but the index/embedding service failed */
  retrievalDegraded: boolean
}

export interface TurnResult {
  move: MoveDecision['move']
  hintLevel: number
  policyNote: string | null
  segments: CheckedSegment[]
  relabelled: number
  /** maths claims checked by the solver this turn (failed ones are relabelled uncertain) */
  mathChecks: { verified: number; failed: number }
  /** number of material passages the tutor was given (0 = answered without course material) */
  sourcesConsidered: number
  retrievalDegraded: boolean
  checkQuestion: string | null
  assessment: AttemptAssessment
}
interface ModelOutput { segments: Segment[]; assessment: AttemptAssessment; checkQuestion?: string; checks?: unknown }

/** 1–2: load session context (RLS: only the owner can see it) and decide the teaching move. */
export async function prepareTurn(d: ModuleDeps, principal: Principal, sessionIdParam: unknown, body: unknown): Promise<PreparedTurn> {
  const sessionId = uuid(sessionIdParam, 'sessionId')
  const request = parseTurnRequest(body)
  const ctx = await d.inTenant(principal, async (t) => {
    const s = (await t.query<PreparedTurn['session']>(
      'select course_id, concept_id, problem, language, state from education_tutor.sessions where id = $1', [sessionId])).rows[0]
    if (!s) throw notFound('Session')
    const course = await requireEnrolled(t, principal, s.course_id)
    let rescue: { id: string; name: string } | null = null
    let conceptName: string | null = null
    if (s.concept_id) {
      conceptName = (await t.query<{ name: string }>('select name from education_tutor.concepts where id = $1', [s.concept_id])).rows[0]?.name ?? null
      const pre = (await t.query<{ id: string; name: string }>(`select c.id, c.name from education_tutor.concept_edges e join education_tutor.concepts c on c.id = e.from_concept where e.to_concept = $1`, [s.concept_id])).rows
      const ev = await evidenceFor(t, pre.map((x) => x.id))
      const order = probeCandidates(pre.map((x) => ({ conceptId: x.id, estimate: estimate(ev.get(x.id)!) })))
      rescue = pre.find((x) => x.id === order[0]) ?? null
    }
    const rows = (await t.query<TurnRow & { role: 'student' | 'tutor' }>(
      'select id, role, content, content_enc, segments, segments_enc from education_tutor.turns where session_id = $1 order by created_at desc, id desc limit 12', [sessionId])).rows.reverse()
    const history = await Promise.all(rows.map(async (r) => ({ role: r.role, content: await turnContent(d, principal, r) })))
    return { s, course, rescue, conceptName, history }
  })
  const decision = chooseMove(ctx.s.state, { stuck: request.stuck, requestFullAnswer: request.requestFullAnswer, hasProblem: !!ctx.s.problem }, ctx.course.integrity_mode, ctx.rescue?.id ?? null)
  // a rescue probe is about the prerequisite, so search for that; otherwise the message in its context
  const query = decision.move === 'rescue_probe' && ctx.rescue ? `${ctx.rescue.name}\n${request.message}` : [request.message, ctx.conceptName, ctx.s.problem].filter(Boolean).join('\n')
  const r = await retrieveForTurn(d, principal, ctx.s.course_id, query)
  const messages = buildSocraticPrompt({ move: decision.move, hintLevel: decision.hintLevel, language: ctx.s.language, courseTitle: ctx.course.title, conceptName: ctx.conceptName,
    problem: ctx.s.problem, rescueConceptName: decision.move === 'rescue_probe' ? ctx.rescue?.name : null, policyNote: decision.policyNote, history: ctx.history, message: request.message,
    material: materialBlock(r.hits) })
  return { sessionId, request, session: ctx.s, rescue: ctx.rescue, decision, messages, hits: r.hits, retrievalDegraded: r.degraded }
}

/**
 * 4–5: honest labelling, then persist both turns, the new state and evidence in ONE transaction. The state
 * update is conditional on the state the turn was prepared from, so a concurrent turn on the same
 * session cannot be silently overwritten (409 instead; nothing from this turn is stored).
 */
export async function finalizeTurn(d: ModuleDeps, principal: Principal, prep: PreparedTurn, out: ModelOutput, operationId: string | null): Promise<TurnResult> {
  const g = groundSegments(out.segments, prep.hits)
  // maths checks run before the transaction (bounded by the solver client's timeout); they never fail the turn
  const m = await verifyClaims(d.math, g.segments, parseClaims(out.checks, g.segments.length))
  const segments = m.segments
  const relabelled = g.relabelled + m.failed
  const { decision, session: s } = prep
  const nextState = { ...advance(s.state, decision, out.assessment), rescueTarget: decision.move === 'rescue_probe' ? prep.rescue?.id ?? null : s.state.rescueTarget }
  const outcome = evidenceOutcome(out.assessment)
  await d.inTenant(principal, async (t) => {
    const upd = await t.query('update education_tutor.sessions set state = $2 where id = $1 and state = $3::jsonb', [prep.sessionId, JSON.stringify(nextState), JSON.stringify(s.state)])
    if (!upd.rowCount) throw new AppError('session_busy', 'This session changed while the reply was being written; please resend your message', { status: 409 })
    await insertTurn(d, t, principal, { sessionId: prep.sessionId, role: 'student', content: prep.request.message })
    await insertTurn(d, t, principal, { sessionId: prep.sessionId, role: 'tutor', content: segments.map((x) => x.text).join('\n\n'), segments, move: decision.move, hintLevel: decision.hintLevel, operationId })
    if (outcome !== null && s.concept_id) {
      await t.query(`insert into education_tutor.evidence (tenant_id, user_id, concept_id, kind, outcome, hints_used, source_ref) values (platform.current_tenant(), $1, $2, 'check', $3, $4, $5)`,
        [principal.userId, s.concept_id, outcome, decision.hintLevel, `session:${prep.sessionId}`])
    }
  })
  return { move: decision.move, hintLevel: decision.hintLevel, policyNote: decision.policyNote ?? null, segments, relabelled, mathChecks: { verified: m.verified, failed: m.failed }, sourcesConsidered: prep.hits.length,
    retrievalDegraded: prep.retrievalDegraded, checkQuestion: out.checkQuestion ?? null, assessment: out.assessment }
}

/** Non-streaming turn. */
export async function runTurn(d: ModuleDeps, principal: Principal, sessionId: unknown, body: unknown, signal?: AbortSignal): Promise<TurnResult> {
  const prep = await prepareTurn(d, principal, sessionId, body)
  const out = await d.ai(principal).run(TASK, { messages: prep.messages }, { promptVersion: PROMPT_VERSION, signal })
  return finalizeTurn(d, principal, prep, out.json as ModelOutput, out.operationId)
}

/**
 * Incrementally pulls the `"text"` string values out of the model's partial JSON so they can be shown
 * while it is being written. Display-only: sources are not shown until the verified `turn` event.
 */
export function createSegmentTextExtractor() {
  let buf = ''
  const sent: number[] = []
  return {
    push(delta: string): { index: number; delta: string }[] {
      buf += delta
      const out: { index: number; delta: string }[] = []
      const re = /"text"\s*:\s*"((?:[^"\\]|\\.)*)/g
      let m: RegExpExecArray | null
      let i = 0
      while ((m = re.exec(buf))) {
        let text = ''
        try {
          text = JSON.parse(`"${m[1]!.replace(/\\u[0-9a-fA-F]{0,3}$/, '')}"`) as string
        } catch { /* incomplete escape: wait for more input */ }
        const prev = sent[i] ?? 0
        if (text.length > prev) {
          out.push({ index: i, delta: text.slice(prev) })
          sent[i] = text.length
        }
        i++
      }
      return out
    },
  }
}

export type TurnStreamEvent =
  | { type: 'start'; move: MoveDecision['move']; hintLevel: number; policyNote: string | null }
  | { type: 'progress'; index: number; delta: string }
  | ({ type: 'turn' } & TurnResult)

/**
 * Streaming turn: `start`, then `progress` (partial segment text, unverified, no source labels), then
 * exactly one authoritative `turn` event (same shape as the JSON route) after labels are verified and
 * everything is persisted. If the client disconnects or the model fails, nothing is persisted and the
 * session state is unchanged.
 */
export async function* streamTurn(d: ModuleDeps, principal: Principal, prep: PreparedTurn, signal: AbortSignal): AsyncGenerator<TurnStreamEvent> {
  yield { type: 'start', move: prep.decision.move, hintLevel: prep.decision.hintLevel, policyNote: prep.decision.policyNote ?? null }
  const ex = createSegmentTextExtractor()
  let output: ModelOutput | undefined
  for await (const ev of d.ai(principal).stream(TASK, { messages: prep.messages }, { promptVersion: PROMPT_VERSION, signal })) {
    if (signal.aborted) return
    if (ev.t === 'text') for (const p of ex.push(ev.delta)) yield { type: 'progress', ...p }
    else if (ev.t === 'output') output = ev.json as ModelOutput
  }
  if (signal.aborted) return
  if (!output) throw new AppError('invalid_output', 'The tutor reply was incomplete', { status: 502 })
  // the gateway's streaming API does not expose the metering operation id; streamed turns store null
  yield { type: 'turn', ...(await finalizeTurn(d, principal, prep, output, null)) }
}

export interface SessionSummary {
  id: string; conceptId: string | null; conceptName: string | null; problem: string | null; graded: boolean; language: string
  createdAt: string; lastActivityAt: string; turns: number
}
export interface HistoryTurn { id: string; role: 'student' | 'tutor'; content: string; segments: StoredSegment[] | null; move: string | null; hintLevel: number | null; createdAt: string }

/** The caller's own sessions in a course, most recently active first (RLS: owner only). */
export async function listSessions(d: ModuleDeps, principal: Principal, courseIdParam: unknown, limitParam: string | null): Promise<SessionSummary[]> {
  const courseId = uuid(courseIdParam, 'courseId')
  const limit = Math.max(1, Math.min(100, Number(limitParam) || 30))
  return d.inTenant(principal, async (t) => {
    await requireEnrolled(t, principal, courseId)
    const rows = (await t.query<{ id: string; concept_id: string | null; concept_name: string | null; problem: string | null; graded: boolean; language: string; created_at: Date; last_at: Date | null; n: string }>(
      `select s.id, s.concept_id, c.name as concept_name, s.problem, s.graded, s.language, s.created_at, max(t.created_at) as last_at, count(t.id) as n
         from education_tutor.sessions s
         left join education_tutor.concepts c on c.id = s.concept_id
         left join education_tutor.turns t on t.session_id = s.id
        where s.course_id = $1 and s.user_id = platform.current_user_id()
        group by s.id, c.name
        order by coalesce(max(t.created_at), s.created_at) desc, s.id
        limit $2`, [courseId, limit])).rows
    return rows.map((r) => ({
      id: r.id, conceptId: r.concept_id, conceptName: r.concept_name, problem: r.problem === null ? null : r.problem.slice(0, 200), graded: r.graded, language: r.language,
      createdAt: r.created_at.toISOString(), lastActivityAt: (r.last_at ?? r.created_at).toISOString(), turns: Number(r.n),
    }))
  })
}

/** One session with its decrypted transcript, oldest first (RLS: owner only; must still be enrolled). */
export async function getSession(d: ModuleDeps, principal: Principal, sessionIdParam: unknown) {
  const sessionId = uuid(sessionIdParam, 'sessionId')
  return d.inTenant(principal, async (t) => {
    const s = (await t.query<{ id: string; course_id: string; concept_id: string | null; problem: string | null; graded: boolean; language: string; state: SessionState; created_at: Date }>(
      'select id, course_id, concept_id, problem, graded, language, state, created_at from education_tutor.sessions where id = $1 and user_id = platform.current_user_id()', [sessionId])).rows[0]
    if (!s) throw notFound('Session')
    await requireEnrolled(t, principal, s.course_id)
    const rows = (await t.query<TurnRow & { role: 'student' | 'tutor'; move: string | null; hint_level: number | null; created_at: Date }>(
      'select id, role, content, content_enc, segments, segments_enc, move, hint_level, created_at from education_tutor.turns where session_id = $1 order by created_at, id limit 500', [sessionId])).rows
    const turns: HistoryTurn[] = await Promise.all(rows.map(async (r) => ({
      id: r.id, role: r.role, content: await turnContent(d, principal, r), segments: r.role === 'tutor' ? await turnSegments(d, principal, r) : null,
      move: r.move, hintLevel: r.hint_level, createdAt: r.created_at.toISOString(),
    })))
    return { id: s.id, courseId: s.course_id, conceptId: s.concept_id, problem: s.problem, graded: s.graded, language: s.language, hintLevel: s.state.hintLevel, createdAt: s.created_at.toISOString(), turns }
  })
}

/** Session-turn routes (JSON and SSE). */
export function turnRoutes(d: ModuleDeps): RouteDef[] {
  return [
    { method: 'GET', path: '/courses/:courseId/sessions', permission: P.study, handler: async ({ principal, params, query }) => listSessions(d, principal, params.courseId, query.get('limit')) },
    { method: 'GET', path: '/sessions/:sessionId', permission: P.study, handler: async ({ principal, params }) => getSession(d, principal, params.sessionId) },
    { method: 'POST', path: '/sessions/:sessionId/turns', permission: P.study, handler: async ({ principal, params, body, signal }) => runTurn(d, principal, params.sessionId, body, signal) },
    { method: 'POST', path: '/sessions/:sessionId/turns/stream', permission: P.study, handler: async ({ principal, params, body, signal }) => {
      // validation, session lookup and permission errors are normal HTTP errors, before the stream starts
      const prep = await prepareTurn(d, principal, params.sessionId, body)
      return { stream: streamTurn(d, principal, prep, signal) }
    } },
  ]
}
