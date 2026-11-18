/**
 * Proactive companion rules (pure, unit-tested). The daily background workflow gathers facts from the student's
 * own data and these rules decide — deterministically, without any model call — which (if any) nudges to post and
 * what the next study session should contain. Throttled: at most MAX_PER_DAY nudges a day, a cooldown per kind,
 * and nothing routine while the student is already active today.
 */
export type NudgeKind = 'plan_updated' | 'milestone_overdue' | 'checkpoint_due' | 'repeated_mistake' | 'prerequisite' | 'practice_after_lesson' | 'revision_due' | 'exam_soon'
export interface Link { label: string; href: string }
export interface Nudge { kind: NudgeKind; dedupeKey: string; text: string; links: Link[] }

export interface NudgeFacts {
  now: Date
  courseId: string
  language: 'en' | 'hi' | 'hinglish'
  activeToday: boolean
  nudgesToday: number
  /** nudges posted in the last COOLDOWN_DAYS days */
  recent: { kind: NudgeKind; at: Date }[]
  dueCards: number
  overdueMilestones: { title: string; due: string }[]
  checkpointsDue: { title: string; conceptIds: string[] }[]
  recurringMisconceptions: { conceptId: string; conceptName: string; misconception: string }[]
  weakPrerequisite: { conceptId: string; name: string } | null
  practiceAfterLesson: { conceptId: string; name: string } | null
  planUpdated: { reason: string; version: number } | null
  examInDays: number | null
}

export const MAX_PER_DAY = 2
export const COOLDOWN_DAYS = 3
const PRIORITY: NudgeKind[] = ['plan_updated', 'exam_soon', 'milestone_overdue', 'checkpoint_due', 'repeated_mistake', 'prerequisite', 'practice_after_lesson', 'revision_due']
/** informative events that are posted even when the student is active today */
const ALWAYS: NudgeKind[] = ['plan_updated']

type L = NudgeFacts['language']
const t3 = (l: L, en: string, hinglish: string, hi: string) => (l === 'hi' ? hi : l === 'hinglish' ? hinglish : en)

export function decideNudges(f: NudgeFacts): Nudge[] {
  const day = f.now.toISOString().slice(0, 10)
  const base = `/app/education/tutor/courses/${f.courseId}`
  const cand: Nudge[] = []
  const l = f.language
  const add = (kind: NudgeKind, key: string, text: string, links: Link[]) => cand.push({ kind, dedupeKey: `${kind}:${f.courseId}:${key}`, text, links })
  if (f.planUpdated) add('plan_updated', `v${f.planUpdated.version}`, t3(l, `I updated your study plan: ${f.planUpdated.reason}`, `Maine aapka study plan update kiya hai: ${f.planUpdated.reason}`, `मैंने आपका स्टडी प्लान अपडेट किया है: ${f.planUpdated.reason}`), [{ label: 'Open plan', href: `${base}/plan` }])
  if (f.examInDays !== null && f.examInDays > 0 && f.examInDays <= 7) add('exam_soon', `${f.examInDays <= 2 ? 'd2' : 'd7'}`, t3(l, `Your exam is in ${f.examInDays} day(s). Mixed practice and revision now beat new topics.`, `Exam ${f.examInDays} din mein hai. Ab naye topics se zyada mixed practice aur revision kaam aayega.`, `परीक्षा ${f.examInDays} दिन में है। अब नए टॉपिक से ज़्यादा मिक्स्ड प्रैक्टिस और रिवीज़न काम आएगा।`), [{ label: 'Practice', href: `${base}/practice` }, { label: 'Revise', href: `${base}/revision` }])
  const od = f.overdueMilestones[0]
  if (od) add('milestone_overdue', od.due, t3(l, `"${od.title}" was due ${od.due}. Shall I move the remaining work into the next days? Your plan already makes room for it.`, `"${od.title}" ki date ${od.due} thi. Bacha hua kaam agle dinon mein shift kar doon? Plan mein jagah bana di gayi hai.`, `"${od.title}" की तारीख ${od.due} थी। बचा हुआ काम अगले दिनों में शिफ्ट कर दूँ?`), [{ label: 'Open plan', href: `${base}/plan` }])
  const cp = f.checkpointsDue[0]
  if (cp) add('checkpoint_due', `${day}:${cp.title}`, t3(l, `${cp.title} is due today — about 10 minutes.`, `${cp.title} aaj due hai — lagbhag 10 minute.`, `${cp.title} आज है — लगभग 10 मिनट।`), [{ label: 'Start check', href: `${base}/practice?conceptId=${cp.conceptIds[0] ?? ''}` }])
  const rm = f.recurringMisconceptions[0]
  if (rm) add('repeated_mistake', rm.conceptId, t3(l, `The same mistake keeps coming up in ${rm.conceptName} (${rm.misconception}). A short guided session can fix it.`, `${rm.conceptName} mein ek hi galti baar-baar ho rahi hai (${rm.misconception}). Ek chhota guided session isse theek kar dega.`, `${rm.conceptName} में एक ही गलती बार-बार हो रही है (${rm.misconception})। एक छोटा गाइडेड सेशन मदद करेगा।`), [{ label: 'Guided session', href: `${base}/tutor?conceptId=${rm.conceptId}` }])
  if (f.weakPrerequisite) add('prerequisite', f.weakPrerequisite.conceptId, t3(l, `${f.weakPrerequisite.name} isn't secure yet and later topics build on it. 15 minutes there will make the rest easier.`, `${f.weakPrerequisite.name} abhi pakka nahi hai aur aage ke topics isi par based hain. 15 minute isme lagao, baaki aasaan ho jayega.`, `${f.weakPrerequisite.name} अभी पक्का नहीं है और आगे के टॉपिक इसी पर आधारित हैं।`), [{ label: 'Review it', href: `${base}/practice?conceptId=${f.weakPrerequisite.conceptId}` }])
  if (f.practiceAfterLesson) add('practice_after_lesson', f.practiceAfterLesson.conceptId, t3(l, `You studied ${f.practiceAfterLesson.name} recently. A few practice questions now will help it stick.`, `Aapne haal hi mein ${f.practiceAfterLesson.name} padha. Abhi kuch practice questions se ye yaad rahega.`, `आपने हाल ही में ${f.practiceAfterLesson.name} पढ़ा। अभी कुछ प्रैक्टिस सवाल इसे याद रखने में मदद करेंगे।`), [{ label: 'Practice', href: `${base}/practice?conceptId=${f.practiceAfterLesson.conceptId}` }])
  if (f.dueCards >= 5 || (f.dueCards > 0 && f.examInDays !== null && f.examInDays <= 7)) add('revision_due', day, t3(l, `${f.dueCards} revision cards are due — about ${Math.max(5, Math.round(f.dueCards * 1.5))} minutes.`, `${f.dueCards} revision cards due hain — lagbhag ${Math.max(5, Math.round(f.dueCards * 1.5))} minute.`, `${f.dueCards} रिवीज़न कार्ड बाकी हैं — लगभग ${Math.max(5, Math.round(f.dueCards * 1.5))} मिनट।`), [{ label: 'Revise', href: `${base}/revision` }])

  const cooled = (k: NudgeKind) => f.recent.some((r) => r.kind === k && f.now.getTime() - r.at.getTime() < COOLDOWN_DAYS * 86_400_000)
  const out: Nudge[] = []
  let budget = Math.max(0, MAX_PER_DAY - f.nudgesToday)
  for (const k of PRIORITY) {
    const n = cand.find((c) => c.kind === k)
    if (!n) continue
    const always = ALWAYS.includes(k)
    if (!always && (f.activeToday || cooled(k) || budget <= 0)) continue
    out.push(n)
    if (!always) budget--
  }
  return out
}

export interface SessionAgenda { date: string; items: { kind: 'revise' | 'learn' | 'practice' | 'checkpoint' | 'doubt'; label: string; minutes: number; href?: string }[]; totalMinutes: number }

/** Next study session prepared in advance from today's plan tasks, due cards, checkpoints and open doubts. */
export function prepareSession(o: {
  today: string; courseId: string; dueCards: number
  tasks: { date: string; kind: 'learn' | 'practice' | 'review'; conceptId: string; conceptName: string; minutes: number }[]
  checkpoints: { title: string; due: string; conceptIds: string[] }[]
  openDoubts: { text: string; conceptName?: string }[]
}): SessionAgenda {
  const base = `/app/education/tutor/courses/${o.courseId}`
  const items: SessionAgenda['items'] = []
  if (o.dueCards > 0) items.push({ kind: 'revise', label: `Revise ${o.dueCards} due card(s)`, minutes: Math.max(5, Math.round(o.dueCards * 1.5)), href: `${base}/revision` })
  const doubt = o.openDoubts[0]
  if (doubt) items.push({ kind: 'doubt', label: `Clear up your open doubt: "${doubt.text.slice(0, 80)}"`, minutes: 10, href: '/assistant' })
  for (const t of o.tasks.filter((x) => x.date === o.today && x.kind !== 'review')) {
    items.push(t.kind === 'learn'
      ? { kind: 'learn', label: `Learn: ${t.conceptName}`, minutes: t.minutes, href: `${base}/tutor?conceptId=${t.conceptId}` }
      : { kind: 'practice', label: `Practise: ${t.conceptName}`, minutes: t.minutes, href: `${base}/practice?conceptId=${t.conceptId}` })
  }
  for (const c of o.checkpoints.filter((x) => x.due === o.today)) items.push({ kind: 'checkpoint', label: c.title, minutes: 10, href: `${base}/practice?conceptId=${c.conceptIds[0] ?? ''}` })
  return { date: o.today, items, totalMinutes: items.reduce((n, i) => n + i.minutes, 0) }
}
