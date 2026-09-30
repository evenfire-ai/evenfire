/**
 * SSRF-safe outbound HTTP primitives, shared by the `http_request` native tool
 * and the guardrail hook fetcher (remote/external hook targets).
 *
 * The guarantees:
 *   - `isPrivateIp` classifies an IP (v4/v6, incl. IPv4-mapped/compatible forms)
 *     as private/loopback/link-local/metadata/reserved/special-purpose —
 *     fail-closed on unparseable-but-v6-looking literals.
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

function formatIpv6Bytes(bytes: Uint8Array): string {
  const groups: string[] = []
  for (let i = 0; i < 16; i += 2) {
    groups.push((((bytes[i]! << 8) | bytes[i + 1]!) & 0xffff).toString(16))
  }
  return groups.join(':')
}

/**
 * Non-public IPv4 prefixes in scope for the outbound HTTP guard: the legacy
 * private/loopback/link-local ranges plus special-purpose ranges that must
 * not be treated as public SSRF destinations. This is a deliberate subset
 * of the IPv4 exclusions in deploy/base/public-egress-exceptions.yaml and
 * the IANA range list used by mcp-servers/web-search's fetch destination
 * validator. Those policies also exclude 192.31.196/24, 192.52.193/24,
 * 192.88.99/24, and 192.175.48/24, which stay public here by design: they
 * are relay/service blocks handled by egress policy rather than ranges this
 * model-facing guard needs to classify as non-public.
 */
const NON_PUBLIC_IPV4_PREFIXES: readonly (readonly [address: string, prefix: number])[] = [
  ['0.0.0.0', 8], // "This network"
  ['10.0.0.0', 8], // RFC 1918 private
  ['100.64.0.0', 10], // CGNAT (RFC 6598)
  ['127.0.0.0', 8], // Loopback
  ['169.254.0.0', 16], // Link-local / cloud metadata
  ['172.16.0.0', 12], // RFC 1918 private
  ['192.0.0.0', 24], // IANA special purpose
  ['192.0.2.0', 24], // TEST-NET-1 (RFC 5737)
  ['192.168.0.0', 16], // RFC 1918 private
  ['198.18.0.0', 15], // Benchmarking (RFC 2544)
  ['198.51.100.0', 24], // TEST-NET-2 (RFC 5737)
  ['203.0.113.0', 24], // TEST-NET-3 (RFC 5737)
  ['224.0.0.0', 4], // Multicast
  ['240.0.0.0', 4], // Reserved, including broadcast
]

/**
 * Non-public IPv6 prefixes in scope for this change; this is not a complete
 * IANA special-purpose list. Notably still public: 100::/64 (discard-only),
 * 2001:1::/128, 2001:2::/48, 3fff::/20 (documentation), 5f00::/16, and
 * ISATAP embeddings inside global prefixes. ::/128 and ::1/128 are covered
 * by the IPv4-compatible delegation (their tails fall inside 0.0.0.0/8).
 */
const NON_PUBLIC_IPV6_PREFIXES: readonly (readonly [address: string, prefix: number])[] = [
  ['64:ff9b::', 96], // NAT64 (RFC 6052)
  ['64:ff9b:1::', 48], // Local-use NAT64 (RFC 8215)
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // Documentation (RFC 3849)
  ['2002::', 16], // 6to4 (RFC 3056)
  ['fc00::', 7], // Unique local
  ['fe80::', 10], // Link-local
  ['fec0::', 10], // Deprecated site-local
  ['ff00::', 8], // Multicast
]

const nonPublicAddresses = new net.BlockList()
for (const [address, prefix] of NON_PUBLIC_IPV4_PREFIXES) {
  nonPublicAddresses.addSubnet(address, prefix, 'ipv4')
}
for (const [address, prefix] of NON_PUBLIC_IPV6_PREFIXES) {
  nonPublicAddresses.addSubnet(address, prefix, 'ipv6')
}

function isPrivateIpv4Octets(octets: readonly number[]): boolean {
  if (octets.length !== 4) return false
  return nonPublicAddresses.check(`${octets[0]}.${octets[1]}.${octets[2]}.${octets[3]}`, 'ipv4')
}

/**
 * Block private, metadata, multicast, reserved, and other special-purpose
 * non-public IP ranges (SSRF defense).
 *
 * Policy notes:
 *   - NAT64 (RFC 6052; local-use RFC 8215) and 6to4 (RFC 3056) prefixes are
 *     blocked outright instead of extracting the embedded IPv4: translation
 *     depends on the local gateway, and RFC 8215 embeds are not universally
 *     IPv4 tails. Consequence: a hostname with a public A record plus a NAT64
 *     AAAA record is still rejected (DNS64 environments may be affected).
 *   - IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96) forms delegate
 *     the embedded IPv4 tail to the IPv4 rules.
 *   - Ordinary hostnames and non-IP strings return false; DNS verification
 *     lives in resolvePinnedPublicIp. Only unparseable-but-IPv6-looking
 *     literals fail closed.
 */
export function isPrivateIp(ip: string): boolean {
  if (typeof ip !== 'string' || ip.length === 0) return false

  // IPv6 path — normalize and evaluate the parsed bytes against the prefix table.
  if (ip.includes(':')) {
    const bytes = parseIpv6ToBytes(ip)
    if (!bytes) {
      // Fail-closed on unparseable literal that still "looks like" IPv6.
      return true
    }

    // ::ffff:0:0/96 IPv4-mapped — delegate to IPv4 rules.
    if (isIpv4MappedBytes(bytes)) {
      return isPrivateIpv4Octets([bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!])
    }

    // IPv4-compatible ::x.x.x.x (bytes[0..11]==0, bytes[10..11] NOT 0xffff).
    // Form is deprecated but still parseable; attackers use it to wrap a
    // private v4 target inside a literal that survives naive v6 checks.
    // `::` (all-zero) and `::1` also land here; their tails (0.0.0.0/0.0.0.1)
    // fall inside 0.0.0.0/8, preserving the unspecified + loopback block.
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

    return nonPublicAddresses.check(formatIpv6Bytes(bytes), 'ipv6')
  }

  // IPv4 path. A full dotted quad is required; hostnames and other strings
  // fall through as non-IP (false).
  const parts = ip.split('.').map(p => Number(p))
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false
  }
  return nonPublicAddresses.check(`${parts[0]}.${parts[1]}.${parts[2]}.${parts[3]}`, 'ipv4')
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
 * original hostname in the Host header and TLS SNI. Rejects on error/timeout.
 *
 * The response is bounded in BOTH dimensions so an active-but-unbounded peer
 * cannot hang or OOM the process:
 *   - `signal` — an ABSOLUTE deadline (e.g. `AbortSignal.timeout`). Node's socket
 *     `timeout` (below) is an IDLE timer that a trickling peer resets on every
 *     byte; the abort settles the request regardless of activity.
 *   - `maxBytes` — the body is capped WHILE streaming: once exceeded the request
 *     is destroyed, so an oversized body is never fully buffered (no memory spike,
 *     no `ERR_STRING_TOO_LONG` from `Buffer.concat().toString()`).
 * Both are optional; omitting them preserves the prior behavior for other callers.
 */
export function requestPinned(opts: {
  url: URL
  method: string
  headers: Record<string, string>
  body?: string
  pinnedIp: string
  timeoutMs: number
  /** Absolute-deadline abort (idle-independent). Destroys the request on abort. */
  signal?: AbortSignal
  /** Hard response-body cap; destroy + reject once exceeded (bytes). */
  maxBytes?: number
}): Promise<{ statusCode: number; body: string }> {
  const { url, method, headers, body, pinnedIp, timeoutMs, signal, maxBytes } = opts
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }
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
      let total = 0
      res.on('data', chunk => {
        total += chunk.length
        if (maxBytes !== undefined && total > maxBytes) {
          // Destroy before buffering the over-limit chunk — 'error' → reject.
          req.destroy(new Error('response exceeded maxBytes'))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () =>
        settle(() =>
          resolve({ statusCode: res.statusCode!, body: Buffer.concat(chunks).toString('utf-8') })
        )
      )
    })
    req.on('error', err => settle(() => reject(err)))
    req.on('timeout', () => {
      req.destroy()
      settle(() => reject(new Error('Request timeout')))
    })
    if (signal) {
      const onAbort = (): void => {
        req.destroy(new Error('request aborted (deadline)'))
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    if (body) req.write(body)
    req.end()
  })
}
