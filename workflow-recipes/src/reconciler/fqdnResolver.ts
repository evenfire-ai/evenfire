import { resolve4, resolve6 } from 'node:dns/promises'
import type { SandboxUiExternalEgress } from '../types'

const BLOCKED_EGRESS_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.31.196.0/24',
  '192.52.193.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '192.175.48.0/24',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
]

function ipv4ToNumber(ip: string): number | undefined {
  const parts = ip.split('.')
  if (parts.length !== 4) return undefined
  let value = 0
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return undefined
    const octet = Number(part)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined
    value = (value << 8) + octet
  }
  return value >>> 0
}

function cidrRange(cidr: string): { start: number; end: number } | undefined {
  const [ip, prefixText] = cidr.split('/')
  if (!ip || prefixText === undefined) return undefined
  const prefix = Number(prefixText)
  const ipNumber = ipv4ToNumber(ip)
  if (ipNumber === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return undefined
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  const start = (ipNumber & mask) >>> 0
  const size = 2 ** (32 - prefix)
  return { start, end: (start + size - 1) >>> 0 }
}

function cidrOverlaps(left: string, right: string): boolean {
  const a = cidrRange(left)
  const b = cidrRange(right)
  if (!a || !b) return false
  return a.start <= b.end && b.start <= a.end
}

function isBlockedExternalIPv4(ip: string): boolean {
  if (ipv4ToNumber(ip) === undefined) return true
  return BLOCKED_EGRESS_CIDRS.some(blocked => cidrOverlaps(`${ip}/32`, blocked))
}

/**
 * A single ipBlock entry the WRC will write into a NetworkPolicy egress
 * rule. Always derived from an FQDN — static CIDR authoring is rejected
 * at CRD admission.
 */
export interface ResolvedExternalEgress {
  cidr: string
  port: number
  reason?: string
  source: { kind: 'fqdn'; fqdn: string }
}

export type FqdnLookupResult =
  | { kind: 'ok'; ipv4: string[]; ipv6: string[] }
  // `retryable` distinguishes a transient resolver failure (SERVFAIL, timeout,
  // unreachable upstream) — worth retrying on a later reconcile — from a
  // permanent one (the name genuinely has no A/AAAA records). Absent ⇒ permanent.
  | { kind: 'error'; error: string; retryable?: boolean }

export type FqdnLookup = (host: string) => Promise<FqdnLookupResult>

/**
 * c-ares / system error codes that mean the resolver or its upstream was
 * unavailable at query time, NOT that the name has no records. A reconcile that
 * hits one of these should be retried rather than bricking the recipe — these
 * map to `retryable: true`. Stable DNS answers (ENODATA, ENOTFOUND/NXDOMAIN, an
 * empty answer) fail closed permanently.
 */
const TRANSIENT_DNS_CODES = new Set([
  'EAI_AGAIN', // system resolver temporary failure
  'ESERVFAIL', // upstream returned SERVFAIL
  'EFORMERR', // upstream/protocol format error for this query
  'ENOTIMP', // upstream does not implement the query
  'EREFUSED', // query refused (upstream policy / overload)
  'ETIMEOUT', // c-ares query timeout
  'ETIMEDOUT', // system-level timeout
  'ECONNREFUSED', // nameserver unreachable
  'ECONNRESET',
  'ENETUNREACH',
  'ECANCELLED', // query cancelled (e.g. resolver shutting down)
  'EBADRESP', // malformed reply from upstream
  'EOF', // resolver connection closed
  'EFILE', // resolver config/file problem
  'ENOMEM', // resolver allocation failure
  'EDESTRUCTION', // channel destroyed while query was pending
  'ENOTINITIALIZED',
  'ELOADIPHLPAPI',
  'EADDRGETNETWORKPARAMS',
])

/**
 * Default FQDN lookup using node:dns/promises. Returns ipv4 and ipv6 record
 * sets independently; a missing record type for one family is fine as long as
 * the other resolves, so `api.example.com` (A only) and `ipv6-only.example.com`
 * both resolve cleanly.
 *
 * When neither family yields a record, the lookup inspects the underlying DNS
 * error code to decide whether the empty answer is permanent (no records) or a
 * transient resolver failure (SERVFAIL/timeout/unreachable upstream). The latter
 * is reported with `retryable: true` and the real code in the message, so the
 * reconciler can retry instead of collapsing every failure into the misleading
 * "no A or AAAA records".
 */
export const defaultFqdnLookup: FqdnLookup = async host => {
  const settle = (p: Promise<string[]>) =>
    p.then(
      addrs => ({ addrs }) as { addrs: string[] },
      (err: NodeJS.ErrnoException) => ({ err }) as { err: NodeJS.ErrnoException }
    )

  const [v4, v6] = await Promise.all([settle(resolve4(host)), settle(resolve6(host))])

  const ipv4 = 'addrs' in v4 ? v4.addrs : []
  const ipv6 = 'addrs' in v6 ? v6.addrs : []
  if (ipv4.length > 0 || ipv6.length > 0) {
    return { kind: 'ok', ipv4, ipv6 }
  }

  const codes = ['err' in v4 ? v4.err.code : undefined, 'err' in v6 ? v6.err.code : undefined]
  const transientCode = codes.find(code => code !== undefined && TRANSIENT_DNS_CODES.has(code))
  if (transientCode) {
    return {
      kind: 'error',
      error: `DNS resolution for "${host}" failed (${transientCode}) — resolver or upstream unavailable`,
      retryable: true,
    }
  }
  return { kind: 'error', error: 'no A or AAAA records' }
}

export interface ResolveResult {
  resolved: ResolvedExternalEgress[]
  // `retryable` is true only when EVERY error for that fqdn was a transient
  // resolver failure. A blocked-address rejection is never retryable — it fails
  // closed permanently.
  failures: Array<{ fqdn: string; error: string; retryable: boolean }>
}

/**
 * Resolve a list of `ui.egress.external[]` entries into a flat list of
 * `cidr:port` ipBlock entries with provenance. Each FQDN expands to one
 * /32 per A record.
 *
 * AAAA records are intentionally dropped: all current Clerum deployment
 * targets are IPv4-only clusters (stackType: IPV4), so emitting /128
 * ipBlocks would produce inert NetworkPolicy rules that grow the policy
 * and obscure intent. When dual-stack lands as a deployment target, gate
 * AAAA emission on a detected stack signal rather than enabling it
 * unconditionally — inert rules are worse than no rules for review.
 *
 * Failed or blocked FQDN lookups are surfaced in `failures`; callers must not
 * apply a stale or partial NetworkPolicy off the back of one. Each failure
 * carries a `retryable` flag: transient resolver failures (SERVFAIL/timeout)
 * are retryable, while a genuine no-records answer or a blocked-address
 * rejection fails closed permanently. If any A record for a hostname resolves
 * to a blocked range, the entire hostname fails closed and no public siblings
 * are emitted.
 */
export async function resolveExternalEgress(
  externals: SandboxUiExternalEgress[],
  lookup: FqdnLookup = defaultFqdnLookup
): Promise<ResolveResult> {
  const resolved: ResolvedExternalEgress[] = []
  const failures: Array<{ fqdn: string; error: string; retryable: boolean }> = []

  for (const entry of externals) {
    const result = await lookup(entry.fqdn)
    if (result.kind === 'error') {
      failures.push({
        fqdn: entry.fqdn,
        error: result.error,
        retryable: result.retryable ?? false,
      })
      continue
    }
    const blocked = result.ipv4.filter(isBlockedExternalIPv4)
    if (blocked.length > 0) {
      failures.push({
        fqdn: entry.fqdn,
        error: `resolved to blocked IPv4 address(es): ${blocked.join(', ')}`,
        retryable: false,
      })
      continue
    }
    for (const ip of result.ipv4) {
      resolved.push({
        cidr: `${ip}/32`,
        port: entry.port,
        reason: entry.reason,
        source: { kind: 'fqdn', fqdn: entry.fqdn },
      })
    }
  }

  return { resolved, failures }
}
