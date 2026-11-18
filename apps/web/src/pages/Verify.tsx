import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { ApiError, api } from '../lib/api.ts'
import { useSession } from '../session.tsx'
import { Button, ErrorNote, Notice, useAction } from '../ui/kit.tsx'
import { AuthFrame } from './SignIn.tsx'

/** Magic-link landing: /auth/verify#token=… — asks for the 18+ confirmation, then verifies (sets the session cookie). */
export default function Verify() {
  const [token] = useState(() => /(?:^|[#&])token=([A-Za-z0-9_-]+)/.exec(window.location.hash)?.[1] ?? '')
  const [minor, setMinor] = useState(false)
  const a = useAction()
  const s = useSession()
  const navigate = useNavigate()

  // keep the one-time token out of history and screenshots
  useEffect(() => { if (window.location.hash) window.history.replaceState(null, '', window.location.pathname) }, [])

  const verify = async (ageAttestation: 'adult' | 'minor') => {
    const r = await a.run(() => api.post('/api/auth/verify', { token, ageAttestation }))
    if (r === undefined) return
    await s.refresh()
    let next = '/'
    try { next = localStorage.getItem('ebs.next') ?? '/'; localStorage.removeItem('ebs.next') } catch { /* ignore */ }
    navigate(next, { replace: true })
  }

  if (!token) {
    return (
      <AuthFrame title="Link not valid">
        <p className="mb-4 text-fg-soft">This sign-in link is incomplete. Open the link from your email again, or request a new one.</p>
        <Link to="/signin" className="font-semibold text-accent underline">Request a new link</Link>
      </AuthFrame>
    )
  }
  if (minor) {
    return (
      <AuthFrame title="This pilot is for adults">
        <Notice tone="info" title="We cannot create an account for you yet">The current pilot is open to students aged 18 and over only. No study data has been stored. Please talk to your institution about access.</Notice>
      </AuthFrame>
    )
  }
  const expired = a.error instanceof ApiError && a.error.status === 401
  return (
    <AuthFrame title="Confirm your age">
      <p className="mb-6 text-fg-soft">This pilot is open to students aged 18 and over. Please confirm before we sign you in.</p>
      {expired ? (
        <Notice tone="danger" title="This link has expired or was already used">Sign-in links work once and expire quickly. <Link to="/signin" className="font-semibold underline">Request a new link</Link>.</Notice>
      ) : a.error ? <ErrorNote error={a.error} /> : null}
      <div className="mt-4 flex flex-col gap-3">
        <Button variant="primary" busy={a.busy} onClick={() => void verify('adult')} disabled={expired}>I am 18 or older — sign me in</Button>
        <Button variant="secondary" disabled={a.busy || expired} onClick={async () => { await a.run(() => api.post('/api/auth/verify', { token, ageAttestation: 'minor' })); setMinor(true) }}>I am under 18</Button>
      </div>
    </AuthFrame>
  )
}
