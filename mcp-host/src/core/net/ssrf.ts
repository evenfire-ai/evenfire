/**
 * SSRF-safe outbound HTTP primitives, shared by the `http_request` native tool
 * and the guardrail hook fetcher (remote/external hook targets).
 *
 * The guarantees:
 *   - `isPrivateIp` classifies an IP (v4/v6, incl. IPv4-mapped/compatible forms)
 *     as private/loopback/link-local/metadata/reserved — fail-closed on
 *     unparseable-but-v6-looking literals.
 *   - `resolvePinnedPublicIp` validates a URL's host resolves ONLY to public
 *     addresses and returns a single pinned IP, so the caller connects to the
 *     exact address that was validated (closing the DNS-rebinding window).
 *   - `requestPinned` connects to that pinned IP while keeping the original
 *     hostname in the Host header and TLS SNI.
 *
 * This module MUST remain the single source of truth for these checks — do not
 * reimplement them at call sites.
 */
import * as dns from 'dns/promises'
import * as http from 'http'
import * as https from 'https'
import * as net from 'net'

/** Thrown when a target host is (or resolves to) a non-public address, or can't be verified. */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SsrfBlockedError'
  }
}

function stripIpv6Decorations(ip: string): string {
  let s = ip.trim()
  if (s.startsWith('[') && s.endsWith(']')) {
    s = s.slice(1, -1)
  }
  const zoneIdx = s.indexOf('%')
  if (zoneIdx !== -1) {
    s = s.slice(0, zoneIdx)
  }
  return s
}

function parseIpv6ToBytes(ip: string): Uint8Array | null {
  const normalized = stripIpv6Decorations(ip).toLowerCase()
  if (normalized.length === 0) return null

  // Reject more than one "::" compression marker.
  const doubleColonCount = (normalized.match(/::/g) ?? []).length
  if (doubleColonCount > 1) return null

  // Detect IPv4-embedded tail (e.g. "::ffff:192.168.1.1"). The tail is the
  // segment after the final ':' and contains dots.
  let headPart = normalized
  let ipv4Tail: number[] | null = null
  const finalColon = normalized.lastIndexOf(':')
  if (finalColon !== -1 && normalized.slice(finalColon + 1).includes('.')) {
    const tail = normalized.slice(finalColon + 1)
    const ipv4Parts = tail.split('.').map(p => Number(p))
    if (ipv4Parts.length !== 4 || ipv4Parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null
    }
    ipv4Tail = ipv4Parts
    // Replace the IPv4 segment with two placeholder hextets so the rest of
    // the parser treats it as a normal 8-hextet IPv6 literal.
    headPart = normalized.slice(0, finalColon + 1) + '0:0'
  }

  const targetGroupCount = 8
  let left: string[] = []
  let right: string[] = []
  let sawDoubleColon = false

  if (headPart.includes('::')) {
    sawDoubleColon = true
    const [leftRaw, rightRaw] = headPart.split('::')
    left = leftRaw && leftRaw.length > 0 ? leftRaw.split(':') : []
    right = rightRaw && rightRaw.length > 0 ? rightRaw.split(':') : []
  } else {
    left = headPart.split(':')
  }

  // Any empty hextet outside of the "::" marker is invalid.
  if (left.some(h => h === '') || right.some(h => h === '')) return null

  const fillCount = targetGroupCount - (left.length + right.length)
  if (sawDoubleColon) {
    if (fillCount < 0) return null
  } else {
    if (left.length !== targetGroupCount) return null
  }

  const groups = sawDoubleColon
    ? [...left, ...Array.from({ length: fillCount }, () => '0'), ...right]
    : left

  if (groups.length !== targetGroupCount) return null

  const bytes = new Uint8Array(16)
  for (let i = 0; i < groups.length; i++) {
    const part = groups[i]!
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null
    const value = parseInt(part, 16)
    bytes[i * 2] = (value >> 8) & 0xff
    bytes[i * 2 + 1] = value & 0xff
  }

  if (ipv4Tail) {
    bytes[12] = ipv4Tail[0]!
    bytes[13] = ipv4Tail[1]!
    bytes[14] = ipv4Tail[2]!
    bytes[15] = ipv4Tail[3]!
  }
  return bytes
}

function isIpv4MappedBytes(bytes: Uint8Array): boolean {
  for (let i = 0; i < 10; i++) {
    if (bytes[i] !== 0) return false
  }
  return bytes[10] === 0xff && bytes[11] === 0xff
}

function isPrivateIpv4Octets(octets: readonly number[]): boolean {
  if (octets.length !== 4) return false
  const [a = 0, b = 0] = octets
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 0
  )
}

/**
 * Block private and metadata IP ranges (SSRF defense).
 *
 * IPv4 ranges: 10/8, 127/8, 172.16/12, 192.168/16, 169.254/16 (metadata), 0/8.
 * IPv6 ranges: ::/128, ::1/128, fc00::/7, fe80::/10, fec0::/10, plus
 * IPv4-mapped/compatible forms delegated to the IPv4 rules.
 */
export function isPrivateIp(ip: string): boolean {
  if (typeof ip !== 'string' || ip.length === 0) return false

  // IPv6 path — normalize and test against known private prefixes bit-for-bit.
  if (ip.includes(':')) {
    const bytes = parseIpv6ToBytes(ip)
    if (!bytes) {
      // Fail-closed on unparseable literal that still "looks like" IPv6.
      return true
    }

    // ::/128 unspecified and ::1/128 loopback
    let allZero = true
    for (let i = 0; i < 15; i++) {
      if (bytes[i] !== 0) {
        allZero = false
        break
      }
    }
    if (allZero && (bytes[15] === 0 || bytes[15] === 1)) return true

    // fc00::/7  (unique local)
    if ((bytes[0]! & 0xfe) === 0xfc) return true

    // fe80::/10 (link-local) and fec0::/10 (deprecated site-local)
    if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true
    if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0xc0) return true

    // ::ffff:0:0/96 IPv4-mapped — delegate to IPv4 rules.
    if (isIpv4MappedBytes(bytes)) {
      return isPrivateIpv4Octets([bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!])
    }

    // IPv4-compatible ::x.x.x.x (bytes[0..11]==0, bytes[10..11] NOT 0xffff).
    // Form is deprecated but still parseable; attackers use it to wrap a
    // private v4 target inside a literal that survives naive v6 checks.
    // `::` (all-zero) and `::1` were already matched by the unspecified
    // + loopback block above, so any surviving first-12-zero address here
    // is a genuine embedded IPv4.
    let first12AllZero = true
    for (let i = 0; i < 12; i++) {
      if (bytes[i] !== 0) {
        first12AllZero = false
        break
      }
    }
    if (first12AllZero) {
      return isPrivateIpv4Octets([bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!])
    }

    return false
  }

  // IPv4 path
  const parts = ip.split('.').map(p => Number(p))
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false
  }
  return isPrivateIpv4Octets(parts)
}

/**
 * Validate that `url`'s host is public and return a single DNS-pinned IP to
 * connect to. An IP-literal host is checked directly; a hostname is resolved
 * over BOTH A and AAAA (so a private target can't hide behind the record type we
 * skip) and every returned address must be public. Throws `SsrfBlockedError` on
 * a private/reserved address or when resolution fails (fail-closed: an
 * unverifiable host is treated as unsafe).
 */
export async function resolvePinnedPublicIp(url: URL): Promise<string> {
  const bareHost = stripIpv6Decorations(url.hostname)

  // IP-literal targets never resolve via DNS — check the literal directly.
  if (net.isIP(bareHost) !== 0) {
    if (isPrivateIp(url.hostname)) {
      throw new SsrfBlockedError(`Target is a private IP (${bareHost})`)
    }
    return bareHost
  }

  let addresses: string[]
  try {
    const [v4, v6] = await Promise.allSettled([
      dns.resolve4(url.hostname),
      dns.resolve6(url.hostname),
    ])
    addresses = []
    if (v4.status === 'fulfilled') addresses.push(...v4.value)
    if (v6.status === 'fulfilled') addresses.push(...v6.value)
    if (addresses.length === 0) throw new Error('no addresses resolved')
  } catch {
    // Cannot verify the target is not internal → fail closed.
    throw new SsrfBlockedError(
      `DNS resolution failed for "${url.hostname}". Cannot verify IP safety.`
    )
  }

  for (const addr of addresses) {
    if (isPrivateIp(addr)) {
      throw new SsrfBlockedError(`Domain resolves to private IP (${addr})`)
    }
  }
  return addresses[0]!
}

/**
 * Make an HTTP(S) request to a caller-validated, DNS-pinned IP while keeping the
 * original hostname in the Host header and TLS SNI. Reads the full body (callers
 * apply their own size/parse policy) and rejects on error/timeout.
 */
export function requestPinned(opts: {
  url: URL
  method: string
  headers: Record<string, string>
  body?: string
  pinnedIp: string
  timeoutMs: number
}): Promise<{ statusCode: number; body: string }> {
  const { url, method, headers, body, pinnedIp, timeoutMs } = opts
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:'
    const client = isHttps ? https : http
    const defaultPort = isHttps ? 443 : 80
    // IPv6 literals must be bracketed in a Host header but NOT in the
    // hostname/servername fields themselves.
    const hostHeaderValue = url.port ? `${url.hostname}:${url.port}` : url.hostname
    const mergedHeaders: Record<string, string> = { ...headers, host: hostHeaderValue }
    const requestOptions: https.RequestOptions = {
      method,
      headers: mergedHeaders,
      timeout: timeoutMs,
      hostname: pinnedIp,
      port: url.port ? Number(url.port) : defaultPort,
      path: `${url.pathname}${url.search}`,
      // SNI — the TLS handshake must still use the real hostname even though we
      // connect to a pinned IP literal.
      servername: url.hostname,
    }
    const req = client.request(requestOptions, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        resolve({ statusCode: res.statusCode!, body: Buffer.concat(chunks).toString('utf-8') })
      })
    })
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Request timeout'))
    })
    if (body) req.write(body)
    req.end()
  })
}
