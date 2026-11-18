/**
 * Production mail transports. The provider decision (O-5) is open, so two provider-neutral options:
 *  - `smtpTransport`: any SMTP submission service (STARTTLS on 587 or implicit TLS on 465, AUTH PLAIN/LOGIN);
 *  - `httpJsonTransport`: a template for HTTPS JSON mail APIs (endpoint + auth header + body mapper).
 * Neither logs credentials, recipients or message bodies.
 */
import net from 'node:net'
import tls from 'node:tls'
import { randomBytes } from 'node:crypto'
import { AppError, type Environment } from '@platform/core'
import { logger, registerSecret } from '@platform/observability'
import type { SystemDatabase } from '@platform/tenancy-db/system'
import { devOutboxTransport, type MailMessage, type MailTransport } from './mail.ts'

export class MailError extends AppError {
  readonly stage: string
  readonly smtpCode?: number
  constructor(stage: string, message: string, smtpCode?: number) {
    super('mail_send_failed', message, { status: 502, details: { stage, ...(smtpCode ? { smtpCode } : {}) } })
    this.name = 'MailError'
    this.stage = stage
    this.smtpCode = smtpCode
  }
}

export interface MailAddress {
  address: string
  name?: string
}

const ADDRESS = /^[^\s@<>()",;:\\[\]]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/

function assertAddress(a: string, what: string): string {
  if (typeof a !== 'string' || !ADDRESS.test(a) || /[\r\n]/.test(a) || a.length > 254) throw new AppError('mail_address_invalid', `Invalid ${what} address`, { status: 400 })
  return a
}

/** RFC 2047 encoded-word for non-ASCII header text; CR/LF are removed (header injection). */
export function encodeHeaderText(s: string): string {
  const clean = s.replace(/[\r\n]+/g, ' ')
  if (/^[\x20-\x7e]*$/.test(clean)) return clean
  // split on code points so no multi-byte character straddles two encoded words
  const words: string[] = []
  let chunk = ''
  for (const ch of clean) {
    if (Buffer.byteLength(chunk + ch) > 45) { words.push(chunk); chunk = '' }
    chunk += ch
  }
  if (chunk) words.push(chunk)
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ')
}

const formatAddress = (a: MailAddress) => a.name ? `${/^[\x20-\x7e]*$/.test(a.name) ? `"${a.name.replace(/[\r\n"\\]/g, '')}"` : encodeHeaderText(a.name)} <${a.address}>` : a.address

/** Build an RFC 5322 message (CRLF line endings). Body is 7bit when safe, otherwise base64 UTF-8. */
export function buildMessage(from: MailAddress, m: MailMessage, now = new Date()): string {
  const domain = from.address.split('@')[1]!
  const text = m.text.replace(/\r\n|\r|\n/g, '\r\n')
  const ascii = /^[\x00-\x7f]*$/.test(text) && text.split('\r\n').every((l) => l.length <= 998) && !/[\x00\x0b\x0c\x0e-\x1f\x7f]/.test(text.replace(/\r\n|\t/g, ''))
  const body = ascii ? text : (Buffer.from(m.text, 'utf8').toString('base64').match(/.{1,76}/g) ?? []).join('\r\n')
  return [
    `From: ${formatAddress(from)}`,
    `To: ${m.to}`,
    `Subject: ${encodeHeaderText(m.subject)}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomBytes(16).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Transfer-Encoding: ${ascii ? '7bit' : 'base64'}`,
    'Auto-Submitted: auto-generated',
    '',
    body,
  ].join('\r\n')
}

/** SMTP transparency (RFC 5321 § 4.5.2): lines starting with '.' get an extra '.'. */
export const dotStuff = (msg: string) => msg.replace(/(^|\r\n)\./g, '$1..')

export interface SmtpConfig {
  host: string
  port: number
  /** 'starttls' (port 587, upgrade required, no downgrade), 'implicit' (port 465), 'none' (dev/test only) */
  security: 'starttls' | 'implicit' | 'none'
  auth?: { user: string; pass: string; method?: 'PLAIN' | 'LOGIN' }
  from: MailAddress
  /** EHLO name; defaults to the From domain */
  heloName?: string
  /** per-step inactivity timeout */
  timeoutMs?: number
  /** extra TLS options (e.g. a private CA in tests); certificate verification stays on by default */
  tls?: Pick<tls.ConnectionOptions, 'ca' | 'servername' | 'minVersion' | 'rejectUnauthorized'>
  /** permit AUTH over an unencrypted connection (tests only) */
  allowInsecureAuth?: boolean
}

interface Reply { code: number; lines: string[] }

class SmtpConnection {
  private socket: net.Socket
  private buf = ''
  private waiting: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null
  private pending: Reply[] = []
  private current: string[] = []
  private failure: Error | null = null
  stage = 'connect'
  private readonly timeoutMs: number

  constructor(socket: net.Socket, timeoutMs: number) {
    this.timeoutMs = timeoutMs
    this.socket = socket
    this.attach(socket)
  }

  private attach(s: net.Socket) {
    s.setEncoding('utf8')
    s.setTimeout(this.timeoutMs)
    s.on('data', (d: string) => this.onData(d))
    s.on('timeout', () => this.abort(new MailError(this.stage, `SMTP timeout during ${this.stage}`)))
    s.on('error', (e: NodeJS.ErrnoException) => this.abort(new MailError(this.stage, `SMTP connection error during ${this.stage} (${e.code ?? 'error'})`)))
    s.on('close', () => this.abort(new MailError(this.stage, `SMTP connection closed during ${this.stage}`)))
  }

  private onData(d: string) {
    this.buf += d
    if (this.buf.length > 64_000) return this.abort(new MailError(this.stage, 'SMTP reply too long'))
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '')
      this.buf = this.buf.slice(i + 1)
      const m = /^(\d{3})([ -]?)(.*)$/.exec(line)
      if (!m) return this.abort(new MailError(this.stage, 'Malformed SMTP reply'))
      this.current.push(m[3]!)
      if (m[2] !== '-') {
        const r = { code: Number(m[1]), lines: this.current }
        this.current = []
        if (this.waiting) { const w = this.waiting; this.waiting = null; w.resolve(r) } else this.pending.push(r)
      }
    }
  }

  private abort(e: Error) {
    if (this.failure) return
    this.failure = e
    this.socket.destroy()
    if (this.waiting) { const w = this.waiting; this.waiting = null; w.reject(e) }
  }

  read(): Promise<Reply> {
    if (this.pending.length) return Promise.resolve(this.pending.shift()!)
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => { this.waiting = { resolve, reject } })
  }

  /** Send a command and expect one of `ok`; `label` replaces the command in error text (never secrets). */
  async cmd(line: string | null, ok: number[], stage: string): Promise<Reply> {
    this.stage = stage
    if (line !== null) {
      if (this.failure) throw this.failure
      this.socket.write(line + '\r\n')
    }
    const r = await this.read()
    if (!ok.includes(r.code)) {
      const e = new MailError(stage, `SMTP server rejected ${stage} with ${r.code}`, r.code)
      this.close()
      throw e
    }
    return r
  }

  writeRaw(data: string) {
    this.socket.write(data)
  }

  /** Upgrade to TLS in place (STARTTLS). Any bytes buffered before the handshake are a protocol violation. */
  async upgrade(opts: tls.ConnectionOptions): Promise<void> {
    if (this.buf || this.pending.length) throw new MailError('starttls', 'Unexpected data before TLS handshake')
    this.stage = 'tls'
    const plain = this.socket
    plain.removeAllListeners('data')
    plain.removeAllListeners('timeout')
    plain.removeAllListeners('error')
    plain.removeAllListeners('close')
    plain.setTimeout(0)
    const secure = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect({ ...opts, socket: plain }, () => resolve(s))
      s.once('error', (e: NodeJS.ErrnoException) => reject(new MailError('tls', `TLS handshake failed (${e.code ?? 'error'})`)))
      s.setTimeout(this.timeoutMs, () => { s.destroy(); reject(new MailError('tls', 'TLS handshake timeout')) })
    })
    secure.removeAllListeners('error')
    this.socket = secure
    this.attach(secure)
  }

  close() {
    this.failure ??= new MailError(this.stage, 'closed')
    this.socket.destroy()
  }

  async quit() {
    try {
      this.stage = 'quit'
      this.socket.write('QUIT\r\n')
      await Promise.race([this.read(), new Promise((r) => setTimeout(r, 1000))])
    } catch { /* ignore */ }
    this.close()
  }
}

function ehloCaps(r: Reply): Set<string> {
  return new Set(r.lines.slice(1).map((l) => l.toUpperCase()))
}
const authMethods = (caps: Set<string>) => new Set([...caps].filter((c) => c.startsWith('AUTH')).flatMap((c) => c.replace(/^AUTH[ =]/, '').split(/\s+/)))

/** SMTP submission transport (RFC 5321/6409, STARTTLS RFC 3207, AUTH RFC 4954). One connection per message. */
export function smtpTransport(cfg: SmtpConfig): MailTransport {
  assertAddress(cfg.from.address, 'from')
  if (cfg.auth) { registerSecret(cfg.auth.pass) }
  const timeoutMs = cfg.timeoutMs ?? 20_000
  const helo = cfg.heloName ?? cfg.from.address.split('@')[1]!
  if (!/^[A-Za-z0-9.-]+$/.test(helo)) throw new AppError('config_invalid', 'Invalid SMTP HELO name')
  const tlsOpts: tls.ConnectionOptions = { servername: net.isIP(cfg.host) ? undefined : cfg.host, minVersion: 'TLSv1.2', ...cfg.tls }

  async function connect(): Promise<SmtpConnection> {
    return new Promise((resolve, reject) => {
      const onErr = (e: NodeJS.ErrnoException) => reject(new MailError('connect', `SMTP connect failed (${e.code ?? 'error'})`))
      const s: net.Socket = cfg.security === 'implicit'
        ? tls.connect({ host: cfg.host, port: cfg.port, ...tlsOpts }, () => { s.removeListener('error', onErr); resolve(new SmtpConnection(s, timeoutMs)) })
        : net.connect({ host: cfg.host, port: cfg.port }, () => { s.removeListener('error', onErr); resolve(new SmtpConnection(s, timeoutMs)) })
      s.once('error', onErr)
      s.setTimeout(timeoutMs, () => { s.destroy(); reject(new MailError('connect', 'SMTP connect timeout')) })
    })
  }

  return {
    async send(m) {
      assertAddress(m.to, 'recipient')
      const message = buildMessage(cfg.from, m)
      const c = await connect()
      try {
        await c.cmd(null, [220], 'greeting')
        let caps = ehloCaps(await c.cmd(`EHLO ${helo}`, [250], 'ehlo'))
        if (cfg.security === 'starttls') {
          if (!caps.has('STARTTLS')) throw new MailError('starttls', 'SMTP server does not offer STARTTLS')
          await c.cmd('STARTTLS', [220], 'starttls')
          await c.upgrade(tlsOpts)
          caps = ehloCaps(await c.cmd(`EHLO ${helo}`, [250], 'ehlo'))
        }
        if (cfg.auth) {
          if (cfg.security === 'none' && !cfg.allowInsecureAuth) throw new MailError('auth', 'Refusing SMTP AUTH over an unencrypted connection')
          const offered = authMethods(caps)
          const method = cfg.auth.method ?? (offered.has('PLAIN') ? 'PLAIN' : offered.has('LOGIN') ? 'LOGIN' : null)
          if (!method || !offered.has(method)) throw new MailError('auth', 'SMTP server offers no supported AUTH method')
          if (method === 'PLAIN') {
            await c.cmd(`AUTH PLAIN ${Buffer.from(`\0${cfg.auth.user}\0${cfg.auth.pass}`, 'utf8').toString('base64')}`, [235], 'auth')
          } else {
            await c.cmd('AUTH LOGIN', [334], 'auth')
            await c.cmd(Buffer.from(cfg.auth.user, 'utf8').toString('base64'), [334], 'auth')
            await c.cmd(Buffer.from(cfg.auth.pass, 'utf8').toString('base64'), [235], 'auth')
          }
        }
        await c.cmd(`MAIL FROM:<${cfg.from.address}>`, [250], 'mail_from')
        await c.cmd(`RCPT TO:<${m.to}>`, [250, 251], 'rcpt_to')
        await c.cmd('DATA', [354], 'data')
        c.stage = 'data_end'
        c.writeRaw(dotStuff(message) + '\r\n.\r\n')
        await c.cmd(null, [250], 'data_end')
        await c.quit()
      } catch (e) {
        c.close()
        const me = e instanceof MailError ? e : new MailError('unknown', 'SMTP send failed')
        logger.warn('mail send failed', { transport: 'smtp', stage: me.stage, smtpCode: me.smtpCode })
        throw me
      }
    },
  }
}

export interface HttpJsonMailConfig {
  /** provider endpoint, e.g. https://api.<provider>/v1/send */
  endpoint: string
  /** auth header name (e.g. 'authorization' or a provider-specific key header) and its value */
  authHeader: { name: string; value: string }
  from: MailAddress
  /** map a message to the provider's JSON body; the default is a neutral {from, to, subject, text} */
  buildBody?: (m: MailMessage, from: MailAddress) => unknown
  timeoutMs?: number
  /** allow http:// endpoints (tests only) */
  allowInsecureHttp?: boolean
  fetch?: typeof fetch
}

/** Provider-neutral HTTPS JSON mail API transport (scaffold until O-5 picks a provider). */
export function httpJsonTransport(cfg: HttpJsonMailConfig): MailTransport {
  const u = new URL(cfg.endpoint)
  if (u.protocol !== 'https:' && !(cfg.allowInsecureHttp && u.protocol === 'http:')) throw new AppError('config_invalid', 'Mail API endpoint must use https')
  if (!/^[A-Za-z0-9-]+$/.test(cfg.authHeader.name) || !cfg.authHeader.value) throw new AppError('config_invalid', 'Mail API auth header is invalid')
  assertAddress(cfg.from.address, 'from')
  registerSecret(cfg.authHeader.value)
  const doFetch = cfg.fetch ?? fetch
  const build = cfg.buildBody ?? ((m: MailMessage, from: MailAddress) => ({ from: { email: from.address, name: from.name }, to: [{ email: m.to }], subject: m.subject, text: m.text }))
  return {
    async send(m) {
      assertAddress(m.to, 'recipient')
      let res: Response
      try {
        res = await doFetch(u, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
          headers: { 'content-type': 'application/json', accept: 'application/json', [cfg.authHeader.name]: cfg.authHeader.value },
          body: JSON.stringify(build(m, cfg.from)),
        })
      } catch (e) {
        const stage = (e as Error)?.name === 'TimeoutError' ? 'timeout' : 'connect'
        logger.warn('mail send failed', { transport: 'http_json', stage })
        throw new MailError(stage, `Mail API ${stage === 'timeout' ? 'timed out' : 'unreachable'}`)
      }
      await res.body?.cancel().catch(() => undefined)
      if (!res.ok) {
        logger.warn('mail send failed', { transport: 'http_json', stage: 'response', status: res.status })
        throw new MailError('response', `Mail API returned HTTP ${res.status}`)
      }
    },
  }
}

// ── configuration ──

export type MailConfig =
  | { kind: 'dev_outbox' }
  | { kind: 'smtp'; smtp: SmtpConfig }
  | { kind: 'http_json'; http: HttpJsonMailConfig }

function parseFrom(v: string | undefined): MailAddress {
  if (!v) throw new AppError('mail_not_configured', 'MAIL_FROM is required')
  const m = /^\s*(?:"?([^"<]*?)"?\s*<([^>]+)>|([^\s<>]+))\s*$/.exec(v)
  const address = (m?.[2] ?? m?.[3] ?? '').trim()
  if (!m || !ADDRESS.test(address)) throw new AppError('mail_not_configured', 'MAIL_FROM is not a valid address')
  return { address, name: m[1]?.trim() || undefined }
}

/**
 * Read and validate mail settings. In production this fails closed: the dev outbox, plaintext SMTP
 * and non-https APIs are refused, and missing settings throw `mail_not_configured`.
 *
 *   MAIL_TRANSPORT = smtp | http_json | dev_outbox (default dev_outbox outside production)
 *   MAIL_FROM      = "Ek Bharat.AI <no-reply@example.org>"
 *   SMTP_HOST, SMTP_PORT (587), SMTP_SECURITY (starttls|implicit|none), SMTP_USER, SMTP_PASSWORD,
 *   SMTP_AUTH_METHOD (PLAIN|LOGIN), SMTP_HELO_NAME, SMTP_TIMEOUT_MS
 *   MAIL_API_URL, MAIL_API_AUTH_HEADER (default authorization), MAIL_API_AUTH_VALUE, MAIL_API_TIMEOUT_MS
 */
export function loadMailConfig(env: NodeJS.ProcessEnv, platformEnv: Environment): MailConfig {
  const prod = platformEnv === 'production'
  const kind = env.MAIL_TRANSPORT ?? (prod ? '' : 'dev_outbox')
  const bad = (msg: string): never => { throw new AppError('mail_not_configured', msg) }
  const num = (v: string | undefined, d: number) => {
    if (v === undefined || v === '') return d
    const n = Number(v)
    return Number.isInteger(n) && n > 0 ? n : bad(`Invalid number ${v}`)
  }
  if (kind === 'dev_outbox') {
    if (prod) bad('The dev mail outbox cannot be used in production')
    return { kind }
  }
  if (kind === 'smtp') {
    const security = (env.SMTP_SECURITY ?? 'starttls') as SmtpConfig['security']
    if (!['starttls', 'implicit', 'none'].includes(security)) bad('SMTP_SECURITY must be starttls|implicit|none')
    if (prod && security === 'none') bad('Plaintext SMTP is not allowed in production')
    if (!env.SMTP_HOST) bad('SMTP_HOST is required')
    const user = env.SMTP_USER
    const pass = env.SMTP_PASSWORD
    if (!!user !== !!pass) bad('SMTP_USER and SMTP_PASSWORD must be set together')
    if (prod && !user) bad('SMTP credentials are required in production')
    const method = env.SMTP_AUTH_METHOD as 'PLAIN' | 'LOGIN' | undefined
    if (method && !['PLAIN', 'LOGIN'].includes(method)) bad('SMTP_AUTH_METHOD must be PLAIN|LOGIN')
    return {
      kind,
      smtp: {
        host: env.SMTP_HOST!, port: num(env.SMTP_PORT, security === 'implicit' ? 465 : 587), security, from: parseFrom(env.MAIL_FROM),
        auth: user ? { user, pass: pass!, method } : undefined, heloName: env.SMTP_HELO_NAME, timeoutMs: num(env.SMTP_TIMEOUT_MS, 20_000),
      },
    }
  }
  if (kind === 'http_json') {
    if (!env.MAIL_API_URL || !env.MAIL_API_AUTH_VALUE) bad('MAIL_API_URL and MAIL_API_AUTH_VALUE are required')
    let u: URL
    try { u = new URL(env.MAIL_API_URL!) } catch { return bad('MAIL_API_URL is not a URL') }
    if (u.protocol !== 'https:') bad('MAIL_API_URL must use https')
    return {
      kind,
      http: { endpoint: env.MAIL_API_URL!, authHeader: { name: env.MAIL_API_AUTH_HEADER ?? 'authorization', value: env.MAIL_API_AUTH_VALUE! }, from: parseFrom(env.MAIL_FROM), timeoutMs: num(env.MAIL_API_TIMEOUT_MS, 15_000) },
    }
  }
  return bad(prod ? 'MAIL_TRANSPORT must be smtp or http_json in production' : `Unknown MAIL_TRANSPORT ${kind}`)
}

/** Build the transport for a validated config. `system` is needed only for the dev outbox. */
export function createMailTransport(cfg: MailConfig, deps: { system?: SystemDatabase } = {}): MailTransport {
  if (cfg.kind === 'smtp') return smtpTransport(cfg.smtp)
  if (cfg.kind === 'http_json') return httpJsonTransport(cfg.http)
  if (!deps.system) throw new AppError('mail_not_configured', 'dev outbox needs the system database')
  return devOutboxTransport(deps.system)
}
