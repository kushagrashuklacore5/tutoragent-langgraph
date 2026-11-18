import { useState } from 'react'
import { prefs, type Theme } from '../lib/storage.ts'
import { LANGUAGES, type Language } from '../lib/tutor.ts'
import { useSession } from '../session.tsx'
import { Button, Card, Field, PageHeader, inputCls } from '../ui/kit.tsx'

export default function Settings() {
  const s = useSession()
  const [theme, setTheme] = useState<Theme>(prefs.theme())
  const [language, setLanguage] = useState<Language>(prefs.language())
  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid max-w-2xl gap-4">
        <Card>
          <h2 className="mb-3 text-lg font-semibold">Account</h2>
          <p className="text-fg-soft">{s.me?.email}</p>
          <p className="text-sm text-muted">Roles: {s.me?.roles.join(', ') || '—'}</p>
          <Button variant="danger" icon="logout" className="mt-3" onClick={() => void s.signOut()}>Sign out</Button>
        </Card>
        <Card>
          <h2 className="mb-3 text-lg font-semibold">Preferences</h2>
          <div className="grid gap-4">
            <Field id="set-lang" label="Tutor language (for new sessions)">
              <select id="set-lang" value={language} onChange={(e) => { const l = e.target.value as Language; setLanguage(l); prefs.setLanguage(l) }} className={inputCls}>
                {LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </Field>
            <fieldset>
              <legend className="mb-1 text-sm font-semibold text-fg-soft">Theme</legend>
              <div className="flex flex-wrap gap-2">
                {(['system', 'light', 'dark'] as const).map((t) => (
                  <label key={t} className={`inline-flex min-h-11 items-center gap-2 rounded-lg border px-3 ${theme === t ? 'border-accent' : 'border-line'}`}>
                    <input type="radio" name="theme" checked={theme === t} onChange={() => { setTheme(t); prefs.setTheme(t) }} className="h-4 w-4 accent-[var(--color-accent)]" />
                    {t === 'system' ? 'Match device' : t === 'light' ? 'Light' : 'Dark'}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        </Card>
        <Card>
          <h2 className="mb-2 text-lg font-semibold">Data &amp; privacy</h2>
          <p className="text-sm text-muted">Download and deletion of your data are handled by your institution during the pilot. Contact your institution admin to request either.</p>
          <h3 className="mt-3 font-semibold">Keyboard</h3>
          <ul className="mt-1 text-sm text-fg-soft">
            <li><kbd className="font-mono">Ctrl/⌘ K</kbd> — search or jump</li>
            <li><kbd className="font-mono">Space</kbd>, <kbd className="font-mono">1–4</kbd> — show answer and grade in revision</li>
            <li><kbd className="font-mono">Enter</kbd> — send to the tutor (Shift+Enter for a new line)</li>
          </ul>
        </Card>
      </div>
    </>
  )
}
