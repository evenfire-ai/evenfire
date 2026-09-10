'use strict'

// Single source of truth for the non-public/reserved IPv4 CIDR set and the
// LAN-baseURL classifier. The CIDR list below is the SAME data that ships in
// deploy/base/public-egress-exceptions.yaml (spec.ranges) and that the
// NetworkPolicy reconciler excludes from public egress. control-api and HCC
// both import it from here so the three copies cannot drift; a drift-guard test
// pins it against the YAML.

// The 18 non-public/reserved IPv4 ranges, VERBATIM and in the same order as the
// deploy YAML. Any change here must be mirrored to the YAML (and vice versa) —
// the drift-guard fails otherwise.
const NON_PUBLIC_EGRESS_CIDRS = Object.freeze([
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
])

// RFC1918 private LAN ranges — the ONLY ranges a local `openai-compatible`
// broker may target. A subset of NON_PUBLIC_EGRESS_CIDRS.
const PRIVATE_LAN_CIDRS = Object.freeze(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'])

const LINK_LOCAL_CIDR = '169.254.0.0/16'
const CGNAT_CIDR = '100.64.0.0/10'

function ipv4ToInt(ip) {
  const parts = typeof ip === 'string' ? ip.split('.') : []
  if (
    parts.length !== 4 ||
    parts.some(part => {
      if (!/^\d+$/.test(part)) return true
      const parsed = Number(part)
      return !Number.isInteger(parsed) || parsed < 0 || parsed > 255
    })
  ) {
    return null
  }
  return parts.reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0)
}

function parseCidr(cidr) {
  const match = typeof cidr === 'string' ? cidr.match(/^(\d+(?:\.\d+){3})\/(\d{1,2})$/) : null
  if (!match) return null
  const base = ipv4ToInt(match[1])
  const prefix = Number(match[2])
  if (base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  const start = (base & mask) >>> 0
  const size = 2 ** (32 - prefix)
  return { start, end: (start + size - 1) >>> 0, canonical: base === start }
}

function cidrOverlaps(left, right) {
  const a = parseCidr(left)
  const b = parseCidr(right)
  if (!a || !b) return false
  return a.start <= b.end && b.start <= a.end
}

function ipInCidr(ip, cidr) {
  return cidrOverlaps(`${ip}/32`, cidr)
}

/**
 * Classify a candidate `openai-compatible` baseURL for LAN admission.
 * IP-literal-only by design (jury decision): a DNS name — including localhost,
 * *.svc, *.cluster.local, and metadata-by-name — is rejected as `not_ip`, which
 * closes SSRF-by-name and DNS-rebinding for free (the runtime NetworkPolicy /32
 * is the authoritative block). Only RFC1918 IPv4 literals are accepted.
 */
function classifyLanBaseURL(baseURL, options) {
  let url
  try {
    url = new URL(baseURL)
  } catch {
    return { ok: false, reason: 'invalid_url' }
  }
  const hostname = url.hostname
  if (!hostname) return { ok: false, reason: 'invalid_url' }

  // Step 2: IPv4-literal-only. The WHATWG URL parser canonicalizes IPv4
  // shorthand (decimal/hex/short forms) into dotted-quad in `hostname`, so a
  // non-null ipv4ToInt here means the host is an IPv4 literal. Anything else
  // (DNS name, IPv6, garbage) is `not_ip`.
  if (ipv4ToInt(hostname) === null) return { ok: false, reason: 'not_ip' }
  const ip = hostname

  if (ipInCidr(ip, LINK_LOCAL_CIDR)) return { ok: false, reason: 'link_local' }
  if (ipInCidr(ip, CGNAT_CIDR)) return { ok: false, reason: 'cgnat' }

  const clusterInternal = options?.clusterInternalCidrs
  if (Array.isArray(clusterInternal) && clusterInternal.some(cidr => ipInCidr(ip, cidr))) {
    return { ok: false, reason: 'cluster_internal' }
  }

  if (!PRIVATE_LAN_CIDRS.some(cidr => ipInCidr(ip, cidr))) {
    return { ok: false, reason: 'not_private_lan' }
  }

  // Belt-and-suspenders: an IP that is inside RFC1918 (passed the check above)
  // yet also overlaps a NON-RFC1918 reserved range in the single-source list.
  // Reuses the source-of-truth CIDR set rather than a second reserved list.
  const rfc1918 = new Set(PRIVATE_LAN_CIDRS)
  if (NON_PUBLIC_EGRESS_CIDRS.some(cidr => !rfc1918.has(cidr) && ipInCidr(ip, cidr))) {
    return { ok: false, reason: 'reserved' }
  }

  return { ok: true, ip }
}

module.exports = {
  NON_PUBLIC_EGRESS_CIDRS,
  PRIVATE_LAN_CIDRS,
  ipv4ToInt,
  parseCidr,
  cidrOverlaps,
  classifyLanBaseURL,
}
