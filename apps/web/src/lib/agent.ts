import { ApiError, toApiError } from './api.ts'
import { SseParser } from './sse.ts'
/** Client types for the study companion (`/agent` routes of education.tutor). */
export interface AgentLink { label: string; href: string }
export interface Milestone { seq: number; title: string; conceptIds: string[]; conceptNames: string[]; due: string }
export interface Roadmap {
  horizon: { start: string; end: string; days: number; fixedDate: boolean }
  dailyMinutes: number; effectiveDailyMinutes: number; requiredMinutes: number; availableMinutes: number
  feasibility: 'comfortable' | 'tight' | 'over'; suggestedDailyMinutes: number | null
  milestones: Milestone[]; checkpoints: Milestone[]
  weeks: { week: number; start: string; learn: number; practice: number; review: number }[]
  gaps: string[]; notStarted: string[]; dropped: { name: string; reason: string }[]; rationale: string[]
}
export interface ProposalView { id: string; courseId: string; courseTitle: string; inputs: { examDate: string | null; dailyMinutes: number; studyDaysPerWeek: number }; roadmap: Roadmap; strategy?: { name: string; label: string; mix: Record<string, number> }; examEvidence?: { papers: number; top: { name: string; priority: number; verified: string; confidence: string }[] } }
export interface Workflow { id: string; kind: 'planning' | 'apply_plan'; status: 'running' | 'done' | 'failed'; steps: { name: string; status: string; error?: string }[] }
export interface Agenda { date: string; items: { kind: string; label: string; minutes: number; href?: string }[]; totalMinutes: number }
/** the one consolidated onboarding intake: every question that still matters, answered together and submitted once */
export interface IntakeQuestion { slot: string; label: string; options: { value: string; label: string }[]; default: string | null; required: boolean; allowCustom: boolean; showIf?: { slot: string; in: string[] } }
export interface IntakeView { id: string; courseId: string; questions: IntakeQuestion[] }
export interface AgentCard {
  type: 'plan_proposal' | 'links' | 'workflow' | 'agenda' | 'sources' | 'choices' | 'book_answer' | 'upload' | 'intake'
  intake?: IntakeView
  auto?: boolean
  choices?: string[]
  bookAnswer?: { bookId: string; resumeTo: { pageNo: number; blockId: string | null } | null; notebookVersion: number }
  proposal?: ProposalView; links?: AgentLink[]; workflow?: Workflow; agenda?: Agenda
  sources?: { filename: string; pages: string; href: string }[]
}
export interface AgentMessage { id: string; role: 'student' | 'agent'; kind: 'text' | 'nudge'; content: string; cards: AgentCard[]; createdAt: string; seen: boolean }
export interface AgentState {
  phase: 'onboarding' | 'planning' | 'awaiting_approval' | 'active'
  pendingProposalId: string | null
  appliedPlan: { courseId: string; version: number } | null
  nextSession: (Agenda & { courseId: string }) | null
  profileComplete: boolean
  questionSet?: { courseId: string; total: number; done: number; status: 'building' | 'ready'; added: number; fromDocument: number } | null
  sourceDoc?: { id: string; title: string; courseId: string } | null
}
export interface AgentView {
  conversationId: string; messages: AgentMessage[]; state: AgentState; pendingProposal: ProposalView | null
  courses: { id: string; code: string; title: string }[]
  profile: { courseId?: string; language?: 'en' | 'hi' | 'hinglish'; openDoubts?: { id: string; text: string }[] }
}
export interface TurnResponse { conversationId: string; messages: AgentMessage[]; state: AgentState }

export const FEASIBILITY_LABEL: Record<Roadmap['feasibility'], string> = { comfortable: 'Fits comfortably', tight: 'Fits, but tight', over: 'Does not fully fit' }
export const hours = (min: number) => `${Math.round((min / 60) * 10) / 10} h`

/** The specialists behind the one chat, each with its own avatar. */
export type AgentRole = 'tutor' | 'planner' | 'teacher' | 'coach' | 'librarian'
export const AGENTS: Record<AgentRole, { name: string; icon: string; tone: string }> = {
  tutor: { name: 'Ek Bharat tutor', icon: 'ए', tone: 'uc-av-tutor' },
  planner: { name: 'Planner', icon: '🧭', tone: 'uc-av-planner' },
  teacher: { name: 'Teacher', icon: '📘', tone: 'uc-av-teacher' },
  coach: { name: 'Practice coach', icon: '🎯', tone: 'uc-av-coach' },
  librarian: { name: 'Librarian', icon: '📚', tone: 'uc-av-librarian' },
}
/** which specialist answered a message (from what it did) */
export function agentOf(m: AgentMessage): AgentRole {
  const t = new Set(m.cards.map((c) => c.type))
  if (t.has('plan_proposal') || t.has('agenda') || t.has('workflow')) return 'planner'
  if (t.has('book_answer')) return 'teacher'
  if (t.has('upload') || t.has('sources')) return 'librarian'
  const href = m.cards.flatMap((c) => c.links ?? []).map((l) => l.href).join(' ')
  if (/\/practice|\/assessments|\/revision|\/revise|\/growth/.test(href)) return 'coach'
  if (/\/studio\//.test(href)) return 'teacher'
  return 'tutor'
}
export interface LiveStatus { text: string; agent: AgentRole }

/** Send a message and follow the agent's work live ("Thinking…", "Drafting your roadmap…"). */
export async function streamTurn(base: string, body: Record<string, unknown>, onStatus: (s: LiveStatus) => void): Promise<TurnResponse> {
  let res: Response
  try {
    res = await fetch(`${base}/messages/stream`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body), credentials: 'same-origin' })
  } catch { throw toApiError(0, null) }
  if (!res.ok) {
    let b: unknown = null
    try { b = await res.json() } catch { /* not json */ }
    throw toApiError(res.status, b)
  }
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const parser = new SseParser()
  let result: TurnResponse | null = null
  const handle = (evs: { event: string; data: string }[]) => {
    for (const ev of evs) {
      const e = JSON.parse(ev.data) as { type: string; text?: string; agent?: AgentRole; result?: TurnResponse; code?: string; message?: string; status?: number }
      if (ev.event === 'error' || e.type === 'failed') throw new ApiError(e.status ?? 502, e.code ?? 'stream_failed', e.message ?? 'The tutor could not finish. Please try again.')
      if (e.type === 'status' && e.text) onStatus({ text: e.text, agent: e.agent ?? 'tutor' })
      if (e.type === 'done' && e.result) result = e.result
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    handle(parser.feed(decoder.decode(value, { stream: true })))
  }
  handle(parser.feed(decoder.decode()))
  handle(parser.end())
  if (!result) throw new ApiError(502, 'stream_incomplete', 'The tutor stopped before finishing. Please try again.')
  return result
}
