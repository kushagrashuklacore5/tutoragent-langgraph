import { useEffect, useState } from 'react'
import { prefs, type Theme } from '../lib/storage.ts'
import { LANGUAGES, type Language } from '../lib/tutor.ts'
import { useSession } from '../session.tsx'
import { TUTOR, api } from '../lib/api.ts'
import { canSpeak, preferredVoiceName, rankVoices, setPreferredVoiceName, speak, type VoiceLang } from '../lib/voice.ts'
import { Button, Card, ErrorNote, Field, Notice, PageHeader, inputCls, useAction, useLoad } from '../ui/kit.tsx'

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
        {s.me?.isPlatformAdmin ? <AiKeys /> : null}
        {canSpeak() ? <TutorVoice language={language} /> : null}
        {s.me?.roles.includes('tenant_admin') && s.tutorEnabled ? <ProductInsights /> : null}
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

interface Conn { id: string; adapter: string; name: string; status: string; key: { last4: string } | null }

/** Platform admins: replace an AI provider key (stored encrypted; never shown again, only its last 4 characters). */
function AiKeys() {
  const v = useLoad<Conn[]>('ai-connections', (sig) => api.get('/api/admin/ai/connections', sig))
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [done, setDone] = useState<string | null>(null)
  const a = useAction()
  const save = async (c: Conn) => {
    const r = await a.run(() => api.post(`/api/admin/ai/connections/${c.id}/rotate-key`, { apiKey: (keys[c.id] ?? '').trim() }))
    if (r !== undefined) { setKeys((k) => ({ ...k, [c.id]: '' })); setDone(c.name); v.reload() }
  }
  return (
    <Card>
      <h2 className="mb-1 text-lg font-semibold">AI provider keys</h2>
      <p className="mb-3 text-sm text-muted">Paste a new key to replace the current one. It is stored encrypted and never shown again.</p>
      {v.error ? <ErrorNote error={v.error} retry={v.reload} /> : null}
      <ul className="grid gap-3">
        {(v.data ?? []).filter((c) => c.key || c.adapter !== 'ollama').map((c) => (
          <li key={c.id} className="grid gap-2 rounded-lg border border-line p-3">
            <p className="text-sm"><b>{c.name}</b> <span className="text-muted">· {c.adapter} · {c.status}{c.key ? ` · key ends …${c.key.last4}` : ' · no key'}</span></p>
            <div className="flex flex-wrap gap-2">
              <label className="sr-only" htmlFor={`key-${c.id}`}>New API key for {c.name}</label>
              <input id={`key-${c.id}`} type="password" autoComplete="off" value={keys[c.id] ?? ''} onChange={(e) => setKeys((k) => ({ ...k, [c.id]: e.target.value }))} placeholder="New API key" className={`${inputCls} max-w-sm flex-1`} />
              <Button busy={a.busy} disabled={(keys[c.id] ?? '').trim().length < 10} onClick={() => void save(c)}>Save key</Button>
            </div>
          </li>
        ))}
      </ul>
      {a.error ? <div className="mt-2"><ErrorNote error={a.error} /></div> : null}
      {done ? <div className="mt-2"><Notice tone="ok" title="Key updated">{done} now uses the new key.</Notice></div> : null}
    </Card>
  )
}

interface Rec { area: string; finding: string; evidence: string; n: number; confidence: 'low' | 'medium' | 'high'; suggestion: string; severity: 'high' | 'medium' | 'low' }
/** Developer product intelligence: aggregates only, never an individual student. */
function ProductInsights() {
  const v = useLoad<{ days: number; recommendations: Rec[]; signals: { area: string }[] }>('product-insights', (sig) => api.get(`${TUTOR}/insights/product?days=30`, sig))
  return (
    <Card>
      <h2 className="mb-1 text-lg font-semibold">Product insights</h2>
      <p className="mb-3 text-sm text-muted">What to improve, from the last 30 days of anonymous aggregates (groups under 5 students are hidden). Findings are correlations, not causes.</p>
      {v.error ? <ErrorNote error={v.error} retry={v.reload} /> : null}
      {v.data && !v.data.recommendations.length ? <Notice>No clear problems yet ({v.data.signals.length} signals checked).</Notice> : null}
      <ul className="grid gap-3">
        {v.data?.recommendations.map((r, i) => (
          <li key={i} className="rounded-lg border border-line p-3">
            <p className="font-semibold">{r.finding} <span className="text-xs font-normal text-muted">· {r.area} · {r.severity} priority · {r.confidence} confidence (n={r.n})</span></p>
            <p className="text-sm text-fg-soft">{r.evidence}</p>
            <p className="mt-1 text-sm">{r.suggestion}</p>
          </li>
        ))}
      </ul>
    </Card>
  )
}

/** The reading voice: the best Indian voices on this device, ranked; the student can pick and test one. */
function TutorVoice({ language }: { language: Language }) {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [picked, setPicked] = useState(preferredVoiceName() ?? '')
  useEffect(() => {
    const load = () => setVoices(window.speechSynthesis.getVoices())
    load()
    window.speechSynthesis.addEventListener('voiceschanged', load)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load)
  }, [])
  const lang = language as VoiceLang
  const ranked = rankVoices(voices, lang)
  const sample = lang === 'hi' ? 'नमस्ते! आज हम प्रकाश संश्लेषण को आसान भाषा में समझेंगे।' : lang === 'hinglish' ? 'Namaste! Aaj hum photosynthesis ko simple tareeke se samjhenge.' : 'Hello! Today we will understand photosynthesis in simple words.'
  const natural = ranked.some((v) => /natural|online/i.test(v.name))
  return (
    <Card>
      <h2 className="mb-1 text-lg font-semibold">Reading voice</h2>
      <p className="mb-3 text-sm text-muted">Indian voices are chosen first. {natural ? 'A natural (neural) voice is available on this device.' : 'For the most natural Indian voices (Neerja, Swara), open Ek Bharat in Microsoft Edge; in Chrome, the Google हिन्दी voice is used.'}</p>
      {ranked.length ? (
        <div className="flex flex-wrap items-end gap-2">
          <Field id="set-voice" label="Voice">
            <select id="set-voice" value={picked} onChange={(e) => { setPicked(e.target.value); setPreferredVoiceName(e.target.value || null) }} className={inputCls}>
              <option value="">Best available ({ranked[0]!.name})</option>
              {ranked.slice(0, 12).map((v) => <option key={v.name} value={v.name}>{v.name} · {v.lang}</option>)}
            </select>
          </Field>
          <Button onClick={() => speak([sample], lang)}>Test</Button>
        </div>
      ) : <Notice>No {lang === 'hi' ? 'Hindi' : 'English (India)'} voice is installed on this device.</Notice>}
    </Card>
  )
}
