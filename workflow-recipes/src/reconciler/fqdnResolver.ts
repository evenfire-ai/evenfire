import type { RecordWithTtl } from 'node:dns'
import { resolve4, resolve6 } from 'node:dns/promises'
import { classifyDnsError } from '@clerum/network-policy-core'
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
  // (issue #299). It is 0 when only AAAA resolved (A-less), since no /32 is
  // emitted for an IPv4-only enforcement target in that case.
  | { kind: 'ok'; ipv4: string[]; ipv6: string[]; ttlSeconds: number }
  // `retryable` distinguishes a transient resolver failure (SERVFAIL, timeout,
  // unreachable upstream) — worth retrying on a later reconcile — from a
  // permanent one (the name genuinely has no A/AAAA records). Absent ⇒ permanent.
  | { kind: 'error'; error: string; retryable?: boolean }

export type FqdnLookup = (host: string) => Promise<FqdnLookupResult>

/**
 * Transient-vs-permanent DNS classification is centralized in
 * `@clerum/network-policy-core` (`classifyDnsError`) so WRC and HCC agree on what
 * a transient failure is — a single source of truth avoids drift between the two
 * controllers' fail-static behavior (issue #299 audit F6). c-ares / system codes
 * meaning "resolver/upstream temporarily unavailable" map to `retryable: true`;
 * stable answers (ENODATA, ENOTFOUND/NXDOMAIN, empty) fail closed permanently.
 */

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
  // A records are requested WITH per-record TTLs (`{ ttl: true }`) so the
  // accumulator can size the sliding window off the real DNS TTL (issue #299).
  // AAAA is resolved without TTLs: /128 blocks are dropped (IPv4-only targets),
  // so their TTL would be inert.
  const settleV4 = (p: Promise<RecordWithTtl[]>) =>
    p.then(
      records => ({ records }) as { records: RecordWithTtl[] },
      (err: NodeJS.ErrnoException) => ({ err }) as { err: NodeJS.ErrnoException }
    )
  const settleV6 = (p: Promise<string[]>) =>
    p.then(
      addrs => ({ addrs }) as { addrs: string[] },
      (err: NodeJS.ErrnoException) => ({ err }) as { err: NodeJS.ErrnoException }
    )

  const [v4, v6] = await Promise.all([
    settleV4(resolve4(host, { ttl: true })),
    settleV6(resolve6(host)),
  ])

  // H1 (issue #299): a TRANSIENT A-query failure must FREEZE the IPv4 window,
  // even when AAAA answered. IPv4 is the only rendered family, so a successful
  // AAAA must not mask a transient A outage into an ok-empty "name drained"
  // answer — that would age the /32 sliding window out (silent IPv4 egress loss)
  // instead of freezing it. A PERMANENT A failure with AAAA present is a genuine
  // AAAA-only host and stays ok below; the dropped v6 records are inert anyway
  // (IPv4-only render).
  if ('err' in v4 && classifyDnsError(v4.err.code) === 'transient') {
    return {
      kind: 'error',
      error: `DNS A-query for "${host}" failed (${v4.err.code}) — resolver or upstream unavailable`,
      retryable: true,
    }
  }
  const v4Records = 'records' in v4 ? v4.records : []
  const ipv4 = v4Records.map(r => r.address)
  const ipv6 = 'addrs' in v6 ? v6.addrs : []
  if (ipv4.length > 0 || ipv6.length > 0) {
    // Minimum TTL across the A records = the window for the whole FQDN. 0 when
    // A-less (AAAA-only), where no /32 is emitted anyway.
    const ttlSeconds = v4Records.length > 0 ? Math.min(...v4Records.map(r => r.ttl)) : 0
    return { kind: 'ok', ipv4, ipv6, ttlSeconds }
  }

  const codes = ['err' in v4 ? v4.err.code : undefined, 'err' in v6 ? v6.err.code : undefined]
  const transientCode = codes.find(
    code => code !== undefined && classifyDnsError(code) === 'transient'
  )
  if (transientCode) {
    return {
      kind: 'error',
      error: `DNS resolution for "${host}" failed (${transientCode}) — resolver or upstream unavailable`,
      retryable: true,
    }
  }
  return { kind: 'error', error: 'no A or AAAA records' }
}

// issue #299 Phase 2 — the seam rule (docs/architecture/issue-299-phase2-dns-failure-seam.md).
// A structured discriminator so the reconciler can tell a BLOCKED answer (private/
// blocked-CIDR — active-poisoning signal, must fail loud) from an ABSENT answer
// (NXDOMAIN/no-records — a provider binding may still render its DNS-independent
// catalog) WITHOUT string-matching the error message. The value is set at the two
// structurally-distinct classification sites below (blocked = successful resolution
// + isBlockedExternalIPv4; absent/transient = resolver error + classifyDnsError), so
// it is trustworthy by construction and can never be produced by parsing text.
export type EgressFailureKind = 'transient' | 'absent' | 'blocked'

export interface EgressResolutionFailure {
  fqdn: string
  error: string
  // `retryable` is true only when the error was a transient resolver failure. A
  // blocked-address rejection or a no-records answer is never retryable — it fails
  // closed permanently. Retained for existing consumers; `failureKind` is the
  // authoritative discriminator.
  retryable: boolean
  failureKind: EgressFailureKind
}

export interface ResolveResult {
  resolved: ResolvedExternalEgress[]
  failures: EgressResolutionFailure[]
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
  const failures: EgressResolutionFailure[] = []

  for (const entry of externals) {
    const result = await lookup(entry.fqdn)
    if (result.kind === 'error') {
      // Resolver error branch: a transient failure is retryable; a permanent
      // no-records/NXDOMAIN answer is ABSENT (not blocked). classifyDnsError
      // already made this call upstream and encoded it in `retryable`.
      const retryable = result.retryable ?? false
      failures.push({
        fqdn: entry.fqdn,
        error: result.error,
        retryable,
        failureKind: retryable ? 'transient' : 'absent',
      })
      continue
    }
    const blocked = result.ipv4.filter(isBlockedExternalIPv4)
    if (blocked.length > 0) {
      // Successful resolution into a blocked/private range — the maximally-
      // suspicious slice (sinkhole/poisoning). Always fails loud; never eligible
      // for the provider-catalog exemption.
      failures.push({
        fqdn: entry.fqdn,
        error: `resolved to blocked IPv4 address(es): ${blocked.join(', ')}`,
        retryable: false,
        failureKind: 'blocked',
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
