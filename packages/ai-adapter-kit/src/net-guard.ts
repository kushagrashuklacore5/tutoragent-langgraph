import { isIP } from 'node:net'

/**
 * Destination checks for outbound AI calls (SSRF protection).
 * The HTTP client validates every address *at connect time* inside the DNS lookup hook, so a
 * hostname that re-resolves to a private address (DNS rebinding) is blocked on the actual connection.
 */

function v4ToInt(ip: string): number {
  return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0
}
const V4_BLOCKS: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
]
function inV4Block(ip: string): boolean {
  const n = v4ToInt(ip)
  return V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
    return (n & mask) === (v4ToInt(base) & mask)
  })
}

/** True for loopback, private, link-local (incl. cloud metadata), CGNAT, multicast and reserved ranges. */
export function isPrivateAddress(ip: string): boolean {
  const fam = isIP(ip)
  if (fam === 4) return inV4Block(ip)
  if (fam === 6) {
    const x = ip.toLowerCase()
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x)
    if (mapped) return inV4Block(mapped[1]!)
    return x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb') || x.startsWith('ff')
  }
  return true // not an IP: treat as unsafe
}

export interface DestinationPolicy {
  /** require https (tenant/BYOK connections, hosted providers) */
  requireHttps: boolean
  /** allow loopback/private addresses (platform-approved self-hosted models such as Ollama) */
  allowPrivateNetwork: boolean
}

/** Static checks on a base URL (scheme, credentials in URL, literal IPs). Hostnames are checked at connect time. */
export function checkBaseUrl(raw: string, policy: DestinationPolicy): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'base URL is not a valid URL' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'only http(s) URLs are allowed' }
  if (policy.requireHttps && url.protocol !== 'https:') return { ok: false, reason: 'https is required for this connection' }
  if (url.username || url.password) return { ok: false, reason: 'credentials must not be embedded in the URL' }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) && isPrivateAddress(host) && !policy.allowPrivateNetwork) return { ok: false, reason: 'private, loopback and link-local addresses are not allowed' }
  if (!policy.allowPrivateNetwork && /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(host)) {
    return { ok: false, reason: 'internal hostnames are not allowed' }
  }
  return { ok: true, url }
}
