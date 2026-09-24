import type { RecordWithTtl } from 'node:dns'
import { resolve4 } from 'node:dns/promises'
import { classifyDnsRejection } from '@clerum/network-policy-core'
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

export function isBlockedExternalIPv4(ip: string): boolean {
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
  /**
   * TTL (seconds) of the FQDN this /32 was resolved from — the MINIMUM TTL
   * across the FQDN's A records, i.e. the refresh window for the whole name
   * (issue #299). The sliding-window accumulator uses this to compute each
   * entry's expiry = now + ttl + overlap. All /32s of one FQDN share it.
   */
  ttlSeconds: number
}

export type FqdnLookupResult =
  // `ttlSeconds` is the MINIMUM TTL (seconds) across the resolved A records —
  // the binding window for the whole FQDN, consumed by the egress accumulator
  // (issue #299). `ipv6` remains as an empty compatibility field until the
  // platform has an explicit dual-stack enforcement capability.
  | { kind: 'ok'; ipv4: string[]; ipv6: string[]; ttlSeconds: number }
  // `retryable` distinguishes a transient resolver failure (SERVFAIL, timeout,
  // unreachable upstream) — worth retrying on a later reconcile — from a
  // permanent one (the name has no enforceable A records, or is malformed).
  // Absent ⇒ permanent. A failure that is not a DNS verdict at all never becomes
  // a result: the lookup throws (issue #513).
  | { kind: 'error'; error: string; retryable?: boolean }

export type FqdnLookup = (host: string) => Promise<FqdnLookupResult>

/**
 * Transient-vs-permanent DNS classification is centralized in
 * `@clerum/network-policy-core` (`classifyDnsRejection`) so WRC and HCC agree on
 * a total resolver-boundary verdict. Unknown/missing values remain faults;
 * c-ares/system outage codes map to `retryable: true`; stable negative answers
 * fail closed permanently.
 */

/**
 * Rejection payloads are unknown by construction. Keep diagnostics total so an
 * unusual promise rejection cannot replace the controller fault it is reporting.
 */
function describeRejection(err: unknown): string {
  try {
    if (
      typeof err === 'object' &&
      err !== null &&
      typeof (err as { message?: unknown }).message === 'string'
    ) {
      return (err as { message: string }).message
    }
    return String(err)
  } catch {
    // A hostile Proxy/toString must not hide the original fault classification.
    return 'unprintable rejection value'
  }
}

/**
 * Default FQDN lookup using node:dns/promises. The current NetworkPolicy
 * dataplane emits only IPv4 /32 entries, so A is the sole enforceable family.
 * Querying AAAA and treating it as success would let an A failure erase/fail to
 * freeze the actual IPv4 window. Dual-stack must arrive as an explicit future
 * capability rather than an inert resolver side channel.
 *
 * Only the catch around resolve4 classifies a rejection. Downstream validation
 * faults occur outside that boundary and therefore cannot be laundered by a
 * DNS-looking `.code`.
 */
export const defaultFqdnLookup: FqdnLookup = async host => {
  let records: RecordWithTtl[]
  try {
    records = await resolve4(host, { ttl: true })
  } catch (error: unknown) {
    const verdict = classifyDnsRejection(error)
    if (verdict.kind === 'transient') {
      return {
        kind: 'error',
        error: `DNS resolution for "${host}" failed (${verdict.code}) — resolver or upstream unavailable`,
        retryable: true,
      }
    }
    if (verdict.kind === 'negative') {
      if (verdict.reason === 'invalid-name') {
        return {
          kind: 'error',
          error: `malformed hostname "${host}" (${verdict.code}) — the resolver refused to query it`,
        }
      }
      return { kind: 'error', error: 'no A records for IPv4 egress enforcement' }
    }
    throw new Error(
      `DNS lookup for "${host}" failed with a non-DNS error (${verdict.code ?? 'no code'}): ${describeRejection(verdict.cause)}`,
      { cause: verdict.cause }
    )
  }

  // Everything below is downstream of a successful resolver call. Exceptions
  // here are controller/contract faults even if they happen to carry a DNS code.
  const ipv4 = records.map(record => record.address)
  if (ipv4.length === 0) {
    return { kind: 'error', error: 'no A records for IPv4 egress enforcement' }
  }
  const ttlSeconds = Math.min(...records.map(record => record.ttl))
  return { kind: 'ok', ipv4, ipv6: [], ttlSeconds }
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
 * rejection fails closed permanently. If any A record for a hostname resolves to
 * a blocked range, the entire hostname fails closed and no public siblings are
 * emitted.
 *
 * A lookup that cannot produce a DNS verdict at all throws instead of returning
 * a failure, so the reconciler's existing error routing reports the real fault
 * (issue #513).
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
        ttlSeconds: result.ttlSeconds,
      })
    }
  }

  return { resolved, failures }
}
