import { useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router'
import { api } from '../lib/api.ts'
import { Button, ErrorNote, Field, Notice, inputCls, useAction } from '../ui/kit.tsx'

export function AuthFrame({ title, children }: { title: string; children: React.ReactNode }) {
  document.title = `${title} · Ek Bharat.AI`
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
      <div className="mb-8 flex items-center gap-3">
        <span aria-hidden className="grid h-10 w-10 place-items-center rounded-md bg-navy font-serif text-xl text-on-navy">ए</span>
        <span className="font-semibold leading-tight">Ek Bharat.AI<span className="block text-sm font-normal text-muted">Study desk</span></span>
      </div>
      <h1 tabIndex={-1} className="mb-4 font-serif text-[2.2rem] leading-tight">{title}</h1>
      {children}
    </main>
  )
}

export default function SignIn() {
  const [params] = useSearchParams()
  const [tenantSlug, setSlug] = useState(() => { try { return localStorage.getItem('ebs.tenant') ?? '' } catch { return '' } })
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const a = useAction()

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    try {
      localStorage.setItem('ebs.tenant', tenantSlug.trim())
      const next = params.get('next')
      // the link opens in a new tab: keep the destination for after verification
      if (next?.startsWith('/') && !next.startsWith('//')) localStorage.setItem('ebs.next', next)
    } catch { /* ignore */ }
    const ok = await a.run(() => api.post('/api/auth/magic-link', { tenantSlug: tenantSlug.trim(), email: email.trim() }))
    if (ok !== undefined) setSent(true)
  }

  if (sent) {
    return (
      <AuthFrame title="Check your email">
        <Notice tone="ok" title="Sign-in link sent">If <strong>{email}</strong> is a member of <strong>{tenantSlug}</strong>, a sign-in link is on its way. It works once and expires soon.</Notice>
        <Button variant="ghost" className="mt-4 self-start" onClick={() => setSent(false)}>Use a different email</Button>
      </AuthFrame>
    )
  }
  return (
    <AuthFrame title="Sign in">
      <p className="mb-6 text-fg-soft">We will email you a one-time sign-in link. No password needed.</p>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field id="tenant" label="Institution code" hint="The short code your institution gave you, e.g. iit-x.">
          <input id="tenant" className={inputCls} value={tenantSlug} onChange={(e) => setSlug(e.target.value)} required autoComplete="organization" aria-describedby="tenant-hint" />
        </Field>
        <Field id="email" label="Email">
          <input id="email" type="email" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" inputMode="email" />
        </Field>
        {a.error ? <ErrorNote error={a.error} /> : null}
        <Button type="submit" variant="primary" busy={a.busy} disabled={!tenantSlug.trim() || !email.includes('@')}>Email me a sign-in link</Button>
      </form>
    </AuthFrame>
  )
}
