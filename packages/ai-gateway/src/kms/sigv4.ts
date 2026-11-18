import { createHash, createHmac } from 'node:crypto'

/**
 * AWS Signature Version 4 (header-based), implemented with node:crypto.
 * Spec: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
 */
export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  /** epoch ms; temporary credentials are refreshed before this */
  expiresAt?: number
}

export interface SignableRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: string
}

const sha256hex = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')
const hmac = (key: Buffer | string, s: string) => createHmac('sha256', key).update(s, 'utf8').digest()

/** RFC 3986 encoding as SigV4 requires (`encodeURIComponent` leaves !'()* unescaped). */
const uriEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

/** `20150830T123600Z` */
export const amzDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

function canonicalQuery(u: URL): string {
  const pairs: [string, string][] = []
  // URLSearchParams decodes '+' as space; SigV4 operates on the raw query, so parse it ourselves
  for (const part of u.search.replace(/^\?/, '').split('&')) {
    if (!part) continue
    const i = part.indexOf('=')
    const k = decodeURIComponent(i < 0 ? part : part.slice(0, i))
    const v = i < 0 ? '' : decodeURIComponent(part.slice(i + 1))
    pairs.push([uriEncode(k), uriEncode(v)])
  }
  pairs.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
  return pairs.map(([k, v]) => `${k}=${v}`).join('&')
}

/** Normalise the path (resolve `.`/`..`, collapse `//`) and encode each segment once (non-S3 services). */
function canonicalPath(u: URL): string {
  const out: string[] = []
  for (const seg of u.pathname.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(uriEncode(decodeURIComponent(seg)))
  }
  const trailing = u.pathname.length > 1 && u.pathname.endsWith('/') && out.length ? '/' : ''
  return '/' + out.join('/') + trailing
}

export interface SignedParts {
  canonicalRequest: string
  stringToSign: string
  signature: string
  authorization: string
}

/**
 * Compute the SigV4 signature. All of `req.headers` are signed (plus `host` and `x-amz-date`, which are
 * added when missing). Returns the intermediate strings too, so tests can compare them with the AWS
 * published test-suite values.
 */
export function signV4(req: SignableRequest, creds: AwsCredentials, region: string, service: string, now: Date = new Date()): SignedParts & { headers: Record<string, string> } {
  const u = new URL(req.url)
  const date = amzDate(now)
  const headers: Record<string, string> = { ...req.headers }
  const lower = new Set(Object.keys(headers).map((k) => k.toLowerCase()))
  if (!lower.has('host')) headers.host = u.host
  if (!lower.has('x-amz-date')) headers['x-amz-date'] = date
  if (creds.sessionToken && !lower.has('x-amz-security-token')) headers['x-amz-security-token'] = creds.sessionToken

  const canon = new Map<string, string[]>()
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase()
    canon.set(key, [...(canon.get(key) ?? []), v.trim().replace(/\s+/g, ' ')])
  }
  const names = [...canon.keys()].sort()
  const signedHeaders = names.join(';')
  const canonicalHeaders = names.map((n) => `${n}:${canon.get(n)!.join(',')}\n`).join('')
  const payloadHash = sha256hex(req.body)
  const canonicalRequest = [req.method.toUpperCase(), canonicalPath(u), canonicalQuery(u), canonicalHeaders, signedHeaders, payloadHash].join('\n')

  const day = date.slice(0, 8)
  const scope = `${day}/${region}/${service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256hex(canonicalRequest)].join('\n')
  const kDate = hmac('AWS4' + creds.secretAccessKey, day)
  const kSigning = hmac(hmac(hmac(kDate, region), service), 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')
  const authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  return { canonicalRequest, stringToSign, signature, authorization, headers: { ...headers, authorization } }
}
