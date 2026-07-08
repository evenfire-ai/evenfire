import * as dns from 'dns/promises'
import * as http from 'http'
import * as https from 'https'
import { URL } from 'url'
import { Tool } from '../interfaces'
import { ToolOutput } from '../types'

export class HttpRequestTool implements Tool {
  constructor(private readonly allowlist: string[]) {}

  name() {
    return 'http_request'
  }
  description() {
    return (
      'Make an HTTP/HTTPS request to an allowed domain. ' +
      'Supports GET, POST, PUT, DELETE methods. ' +
      'This tool requires approval before execution.'
    )
  }
  parametersSchema() {
    return {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to request' },
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'DELETE'],
          description: 'HTTP method (default: GET)',
        },
        headers: {
          type: 'object',
          description: 'Request headers as key-value pairs',
        },
        body: {
          type: 'string',
          description: 'Request body (for POST/PUT)',
        },
      },
      required: ['url'],
    }
  }
  requiresSanitization() {
    return true
  }
  requiresApproval() {
    return true
  } // HIGH RISK

  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    const startTime = Date.now()
    const urlString = params.url as string
    const method = (params.method as string) || 'GET'
    const headers = (params.headers as Record<string, string>) || {}
    const body = params.body as string | undefined

    // Parse and validate URL
    let url: URL
    try {
      url = new URL(urlString)
    } catch {
      return {
        content: 'Error: Invalid URL',
        duration_ms: Date.now() - startTime,
        is_error: true,
      }
    }

    if (this.allowlist.length > 0) {
      const isAllowed = this.allowlist.some(
        domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)
      )
      if (!isAllowed) {
        return {
          content: `Error: Domain "${url.hostname}" not in allowlist`,
          duration_ms: Date.now() - startTime,
          is_error: true,
        }
      }
    }

    // Resolve BOTH A and AAAA in parallel so attackers cannot hide a private
    // target behind the record type we skip. The first validated address is
    // pinned into makeRequest to close the DNS-rebinding window between
    // validation and connect; the Host header (and SNI) keeps the original
    // hostname intact.
    let resolvedIp: string | undefined
    try {
      const [v4, v6] = await Promise.allSettled([
        dns.resolve4(url.hostname),
        dns.resolve6(url.hostname),
      ])
      const addresses: string[] = []
      if (v4.status === 'fulfilled') addresses.push(...v4.value)
      if (v6.status === 'fulfilled') addresses.push(...v6.value)

      if (addresses.length === 0) {
        throw new Error('no addresses resolved')
      }

      for (const addr of addresses) {
        if (isPrivateIp(addr)) {
          return {
            content: `Error: Domain resolves to private IP (${addr})`,
            duration_ms: Date.now() - startTime,
            is_error: true,
          }
        }
      }
      resolvedIp = addresses[0]
    } catch {
      // DNS resolution failed. If an allowlist is configured, we must block
      // the request since we can't verify the IP is safe (SSRF protection).
      if (this.allowlist.length > 0) {
        return {
          content: `Error: DNS resolution failed for "${url.hostname}". Cannot verify IP safety.`,
          duration_ms: Date.now() - startTime,
          is_error: true,
        }
      }
      // No allowlist — all domains allowed, let HTTP request proceed/fail naturally
    }

    try {
      const response = await this.makeRequest(url, method, headers, body, resolvedIp)
      return {
        content: `HTTP ${response.statusCode}\n\n${response.body}`,
        duration_ms: Date.now() - startTime,
        is_error: response.statusCode >= 400,
      }
    } catch (err) {
      return {
        content: `HTTP request failed: ${(err as Error).message}`,
        duration_ms: Date.now() - startTime,
        is_error: true,
      }
    }
  }

  private makeRequest(
    url: URL,
    method: string,
    headers: Record<string, string>,
    body?: string,
    pinnedIp?: string
  ): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
      const isHttps = url.protocol === 'https:'
      const client = isHttps ? https : http
      const defaultPort = isHttps ? 443 : 80
      const connectHost = pinnedIp ?? url.hostname
      // IPv6 literals must be bracketed in a Host header but NOT in the
      // hostname/servername fields themselves.
      const hostHeaderValue = url.port ? `${url.hostname}:${url.port}` : url.hostname
      const mergedHeaders: Record<string, string> = {
        ...headers,
        host: hostHeaderValue,
      }
      const requestOptions: https.RequestOptions = {
        method,
        headers: mergedHeaders,
        timeout: 30000,
        hostname: connectHost,
        port: url.port ? Number(url.port) : defaultPort,
        path: `${url.pathname}${url.search}`,
        // SNI — required so TLS handshake still uses the real hostname
        // even when we connect to a pinned IP literal.
        servername: url.hostname,
      }
      const req = client.request(requestOptions, res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf-8')
          // Truncate large responses
          const truncated =
            responseBody.length > 50000
              ? responseBody.substring(0, 50000) + '\n...[truncated]'
              : responseBody
          resolve({ statusCode: res.statusCode!, body: truncated })
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
}

/**
 * Block private and metadata IP ranges (SSRF defense).
 *
 * IPv4 ranges:
 *   10.0.0.0/8         RFC 1918 private
 *   127.0.0.0/8        Loopback
 *   172.16.0.0/12      RFC 1918 private
 *   192.168.0.0/16     RFC 1918 private
 *   169.254.0.0/16     Link-local (cloud metadata, e.g. 169.254.169.254)
 *   0.0.0.0/8          "This network"
 *
 * IPv6 ranges:
 *   ::/128             Unspecified
 *   ::1/128            Loopback
 *   fc00::/7           Unique local (fc00::/8 + fd00::/8)
 *   fe80::/10          Link-local
 *   ::ffff:0:0/96      IPv4-mapped (delegate to IPv4 check)
 *   fec0::/10          Site-local (deprecated, still blocked)
 *   2001:db8::/32      Documentation
 *
 * The previous implementation had several bypasses:
 *   - `0:0:0:0:0:0:0:1` (long-form ::1) skipped the `::1` equality check
 *   - `::ffff:7f00:1` (IPv4-mapped in hex) skipped the dotted-quad prefix match
 *   - `[::1]` brackets from URL hostnames were never stripped
 *   - `fe80::1%eth0` zone identifiers broke startsWith matching
 *   - 172.16/12 IPv4-mapped was only matched by prefix `172.` (too broad)
 *
 * Current implementation normalizes IPv6 to 16 raw bytes and tests CIDR
 * membership bit-for-bit, matching the same ranges that BlockList would
 * resolve.
 */

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
    // `:: ` (all-zero) and `::1` were already matched by the unspecified
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
