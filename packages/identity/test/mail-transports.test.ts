import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { buildMessage, dotStuff, encodeHeaderText, httpJsonTransport, loadMailConfig, smtpTransport, MailError } from '@platform/identity'
import { configureLogging } from '@platform/observability'
import { selfSignedCert, startMockSmtp } from './mock-smtp.ts'

const logs: string[] = []
const PASS = 'p@ss-Very-Secret-42'
const BODY = 'Sign in: https://app.test/auth/verify#token=SECRET-LINK-TOKEN\n.leading dot line\n..two dots\nend'
const from = { address: 'no-reply@ekbharat.test', name: 'Ek Bharat.AI' }
let pki: { key: string; cert: string }

before(() => {
  configureLogging({ level: 'debug', sink: (l) => logs.push(l) })
  pki = selfSignedCert('localhost')
})
after(() => configureLogging({ level: 'error', sink: () => undefined }))

const msg = (subject = 'Your sign-in link') => ({ to: 'student@uni.test', subject, text: BODY })
const headerOf = (data: string, name: string) => new RegExp(`^${name}: (.*)$`, 'mi').exec(data)?.[1]

function assertNoLeak(...extra: string[]) {
  const all = logs.join('\n') + extra.join('\n')
  for (const s of [PASS, 'SECRET-LINK-TOKEN', Buffer.from(`\0smtp-user\0${PASS}`).toString('base64'), Buffer.from(PASS).toString('base64')]) assert.ok(!all.includes(s), `leaked ${s.slice(0, 6)}…`)
}

test('message format: CRLF, Date, Message-ID, MIME, UTF-8 subject, header injection stripped', () => {
  const m = buildMessage(from, { to: 'a@b.test', subject: 'नमस्ते — sign in\r\nBcc: evil@x.test', text: 'line1\nline2' }, new Date('2026-11-17T10:00:00Z'))
  assert.ok(!/[^\r]\n/.test(m), 'only CRLF line endings')
  assert.equal(headerOf(m, 'Date'), 'Tue, 17 Nov 2026 10:00:00 +0000')
  assert.match(headerOf(m, 'Message-ID')!, /^<[0-9a-f]{32}@ekbharat\.test>$/)
  assert.match(headerOf(m, 'Subject')!, /^=\?UTF-8\?B\?/)
  assert.ok(!/^Bcc:/mi.test(m), 'no injected header')
  const decoded = m.split('\r\n').filter((l) => /=\?UTF-8\?B\?/.test(l)).map((l) => /=\?UTF-8\?B\?([^?]+)\?=/.exec(l)![1]).map((b) => Buffer.from(b!, 'base64').toString()).join('')
  assert.equal(decoded, 'नमस्ते — sign in Bcc: evil@x.test')
  assert.equal(encodeHeaderText('plain ascii'), 'plain ascii')
  assert.equal(dotStuff('a\r\n.b\r\n..c'), 'a\r\n..b\r\n...c')
  assert.equal(dotStuff('.start'), '..start')
  // non-ASCII bodies are base64
  assert.match(buildMessage(from, { to: 'a@b.test', subject: 's', text: 'नमस्ते' }), /Content-Transfer-Encoding: base64/)
})

test('SMTP plaintext (test-only) with AUTH PLAIN: delivered, dot-stuffed on the wire', async () => {
  const srv = await startMockSmtp({ auth: { user: 'smtp-user', pass: PASS } })
  try {
    await smtpTransport({ host: '127.0.0.1', port: srv.port, security: 'none', allowInsecureAuth: true, auth: { user: 'smtp-user', pass: PASS }, from }).send(msg())
    const r = srv.received[0]!
    assert.equal(r.authUser, 'smtp-user')
    assert.equal(r.from, from.address)
    assert.deepEqual(r.to, ['student@uni.test'])
    assert.ok(r.rawData.includes('\r\n..leading dot line\r\n...two dots'), 'dot-stuffed on the wire')
    assert.ok(r.data.endsWith(BODY.replace(/\n/g, '\r\n')), 'body intact after unstuffing')
    assert.equal(headerOf(r.data, 'From'), '"Ek Bharat.AI" <no-reply@ekbharat.test>')
  } finally { await srv.close() }
  assertNoLeak()
})

test('SMTP STARTTLS with a test-generated self-signed certificate and AUTH LOGIN', async () => {
  const srv = await startMockSmtp({ tls: pki, starttls: true, auth: { user: 'smtp-user', pass: PASS }, authMethods: ['LOGIN'] })
  try {
    await smtpTransport({ host: '127.0.0.1', port: srv.port, security: 'starttls', auth: { user: 'smtp-user', pass: PASS }, from, tls: { ca: pki.cert, servername: 'localhost' } }).send(msg('Über ✓'))
    const r = srv.received[0]!
    assert.equal(r.secure, true)
    assert.equal(r.authUser, 'smtp-user')
    // credentials were sent only after the TLS upgrade
    const authAt = srv.transcript.findIndex((l) => l.startsWith('AUTH'))
    assert.ok(authAt > srv.transcript.indexOf('STARTTLS'))
  } finally { await srv.close() }
})

test('SMTP implicit TLS', async () => {
  const srv = await startMockSmtp({ tls: pki, implicitTls: true, auth: { user: 'smtp-user', pass: PASS } })
  try {
    await smtpTransport({ host: '127.0.0.1', port: srv.port, security: 'implicit', auth: { user: 'smtp-user', pass: PASS }, from, tls: { ca: pki.cert, servername: 'localhost' } }).send(msg())
    assert.equal(srv.received[0]!.secure, true)
  } finally { await srv.close() }
})

test('SMTP fails closed: no STARTTLS offered, untrusted certificate, AUTH over plaintext', async () => {
  const noTls = await startMockSmtp({ auth: { user: 'smtp-user', pass: PASS } })
  const untrusted = await startMockSmtp({ tls: pki, starttls: true, auth: { user: 'smtp-user', pass: PASS } })
  try {
    await assert.rejects(smtpTransport({ host: '127.0.0.1', port: noTls.port, security: 'starttls', auth: { user: 'smtp-user', pass: PASS }, from }).send(msg()),
      (e: MailError) => e.stage === 'starttls')
    await assert.rejects(smtpTransport({ host: '127.0.0.1', port: untrusted.port, security: 'starttls', auth: { user: 'smtp-user', pass: PASS }, from, tls: { servername: 'localhost' } }).send(msg()),
      (e: MailError) => e.stage === 'tls')
    await assert.rejects(smtpTransport({ host: '127.0.0.1', port: noTls.port, security: 'none', auth: { user: 'smtp-user', pass: PASS }, from }).send(msg()),
      (e: MailError) => e.stage === 'auth')
    assert.equal(noTls.received.length + untrusted.received.length, 0)
    assert.ok(!noTls.transcript.some((l) => l.startsWith('AUTH')), 'credentials never sent in clear')
  } finally {
    await noTls.close()
    await untrusted.close()
  }
})

test('SMTP failure modes: auth failure, recipient rejection, timeout — no secrets or content in errors/logs', async () => {
  const srv = await startMockSmtp({ tls: pki, starttls: true, auth: { user: 'smtp-user', pass: 'other' } })
  const rejecting = await startMockSmtp({ tls: pki, starttls: true, auth: { user: 'smtp-user', pass: PASS }, rejectRcpt: true })
  const silent = await startMockSmtp({ silent: true })
  const errors: string[] = []
  const tlsOpt = { ca: pki.cert, servername: 'localhost' }
  try {
    await assert.rejects(smtpTransport({ host: '127.0.0.1', port: srv.port, security: 'starttls', auth: { user: 'smtp-user', pass: PASS }, from, tls: tlsOpt }).send(msg()),
      (e: MailError) => { errors.push(e.message, JSON.stringify(e.details)); return e.code === 'mail_send_failed' && e.stage === 'auth' && e.smtpCode === 535 })
    await assert.rejects(smtpTransport({ host: '127.0.0.1', port: rejecting.port, security: 'starttls', auth: { user: 'smtp-user', pass: PASS }, from, tls: tlsOpt }).send(msg()),
      (e: MailError) => { errors.push(e.message); return e.stage === 'rcpt_to' && e.smtpCode === 550 })
    const started = Date.now()
    await assert.rejects(smtpTransport({ host: '127.0.0.1', port: silent.port, security: 'starttls', from, timeoutMs: 300 }).send(msg()),
      (e: MailError) => { errors.push(e.message); return e.stage === 'greeting' && /timeout/.test(e.message) })
    assert.ok(Date.now() - started < 5000)
    await assert.rejects(smtpTransport({ host: '127.0.0.1', port: 1, security: 'starttls', from, timeoutMs: 2000 }).send(msg()), (e: MailError) => e.stage === 'connect')
  } finally {
    await srv.close()
    await rejecting.close()
    await silent.close()
  }
  assertNoLeak(...errors)
  assert.ok(!logs.join('\n').includes('student@uni.test'), 'recipient not logged')
  assert.ok(logs.some((l) => l.includes('mail send failed')))
})

test('SMTP rejects header-injecting recipients', async () => {
  await assert.rejects(smtpTransport({ host: '127.0.0.1', port: 1, security: 'starttls', from }).send({ to: 'a@b.test\r\nRCPT TO:<x@y.test>', subject: 's', text: 't' }), { code: 'mail_address_invalid' })
})

test('HTTP JSON API transport: auth header, neutral body, failures without content', async () => {
  const seen: { headers: http.IncomingHttpHeaders; body: any }[] = []
  let status = 202
  let delay = 0
  const server = http.createServer(async (req, res) => {
    let b = ''
    for await (const c of req) b += c
    seen.push({ headers: req.headers, body: JSON.parse(b) })
    setTimeout(() => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ echoed: b })), delay)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/send`
  try {
    assert.throws(() => httpJsonTransport({ endpoint, authHeader: { name: 'x-api-key', value: PASS }, from }), { code: 'config_invalid' })
    const t = httpJsonTransport({ endpoint, authHeader: { name: 'x-api-key', value: PASS }, from, allowInsecureHttp: true, timeoutMs: 300 })
    await t.send(msg())
    assert.equal(seen[0]!.headers['x-api-key'], PASS)
    assert.deepEqual(seen[0]!.body, { from: { email: from.address, name: from.name }, to: [{ email: 'student@uni.test' }], subject: 'Your sign-in link', text: BODY })
    status = 422
    await assert.rejects(t.send(msg()), (e: MailError) => e.stage === 'response' && !e.message.includes('SECRET-LINK-TOKEN'))
    status = 202
    delay = 1000
    await assert.rejects(t.send(msg()), (e: MailError) => e.stage === 'timeout')
  } finally {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  }
  assertNoLeak()
})

test('mail config validation fails closed in production', () => {
  const prod = (env: Record<string, string>) => () => loadMailConfig(env, 'production')
  const notConfigured = { code: 'mail_not_configured' }
  assert.throws(prod({}), notConfigured)
  assert.throws(prod({ MAIL_TRANSPORT: 'dev_outbox' }), notConfigured)
  assert.throws(prod({ MAIL_TRANSPORT: 'smtp', MAIL_FROM: 'a@b.test', SMTP_HOST: 'smtp.b.test', SMTP_SECURITY: 'none', SMTP_USER: 'u', SMTP_PASSWORD: 'p' }), notConfigured)
  assert.throws(prod({ MAIL_TRANSPORT: 'smtp', MAIL_FROM: 'a@b.test', SMTP_HOST: 'smtp.b.test' }), notConfigured)
  assert.throws(prod({ MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.b.test', SMTP_USER: 'u', SMTP_PASSWORD: 'p' }), notConfigured)
  assert.throws(prod({ MAIL_TRANSPORT: 'http_json', MAIL_FROM: 'a@b.test', MAIL_API_URL: 'http://api.b.test/send', MAIL_API_AUTH_VALUE: 'k' }), notConfigured)
  const smtp = loadMailConfig({ MAIL_TRANSPORT: 'smtp', MAIL_FROM: 'Ek Bharat.AI <no-reply@b.test>', SMTP_HOST: 'smtp.b.test', SMTP_USER: 'u', SMTP_PASSWORD: 'p' }, 'production')
  assert.equal(smtp.kind === 'smtp' && smtp.smtp.port, 587)
  assert.deepEqual(smtp.kind === 'smtp' && smtp.smtp.from, { address: 'no-reply@b.test', name: 'Ek Bharat.AI' })
  const api = loadMailConfig({ MAIL_TRANSPORT: 'http_json', MAIL_FROM: 'a@b.test', MAIL_API_URL: 'https://api.b.test/send', MAIL_API_AUTH_VALUE: 'Bearer k' }, 'production')
  assert.equal(api.kind, 'http_json')
  assert.equal(loadMailConfig({}, 'development').kind, 'dev_outbox')
})
