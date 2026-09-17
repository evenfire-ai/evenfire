import { isIP } from 'node:net'
import { parseCidr } from '@clerum/egress-policy'

/**
 * Loosest plausibly-legitimate prefix for a K8s-API-server allowlist.
 * An allowlist for the API server has no business being broad — /32 is
 * expected; /24 is the loosest we tolerate. Anything wider (incl. 0.0.0.0/0)
 * is rejected.
 */
const MIN_IPV4_PREFIX = 24
const MIN_IPV6_PREFIX = 120

function parseCidrEntry(envName: string, entry: string): { family: 4 | 6; prefix: number } {
  const slash = entry.indexOf('/')
  if (slash === -1) {
    throw new Error(`${envName}: missing prefix in "${entry}"`)
  }
  const addr = entry.slice(0, slash)
  const prefixStr = entry.slice(slash + 1)
  const family = isIP(addr)
  if (family !== 4 && family !== 6) {
    throw new Error(`${envName}: invalid IP in "${entry}"`)
  }
  if (!/^[0-9]+$/.test(prefixStr)) {
    throw new Error(`${envName}: invalid prefix in "${entry}"`)
  }
  const prefix = Number(prefixStr)
  const maxPrefix = family === 4 ? 32 : 128
  if (prefix > maxPrefix) {
    throw new Error(`${envName}: prefix out of range in "${entry}"`)
  }
  return { family, prefix }
}

/**
 * Parse + validate the CONTEXT_MAPPER_K8S_API_CIDRS env value.
 *
 * Returns the validated CIDR list, or [] when the input is unset/empty
 * (the caller then falls back to KUBERNETES_SERVICE_HOST). Throws on any
 * malformed or over-broad entry — callers MUST NOT catch-and-fallback, so a
 * bad value fails the process closed rather than programming a permissive
 * NetworkPolicy.
 */
export function parseK8sApiCidrs(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') {
    return []
  }
  const entries = raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
  if (entries.length === 0) {
    return []
  }
  for (const entry of entries) {
    const { family, prefix } = parseCidrEntry('CONTEXT_MAPPER_K8S_API_CIDRS', entry)
    const minPrefix = family === 4 ? MIN_IPV4_PREFIX : MIN_IPV6_PREFIX
    if (prefix < minPrefix) {
      throw new Error(
        `CONTEXT_MAPPER_K8S_API_CIDRS: over-broad CIDR "${entry}" ` +
          `(prefix must be >= /${minPrefix})`
      )
    }
  }
  return entries
}

/**
 * Parse + validate the CONTEXT_MAPPER_NODELOCAL_DNS_CIDR env value.
 *
 * Empty means the reconciler keeps only the kube-system selector. When set,
 * this must be exactly one IPv4 /32 because GKE's NodeLocal DNSCache guidance
 * requires KUBE_DNS_SVC_CLUSTER_IP/32. Broader ranges fail closed instead of
 * programming unnecessary DNS egress.
 */
export function parseNodeLocalDnsCidr(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') {
    return ''
  }
  const entries = raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
  if (entries.length !== 1) {
    throw new Error('CONTEXT_MAPPER_NODELOCAL_DNS_CIDR: expected exactly one CIDR')
  }
  const entry = entries[0]
  const { family, prefix } = parseCidrEntry('CONTEXT_MAPPER_NODELOCAL_DNS_CIDR', entry)
  if (family !== 4) {
    throw new Error(`CONTEXT_MAPPER_NODELOCAL_DNS_CIDR: expected IPv4 CIDR in "${entry}"`)
  }
  if (prefix !== 32) {
    throw new Error(`CONTEXT_MAPPER_NODELOCAL_DNS_CIDR: expected /32 CIDR in "${entry}"`)
  }
  return entry
}

function intToIpv4(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.')
}

/**
 * Parse + validate a comma-separated cluster-internal CIDR env value
 * (CONTEXT_MAPPER_CLUSTER_INTERNAL_CIDRS, CONTEXT_MAPPER_CLUSTER_NODE_CIDRS).
 *
 * Returns the validated list, or [] when unset/empty. THROWS on any malformed
 * entry so a bad value fails the process closed at startup — callers MUST NOT
 * catch-and-fallback. A malformed CIDR that slipped through would leave the LAN
 * guard OPEN for that entry: the classifier's cidrOverlaps treats an unparseable
 * CIDR as "no overlap" (= not denied), while the entry still counts toward
 * `guardConfigured`, so the fail-closed gate believes the guard is set.
 *
 * Rules: IPv4 dotted-quad `/n` with 1 <= n <= 32 (/0 is rejected as over-broad);
 * the address must be the CANONICAL network address for the prefix (10.96.0.5/12
 * is rejected with the intended 10.96.0.0/12); IPv6 is rejected explicitly
 * because the LAN classifier is IPv4-only — an IPv6 entry would be silently inert.
 */
export function parseClusterCidrList(envName: string, raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') {
    return []
  }
  const entries = raw
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
  if (entries.length === 0) {
    return []
  }
  for (const entry of entries) {
    const slash = entry.indexOf('/')
    if (slash === -1) {
      throw new Error(`${envName}: missing prefix in "${entry}"`)
    }
    const addr = entry.slice(0, slash)
    if (isIP(addr) === 6) {
      throw new Error(
        `${envName}: IPv6 CIDR "${entry}" is not supported ` +
          `(the LAN classifier is IPv4-only; an IPv6 entry would be silently inert)`
      )
    }
    const parsed = parseCidr(entry)
    if (parsed === null) {
      throw new Error(`${envName}: invalid IPv4 CIDR "${entry}"`)
    }
    const prefix = Number(entry.slice(slash + 1))
    if (prefix < 1) {
      throw new Error(`${envName}: over-broad CIDR "${entry}" (prefix must be >= /1)`)
    }
    if (!parsed.canonical) {
      throw new Error(
        `${envName}: non-canonical CIDR "${entry}" ` +
          `(did you mean ${intToIpv4(parsed.start)}/${prefix}?)`
      )
    }
  }
  return entries
}
