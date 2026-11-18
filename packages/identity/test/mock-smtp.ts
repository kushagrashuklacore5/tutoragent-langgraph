/**
 * Test helpers: a self-signed X.509 certificate built at test time with node:crypto (minimal DER
 * encoder, no openssl), and an in-process SMTP server supporting EHLO, STARTTLS, implicit TLS,
 * AUTH PLAIN/LOGIN, MAIL/RCPT/DATA with dot-unstuffing, and scripted failures.
 */
import net from 'node:net'
import tls from 'node:tls'
import type { AddressInfo } from 'node:net'
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'

// ── minimal DER ──
const len = (n: number) => n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff])
const tlv = (tag: number, ...content: Buffer[]) => { const c = Buffer.concat(content); return Buffer.concat([Buffer.from([tag]), len(c.length), c]) }
const seq = (...c: Buffer[]) => tlv(0x30, ...c)
const int = (b: Buffer) => tlv(0x02, b[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b)
function oid(s: string) {
  const p = s.split('.').map(Number)
  const out = [40 * p[0]! + p[1]!]
  for (const v of p.slice(2)) {
    const bytes = [v & 0x7f]
    let x = v >> 7
    while (x) { bytes.unshift((x & 0x7f) | 0x80); x >>= 7 }
    out.push(...bytes)
  }
  return tlv(0x06, Buffer.from(out))
}
const utcTime = (d: Date) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'))
const name = (cn: string) => seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn)))))

export function selfSignedCert(cn = 'localhost'): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const alg = seq(oid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]))
  const san = seq(tlv(0x82, Buffer.from(cn)), tlv(0x87, Buffer.from([127, 0, 0, 1])))
  const tbs = seq(
    tlv(0xa0, int(Buffer.from([2]))),
    int(randomBytes(8).fill(0x01, 0, 1)),
    alg,
    name(cn),
    seq(utcTime(new Date(Date.now() - 3_600_000)), utcTime(new Date(Date.now() + 86_400_000))),
    name(cn),
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, seq(seq(oid('2.5.29.17'), tlv(0x04, san)))),
  )
  const sig = sign('sha256', tbs, privateKey)
  const der = seq(tbs, alg, tlv(0x03, Buffer.from([0]), sig))
  const b64 = der.toString('base64').match(/.{1,64}/g)!.join('\n')
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, cert: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n` }
}

export interface ReceivedMail { from: string; to: string[]; data: string; rawData: string; secure: boolean; authUser: string | null }

export interface MockSmtpOptions {
  tls?: { key: string; cert: string }
  /** offer STARTTLS (needs tls) */
  starttls?: boolean
  /** whole connection over TLS from the start */
  implicitTls?: boolean
  auth?: { user: string; pass: string }
  authMethods?: string[]
  rejectRcpt?: boolean
  /** never send the greeting */
  silent?: boolean
}

export async function startMockSmtp(o: MockSmtpOptions) {
  const received: ReceivedMail[] = []
  const transcript: string[] = []
  const handle = (raw: net.Socket) => {
    let sock: net.Socket = raw
    let secure = !!o.implicitTls
    let buf = ''
    let inData = false
    let dataLines: string[] = []
    let from = ''
    let to: string[] = []
    let authUser: string | null = null
    let loginStep: 'user' | 'pass' | null = null
    let loginUser = ''
    const w = (s: string) => sock.write(s + '\r\n')
    const onLine = (line: string) => {
      if (inData) {
        if (line === '.') {
          inData = false
          const rawData = dataLines.join('\r\n')
          received.push({ from, to, rawData, data: dataLines.map((l) => l.startsWith('.') ? l.slice(1) : l).join('\r\n'), secure, authUser })
          dataLines = []
          return w('250 2.0.0 queued')
        }
        dataLines.push(line)
        return
      }
      transcript.push(line)
      if (loginStep === 'user') { loginUser = Buffer.from(line, 'base64').toString(); loginStep = 'pass'; return w('334 UGFzc3dvcmQ6') }
      if (loginStep === 'pass') {
        loginStep = null
        if (o.auth && loginUser === o.auth.user && Buffer.from(line, 'base64').toString() === o.auth.pass) { authUser = loginUser; return w('235 2.7.0 ok') }
        return w('535 5.7.8 authentication failed')
      }
      const [verb = '', ...rest] = line.split(' ')
      const arg = rest.join(' ')
      switch (verb.toUpperCase()) {
        case 'EHLO': {
          const caps = ['mock.test', '8BITMIME']
          if (o.starttls && !secure) caps.push('STARTTLS')
          if (o.auth) caps.push(`AUTH ${(o.authMethods ?? ['PLAIN', 'LOGIN']).join(' ')}`)
          return caps.forEach((c, i) => w(`250${i === caps.length - 1 ? ' ' : '-'}${c}`))
        }
        case 'STARTTLS': {
          w('220 2.0.0 ready')
          sock.removeAllListeners('data')
          const s = new tls.TLSSocket(sock, { isServer: true, key: o.tls!.key, cert: o.tls!.cert })
          s.on('error', () => undefined)
          sock = s
          secure = true
          return attach()
        }
        case 'AUTH': {
          const [mech, initial] = arg.split(' ')
          if (mech === 'PLAIN') {
            const [, u, p] = Buffer.from(initial ?? '', 'base64').toString().split('\0')
            if (o.auth && u === o.auth.user && p === o.auth.pass) { authUser = u!; return w('235 2.7.0 ok') }
            return w('535 5.7.8 authentication failed')
          }
          if (mech === 'LOGIN') { loginStep = 'user'; return w('334 VXNlcm5hbWU6') }
          return w('504 unrecognized')
        }
        case 'MAIL': from = /<(.*)>/.exec(arg)?.[1] ?? ''; return w('250 ok')
        case 'RCPT':
          if (o.rejectRcpt) return w('550 5.1.1 no such user')
          to.push(/<(.*)>/.exec(arg)?.[1] ?? ''); return w('250 ok')
        case 'DATA': inData = true; return w('354 go ahead')
        case 'QUIT': w('221 bye'); return sock.end()
        default: return w('502 unknown')
      }
    }
    const attach = () => {
      sock.setEncoding('utf8')
      sock.on('data', (d: string) => {
        buf += d
        let i
        while ((i = buf.indexOf('\r\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); onLine(l) }
      })
      sock.on('error', () => undefined)
    }
    attach()
    if (!o.silent) w('220 mock.test ESMTP')
    to = []
  }
  const server = o.implicitTls ? tls.createServer({ key: o.tls!.key, cert: o.tls!.cert }, handle) : net.createServer(handle)
  const sockets = new Set<net.Socket>()
  server.on('connection', (s: net.Socket) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    port: (server.address() as AddressInfo).port,
    received,
    transcript,
    async close() {
      for (const s of sockets) s.destroy()
      await new Promise((r) => server.close(r))
    },
  }
}
