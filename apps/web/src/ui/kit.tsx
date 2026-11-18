import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { describeError, isEndpointMissing } from '../lib/api.ts'
import { Icon, type IconName } from './icons.tsx'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
const VARIANT: Record<Variant, string> = {
  primary: 'bg-accent text-on-accent hover:brightness-110 border border-transparent',
  secondary: 'bg-surface text-fg border border-line-strong hover:bg-surface-2',
  ghost: 'bg-transparent text-fg-soft border border-transparent hover:bg-surface-2',
  danger: 'bg-surface text-danger border border-line-strong hover:bg-danger-bg',
}

export function Button({ variant = 'secondary', icon, busy, children, className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; icon?: IconName; busy?: boolean }) {
  return (
    <button type="button" {...rest} disabled={rest.disabled || busy} aria-busy={busy || undefined}
      className={`anim inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-[0.94rem] font-semibold disabled:cursor-not-allowed disabled:opacity-55 ${VARIANT[variant]} ${className}`}>
      {busy ? <Spinner small /> : icon ? <Icon name={icon} size={18} /> : null}
      {children}
    </button>
  )
}

export function Spinner({ small, label }: { small?: boolean; label?: string }) {
  return (
    <span role={label ? 'status' : undefined} className="inline-flex items-center gap-2 text-muted">
      <span aria-hidden className={`inline-block animate-spin rounded-full border-2 border-line-strong border-t-accent ${small ? 'h-4 w-4' : 'h-5 w-5'}`} />
      {label ? <span className="text-sm">{label}</span> : null}
    </span>
  )
}

/** Page title: focus target after navigation (see Shell) and sets the document title. */
export function PageHeader({ title, eyebrow, children, serif = true }: { title: string; eyebrow?: ReactNode; children?: ReactNode; serif?: boolean }) {
  useEffect(() => { document.title = `${title} · Ek Bharat.AI` }, [title])
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow ? <div className="mb-1 text-[0.8rem] font-semibold uppercase tracking-wide text-muted">{eyebrow}</div> : null}
        <h1 tabIndex={-1} className={`${serif ? 'font-serif text-[2.1rem] leading-tight' : 'text-2xl font-bold'} text-fg break-words`}>{title}</h1>
      </div>
      {children ? <div className="flex flex-wrap gap-2">{children}</div> : null}
    </header>
  )
}

export function Card({ children, className = '', as: As = 'section', ...rest }: { children: ReactNode; className?: string; as?: 'section' | 'div' | 'article' | 'li'; 'aria-labelledby'?: string }) {
  return <As {...rest} className={`rounded-xl border border-line bg-surface p-4 sm:p-5 ${className}`}>{children}</As>
}

export function EmptyState({ icon = 'layers', title, children, action }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-xl border border-dashed border-line-strong bg-surface/60 p-6">
      <Icon name={icon} className="text-muted" />
      <h2 className="text-base font-semibold text-fg">{title}</h2>
      {children ? <div className="max-w-prose text-[0.94rem] text-muted">{children}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}

export function Notice({ tone = 'info', children, title, icon }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; children: ReactNode; title?: string; icon?: IconName }) {
  const cls = { info: 'bg-surface-2 text-fg-soft border-line', warn: 'bg-warn-bg text-warn border-warn/30', danger: 'bg-danger-bg text-danger border-danger/30', ok: 'bg-ok-bg text-ok border-ok/30' }[tone]
  const ic: IconName = icon ?? (tone === 'ok' ? 'check' : tone === 'info' ? 'question' : 'alert')
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={`flex gap-3 rounded-lg border p-3 text-[0.94rem] ${cls}`}>
      <Icon name={ic} size={18} className="mt-0.5" />
      <div className="min-w-0">{title ? <p className="font-semibold">{title}</p> : null}<div>{children}</div></div>
    </div>
  )
}

/** Error display with retry; endpoints not yet deployed get a calm "not available yet" message. */
export function ErrorNote({ error, retry, feature }: { error: unknown; retry?: () => void; feature?: string }) {
  if (isEndpointMissing(error)) {
    return <EmptyState icon="clock" title={`${feature ?? 'This feature'} is not available yet`}>Your institution's server does not offer this yet. Everything else keeps working.</EmptyState>
  }
  return (
    <Notice tone="danger" title="That did not work">
      <p>{describeError(error)}</p>
      {retry ? <button type="button" onClick={retry} className="mt-2 font-semibold underline underline-offset-2">Try again</button> : null}
    </Notice>
  )
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div aria-hidden className="space-y-2">
      {Array.from({ length: lines }, (_, i) => <div key={i} className="h-4 animate-pulse rounded bg-surface-2" style={{ width: `${90 - i * 12}%` }} />)}
    </div>
  )
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return <div className="py-6"><Spinner label={label} /></div>
}

/** Modal dialog / sheet on the native <dialog> element (focus trap, Esc and inert background built in). */
export function Dialog({ open, onClose, title, children, variant = 'center', labelledBy }: { open: boolean; onClose: () => void; title: string; children: ReactNode; variant?: 'center' | 'sheet' | 'side'; labelledBy?: string }) {
  const ref = useRef<HTMLDialogElement>(null)
  const restore = useRef<Element | null>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) { restore.current = document.activeElement; d.showModal() }
    if (!open && d.open) { d.close(); (restore.current as HTMLElement | null)?.focus?.() }
  }, [open])
  const pos = {
    center: 'm-auto w-[min(36rem,calc(100vw-2rem))] max-h-[85vh] rounded-xl',
    sheet: 'mt-auto mb-0 mx-0 w-full max-w-none max-h-[85vh] rounded-t-2xl',
    side: 'ml-auto mr-0 my-0 h-full max-h-none w-[min(32rem,100vw)]',
  }[variant]
  const id = labelledBy ?? `dlg-${title.replace(/\W+/g, '-').toLowerCase()}`
  return (
    <dialog ref={ref} aria-labelledby={id} onClose={onClose} onCancel={(e) => { e.preventDefault(); onClose() }}
      onClick={(e) => { if (e.target === ref.current) onClose() }}
      className={`border border-line bg-surface p-0 shadow-xl ${pos}`}>
      {open ? (
        <div className="flex h-full max-h-[inherit] flex-col">
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2">
            <h2 id={id} className="font-semibold">{title}</h2>
            <button type="button" onClick={onClose} className="inline-flex h-11 w-11 items-center justify-center rounded-lg hover:bg-surface-2" aria-label="Close"><Icon name="x" /></button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        </div>
      ) : null}
    </dialog>
  )
}

export function Field({ label, hint, children, id }: { label: string; hint?: string; children: ReactNode; id: string }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-semibold text-fg-soft">{label}</label>
      {children}
      {hint ? <p id={`${id}-hint`} className="text-[0.82rem] text-muted">{hint}</p> : null}
    </div>
  )
}
export const inputCls = 'min-h-11 w-full rounded-lg border border-line-strong bg-surface px-3 py-2 text-fg placeholder:text-faint'

// ── data loading ──
export interface Loaded<T> { data: T | undefined; error: unknown; loading: boolean; reload: () => void; setData: (v: T) => void }

/** Load data with a promise factory; re-runs when `key` changes. Pass key `null` to skip. */
export function useLoad<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>): Loaded<T> {
  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({ data: undefined, error: null, loading: key !== null })
  const [tick, setTick] = useState(0)
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    if (key === null) { setState({ data: undefined, error: null, loading: false }); return }
    const ac = new AbortController()
    setState((s) => ({ ...s, loading: true, error: null }))
    loadRef.current(ac.signal).then(
      (data) => { if (!ac.signal.aborted) setState({ data, error: null, loading: false }) },
      (error: unknown) => { if (!ac.signal.aborted) setState({ data: undefined, error, loading: false }) },
    )
    return () => ac.abort()
  }, [key, tick])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  const setData = useCallback((data: T) => setState({ data, error: null, loading: false }), [])
  return { ...state, reload, setData }
}

/** Run an async action with busy + error state. */
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true)
    setError(null)
    try { return await fn() } catch (e) { setError(e); return undefined } finally { setBusy(false) }
  }, [])
  return { busy, error, run, clear: () => setError(null) }
}
