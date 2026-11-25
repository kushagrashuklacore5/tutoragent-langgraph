/**
 * Live progress of a companion turn ("Thinking…", "Reading your syllabus…"), streamed to the chat while the graph
 * works: written to LangGraph's custom stream from any node or tool; a no-op outside a running graph (jobs).
 */
import { getWriter } from '@langchain/langgraph'

/** which specialist is working (shown as its avatar) */
export type AgentRole = 'tutor' | 'planner' | 'teacher' | 'coach' | 'librarian'
export interface StatusEvent { type: 'status'; text: string; agent: AgentRole }

export const status = (text: string, agent: AgentRole = 'tutor') => {
  let write: ((chunk: unknown) => void) | undefined
  try { write = getWriter() } catch { write = undefined } // outside a graph run
  write?.({ type: 'status', text, agent } satisfies StatusEvent)
}

/** what each tool is doing, in the student's words */
export const TOOL_STATUS: Record<string, [string, AgentRole]> = {
  'course.create': ['Designing your course syllabus…', 'planner'],
  'curriculum.syllabus': ['Reading your course syllabus…', 'planner'],
  'mastery.analyse': ['Checking what you already know…', 'planner'],
  'exam.insights': ['Checking past and sample papers…', 'planner'],
  'plan.propose': ['Drafting your roadmap…', 'planner'],
  'plan.apply': ['Saving your plan…', 'planner'],
  'materials.search': ['Searching your material…', 'librarian'],
  'studio.open': ['Preparing your book…', 'teacher'],
  'lesson.start': ['Preparing your lesson…', 'teacher'],
  'practice.start': ['Picking practice questions…', 'coach'],
  'assessment.self_test': ['Building your test…', 'coach'],
  'revision.status': ['Checking your revision cards…', 'coach'],
  'growth.summary': ['Looking at your progress…', 'coach'],
  'learning.observe': ['Looking at how you learn best…', 'coach'],
}
