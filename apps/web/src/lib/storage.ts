/**
 * Per-browser conveniences (never the source of truth). The API has no "read latest plan / goal" route
 * yet, so the most recent plan and goal the student generated are cached here per user and course.
 */
import type { Goal, Language, Plan } from './tutor.ts'

function read<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : null
  } catch {
    return null
  }
}
function write(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(value))
  } catch { /* storage unavailable: feature degrades to in-memory */ }
}

export type Theme = 'system' | 'light' | 'dark'
export const prefs = {
  language: (): Language => read<Language>('ebs.language') ?? 'en',
  setLanguage: (l: Language) => write('ebs.language', l),
  theme: (): Theme => {
    try { return (localStorage.getItem('ebs.theme') as Theme | null) ?? 'system' } catch { return 'system' }
  },
  setTheme: (t: Theme) => {
    try { if (t === 'system') localStorage.removeItem('ebs.theme'); else localStorage.setItem('ebs.theme', t) } catch { /* ignore */ }
    if (t === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = t
  },
  onboarded: (userId: string) => read<boolean>(`ebs.onboarded.${userId}`) === true,
  setOnboarded: (userId: string) => write(`ebs.onboarded.${userId}`, true),
  plan: (userId: string, courseId: string) => read<Plan & { savedAt: string }>(`ebs.plan.${userId}.${courseId}`),
  setPlan: (userId: string, courseId: string, plan: Plan) => write(`ebs.plan.${userId}.${courseId}`, { ...plan, savedAt: new Date().toISOString() }),
  goal: (userId: string, courseId: string) => read<Goal>(`ebs.goal.${userId}.${courseId}`),
  setGoal: (userId: string, courseId: string, goal: Goal) => write(`ebs.goal.${userId}.${courseId}`, goal),
  doneTasks: (userId: string, courseId: string) => new Set(read<string[]>(`ebs.done.${userId}.${courseId}`) ?? []),
  setDoneTasks: (userId: string, courseId: string, done: Set<string>) => write(`ebs.done.${userId}.${courseId}`, [...done]),
  lastCourse: () => read<string>('ebs.lastCourse'),
  setLastCourse: (id: string) => write('ebs.lastCourse', id),
}

/** Tutor threads survive a reload within the tab (no session-history API yet). */
export function sessionGet<T>(key: string): T | null {
  try { const v = sessionStorage.getItem(key); return v ? (JSON.parse(v) as T) : null } catch { return null }
}
export function sessionSet(key: string, value: unknown): void {
  try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, JSON.stringify(value)) } catch { /* ignore */ }
}
