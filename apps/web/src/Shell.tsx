import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { useSession } from './session.tsx'
import { Icon, type IconName } from './ui/icons.tsx'
import { Dialog } from './ui/kit.tsx'
import { CommandPalette } from './CommandPalette.tsx'
import { ChatDock } from './chat/ChatDock.tsx'

interface NavItem { to: string; label: string; icon: IconName; end?: boolean }

/** Navigation = platform core + whatever the enabled modules contribute (from /api/platform/modules). */
export function useNavItems(): NavItem[] {
  const s = useSession()
  // students: the conversation IS home; workspaces follow. Others keep the dashboard.
  const student = s.tutorEnabled && s.canStudy && s.courses.some((c) => c.role === 'student')
  // CHATBOT-FIRST: a student acts through the conversation; the rest of the menu is for looking things up
  if (student) return [
    { to: '/', label: 'Chat', icon: 'chat', end: true },
    { to: '/today', label: 'My plan', icon: 'home' },
    { to: '/studio', label: 'Books', icon: 'layers' },
    { to: '/app/education/tutor', label: 'Courses', icon: 'book' },
    { to: '/growth', label: 'Progress', icon: 'target' },
    ...(s.isEducator ? [{ to: '/educator', label: 'Educator', icon: 'school' as IconName }] : []),
    { to: '/settings', label: 'Settings', icon: 'settings' },
  ]
  const items: NavItem[] = [{ to: '/', label: 'Today', icon: 'home', end: true }]
  for (const n of s.modules?.nav ?? []) {
    if (n.moduleId === 'education.tutor') {
      items.push({ to: n.path, label: 'Courses', icon: 'book' })
      if (s.canStudy) items.push({ to: '/studio', label: 'Books', icon: 'layers' }, { to: '/revise', label: 'Revise', icon: 'cards' }, { to: '/growth', label: 'Progress', icon: 'target' }, { to: '/today', label: 'Today', icon: 'home' })
      if (s.isEducator) items.push({ to: '/educator', label: 'Educator', icon: 'school' })
    } else {
      items.push({ to: n.path, label: n.label, icon: 'layers' })
    }
  }
  items.push({ to: '/settings', label: 'Settings', icon: 'settings' })
  return items
}

type RailMode = 'auto' | 'open' | 'closed'

export function Shell() {
  const s = useSession()
  const student = s.tutorEnabled && s.canStudy && s.courses.some((c) => c.role === 'student')
  const items = useNavItems()
  const loc = useLocation()
  const navigate = useNavigate()
  const [palette, setPalette] = useState(false)
  const [more, setMore] = useState(false)
  const [rail, setRail] = useState<RailMode>('auto')
  const first = useRef(true)

  // Ctrl/⌘ K opens the command palette from anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // after client-side navigation move focus to the new page's heading (screen readers announce it)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    setMore(false)
    let tries = 0
    const t = window.setInterval(() => {
      const h = document.querySelector<HTMLElement>('main h1')
      if (h || ++tries > 20) { window.clearInterval(t); h?.focus({ preventScroll: true }); window.scrollTo(0, 0) }
    }, 50)
    return () => window.clearInterval(t)
  }, [loc.pathname])

  const label = rail === 'auto' ? 'hidden xl:inline' : rail === 'open' ? 'inline' : 'hidden'
  const width = rail === 'auto' ? 'md:w-[4.75rem] xl:w-60' : rail === 'open' ? 'md:w-60' : 'md:w-[4.75rem]'
  const bottom: NavItem[] = [
    ...(student ? [{ to: '/', label: 'Chat', icon: 'chat' as IconName, end: true }, { to: '/today', label: 'My plan', icon: 'home' as IconName }, { to: '/studio', label: 'Books', icon: 'layers' as IconName }, { to: '/growth', label: 'Progress', icon: 'target' as IconName }]
      : [{ to: '/', label: 'Today', icon: 'home' as IconName, end: true }, ...(s.tutorEnabled ? [{ to: '/app/education/tutor', label: 'Courses', icon: 'book' as IconName, end: true }, { to: '/studio', label: 'Books', icon: 'chat' as IconName }] : [])]),
  ]

  return (
    <div className="min-h-dvh md:flex">
      <a href="#main" className="sr-only z-50 rounded bg-navy px-3 py-2 text-on-navy focus:not-sr-only focus:fixed focus:left-2 focus:top-2">Skip to content</a>

      {/* rail: icons at 768–1279, labels from 1280 (or as toggled) */}
      <nav aria-label="Main" className={`anim sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-line bg-navy text-on-navy md:flex ${width}`}>
        <div className="flex items-center gap-2 px-4 py-4">
          <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-white/25 font-serif text-lg">ए</span>
          <span className={`${label} font-semibold leading-tight`}>Ek Bharat.AI<span className="block text-xs font-normal opacity-75">Study desk</span></span>
        </div>
        <button type="button" onClick={() => setPalette(true)} className="mx-3 mb-3 flex min-h-11 items-center gap-2 rounded-lg border border-white/20 px-3 text-sm text-on-navy/85 hover:bg-white/10" aria-keyshortcuts="Control+K Meta+K">
          <Icon name="search" size={18} /><span className={label}>Search or jump…</span><kbd className={`${label} ml-auto font-mono text-xs opacity-70`}>Ctrl K</kbd>
        </button>
        <ul className="flex flex-1 flex-col gap-1 px-3">
          {items.map((it) => (
            <li key={it.to}>
              <NavLink to={it.to} end={it.end} title={it.label}
                className={({ isActive }) => `anim flex min-h-11 items-center gap-3 rounded-lg px-3 text-[0.94rem] ${isActive ? 'bg-white/14 font-semibold text-white' : 'text-on-navy/80 hover:bg-white/8'}`}>
                <Icon name={it.icon} /><span className={label}>{it.label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="border-t border-white/12 p-3">
          <p className={`${label} mb-2 truncate px-1 text-xs opacity-75`} title={s.me?.email}>{s.me?.email}</p>
          <button type="button" onClick={() => setRail(rail === 'closed' || (rail === 'auto' && window.innerWidth < 1280) ? 'open' : 'closed')}
            className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-sm text-on-navy/80 hover:bg-white/8" aria-label="Expand or collapse navigation">
            <Icon name="panel" /><span className={label}>Collapse</span>
          </button>
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* compact top bar on phones */}
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-surface/95 px-4 py-2 backdrop-blur-none md:hidden">
          <span className="flex items-center gap-2 font-semibold"><span aria-hidden className="grid h-8 w-8 place-items-center rounded-md bg-navy font-serif text-on-navy">ए</span>Study desk</span>
          <button type="button" onClick={() => setPalette(true)} className="inline-flex h-11 w-11 items-center justify-center rounded-lg hover:bg-surface-2" aria-label="Search or jump"><Icon name="search" /></button>
        </header>
        <main id="main" className="mx-auto w-full max-w-[90rem] flex-1 px-4 pb-28 pt-5 sm:px-6 md:pb-10 lg:px-8">
          <Outlet />
        </main>
        {/* one chat: the home page IS the chat; a book carries it in its side panel */}
        {student && loc.pathname !== '/' && !/^\/studio\/[^/]+$/.test(loc.pathname) ? <ChatDock /> : null}
      </div>

      {/* bottom bar on phones: Today · Courses · Tutor · Revise · More */}
      <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface md:hidden" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <ul className="grid" style={{ gridTemplateColumns: `repeat(${bottom.length + 1}, minmax(0, 1fr))` }}>
          {bottom.map((it) => (
            <li key={it.label}>
              <NavLink to={it.to} end={it.end} className={({ isActive }) => `flex min-h-14 flex-col items-center justify-center gap-0.5 text-[0.72rem] ${isActive ? 'font-bold text-accent' : 'text-muted'}`}>
                <Icon name={it.icon} /><span>{it.label}</span>
              </NavLink>
            </li>
          ))}
          <li>
            <button type="button" onClick={() => setMore(true)} className="flex min-h-14 w-full flex-col items-center justify-center gap-0.5 text-[0.72rem] text-muted" aria-haspopup="dialog">
              <Icon name="more" /><span>More</span>
            </button>
          </li>
        </ul>
      </nav>
      <Dialog open={more} onClose={() => setMore(false)} title="More" variant="sheet">
        <ul className="grid gap-1">
          {items.filter((i) => !bottom.some((b) => b.to === i.to)).map((it) => (
            <li key={it.to}><button type="button" onClick={() => { setMore(false); navigate(it.to) }} className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 hover:bg-surface-2"><Icon name={it.icon} />{it.label}</button></li>
          ))}
          <li><button type="button" onClick={() => void s.signOut()} className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-danger hover:bg-danger-bg"><Icon name="logout" />Sign out</button></li>
        </ul>
      </Dialog>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  )
}
