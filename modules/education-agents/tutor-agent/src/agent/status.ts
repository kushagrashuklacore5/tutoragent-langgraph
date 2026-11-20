/**
 * Live progress of a companion turn ("Thinking…", "Reading your syllabus…"), streamed to the chat while the
 * agent works. Per-request via AsyncLocalStorage, so deep steps (planning, tools) can report without plumbing.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

/** which specialist is working (shown as its avatar) */
export type AgentRole = 'tutor' | 'planner' | 'teacher' | 'coach' | 'librarian'
export interface StatusEvent { type: 'status'; text: string; agent: AgentRole }
const als = new AsyncLocalStorage<(e: StatusEvent) => void>()

export const status = (text: string, agent: AgentRole = 'tutor') => { als.getStore()?.({ type: 'status', text, agent }) }
export const withStatus = <T>(emit: (e: StatusEvent) => void, fn: () => Promise<T>): Promise<T> => als.run(emit, fn)

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
