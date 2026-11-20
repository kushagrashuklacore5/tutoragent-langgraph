import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useSession } from './session.tsx'
import { useNavItems } from './Shell.tsx'
import { Icon, type IconName } from './ui/icons.tsx'
import { Dialog } from './ui/kit.tsx'

interface Action { id: string; label: string; hint?: string; icon: IconName; run: () => void }

/** Ctrl/⌘ K: jump to a course, ask the tutor, start revision. Arrow keys + Enter; Esc closes. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useSession()
  const nav = useNavItems()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  const actions = useMemo<Action[]>(() => {
    const go = (to: string) => () => { onClose(); navigate(to) }
    const list: Action[] = nav.map((n) => ({ id: `nav:${n.to}`, label: n.label, hint: 'Go to', icon: n.icon, run: go(n.to) }))
    for (const c of s.courses) {
      const base = `/app/education/tutor/courses/${c.id}`
      list.push(
        { id: `c:${c.id}`, label: `${c.code} · ${c.title}`, hint: 'Open course', icon: 'book', run: go(base) },
        { id: `p:${c.id}`, label: `Practise ${c.code}`, hint: 'Practice', icon: 'target', run: go(`${base}/practice`) },
        { id: `m:${c.id}`, label: `Materials for ${c.code}`, hint: 'Materials', icon: 'file', run: go(`${base}/materials`) },
        { id: `pl:${c.id}`, label: `Plan for ${c.code}`, hint: 'Plan', icon: 'calendar', run: go(`${base}/plan`) },
      )
    }
    if (s.canStudy && s.tutorEnabled) list.push({ id: 'revise', label: 'Start revision', hint: 'Due cards', icon: 'cards', run: go('/revise') })
    list.push({ id: 'signout', label: 'Sign out', icon: 'logout', run: () => { onClose(); void s.signOut() } })
    return list
  }, [nav, s, navigate, onClose])

  const shown = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    return actions.filter((a) => terms.every((t) => `${a.label} ${a.hint ?? ''}`.toLowerCase().includes(t))).slice(0, 12)
  }, [actions, q])

  useEffect(() => { if (open) { setQ(''); setActive(0); window.setTimeout(() => input.current?.focus(), 0) } }, [open])
  useEffect(() => setActive(0), [q])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, shown.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); shown[active]?.run() }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Search or jump">
      <div onKeyDown={onKey}>
        <label htmlFor="palette-q" className="sr-only">Search actions and courses</label>
        <input id="palette-q" ref={input} value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off"
          role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={shown[active] ? `pa-${shown[active].id}` : undefined}
          placeholder="Type a course, “tutor”, “revise”…" className="min-h-12 w-full rounded-lg border border-line-strong bg-surface px-3 text-fg" />
        <ul id="palette-list" role="listbox" aria-label="Results" className="mt-3 max-h-[50vh] overflow-y-auto">
          {shown.map((a, i) => (
            <li key={a.id} id={`pa-${a.id}`} role="option" aria-selected={i === active} onClick={() => a.run()} onMouseMove={() => setActive(i)}
              className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 ${i === active ? 'bg-surface-2 text-fg' : 'text-fg-soft'}`}>
              <Icon name={a.icon} size={18} className="text-muted" />
              <span className="min-w-0 flex-1 truncate">{a.label}</span>
              {a.hint ? <span className="text-xs text-muted">{a.hint}</span> : null}
            </li>
          ))}
          {!shown.length ? <li className="px-3 py-4 text-muted">No matches.</li> : null}
        </ul>
        <p className="mt-3 text-xs text-muted">↑ ↓ to move · Enter to open · Esc to close</p>
      </div>
    </Dialog>
  )
}
