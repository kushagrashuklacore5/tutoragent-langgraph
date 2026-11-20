import { useEffect, useState } from 'react'
import { useLocation } from 'react-router'
import { UniversalChat } from './UniversalChat.tsx'

/** The same conversation, one tap away on every workspace (book, tests, revision, progress…). */
export function ChatDock() {
  const loc = useLocation()
  const [open, setOpen] = useState(false)
  // a workspace the agent opened closes the dock; Escape closes it too
  useEffect(() => { setOpen(false) }, [loc.pathname])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  return (
    <>
      {!open ? (
        <button type="button" className="uc-fab" onClick={() => setOpen(true)} aria-label="Ask your tutor">
          <span aria-hidden className="uc-avatar uc-avatar-sm">ए</span><span className="hidden sm:inline">Ask your tutor</span>
        </button>
      ) : null}
      {open ? (
        <div className="uc-dock" role="dialog" aria-modal="false" aria-label="Your tutor">
          <UniversalChat variant="dock" onClose={() => setOpen(false)} />
        </div>
      ) : null}
    </>
  )
}
