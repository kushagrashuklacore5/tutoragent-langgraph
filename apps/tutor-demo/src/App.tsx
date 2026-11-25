import { useCallback, useState } from 'react'
import { Launch } from './components/Launch.tsx'
import { Workspace } from './components/Workspace.tsx'
import { endSession, friendly, startSession } from './lib/client.ts'

type Stage = 'launch' | 'opening' | 'workspace'
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

export default function App() {
  const [stage, setStage] = useState<Stage>('launch')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const enter = useCallback(async () => {
    setError(null); setNotice(null); setStage('opening')
    const minimum = new Promise((r) => window.setTimeout(r, reduced() ? 0 : 850))
    try {
      await Promise.all([startSession(), minimum])
      setStage('workspace')
    } catch (e) { setError(friendly(e)); setStage('launch') }
  }, [])
  const exit = useCallback(() => setStage('launch'), [])
  const expired = useCallback(() => { void endSession(); setNotice('Your demo session ended. Start again whenever you like.'); setStage('launch') }, [])

  if (stage === 'workspace') return <Workspace onExit={exit} onExpired={expired} />
  return <Launch opening={stage === 'opening'} error={error} notice={notice} onEnter={() => void enter()} />
}
