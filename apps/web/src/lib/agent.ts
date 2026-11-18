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
export interface AgentCard {
  type: 'plan_proposal' | 'links' | 'workflow' | 'agenda' | 'sources'
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
}
export interface AgentView {
  conversationId: string; messages: AgentMessage[]; state: AgentState; pendingProposal: ProposalView | null
  courses: { id: string; code: string; title: string }[]
  profile: { courseId?: string; language?: 'en' | 'hi' | 'hinglish'; openDoubts?: { id: string; text: string }[] }
}
export interface TurnResponse { conversationId: string; messages: AgentMessage[]; state: AgentState }

export const FEASIBILITY_LABEL: Record<Roadmap['feasibility'], string> = { comfortable: 'Fits comfortably', tight: 'Fits, but tight', over: 'Does not fully fit' }
export const hours = (min: number) => `${Math.round((min / 60) * 10) / 10} h`
