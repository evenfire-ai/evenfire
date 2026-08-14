'use strict'

/**
 * @clerum/network-policy-core — see index.d.ts for the contract and the
 * H1–H5 guarantees. Pure module: no Kubernetes, no DNS, injectable clock.
 */

const STATE_ANNOTATION = 'clerum.io/egress-fqdn-state'
const TARGETS_ANNOTATION = 'clerum.io/egress-fqdn-targets'
const RESOLVED_AT_ANNOTATION = 'clerum.io/egress-fqdn-resolved-at'

const DEFAULT_PROTOCOL = 'TCP'
const LEGACY_PORT = 443
// Upper bound on a DNS TTL (ms) folded into the window (audit M2). A hostile or
// misconfigured authoritative server could otherwise return a TTL of years,
// pinning an allowlist entry to a public IP long after the DNS stops serving it
// (cloud IP reassignment). 24h caps the persistence; F1 revocation + eviction
// still bound it, and this only feeds the min-TTL ratchet downward.
const MAX_TTL_MS = 24 * 60 * 60 * 1000

// Byte budget for the serialized egress annotations (audit M-C prong 2 + R1-M1).
// A Kubernetes annotation set is capped at 256KB TOTAL, and serializeState emits
// BOTH `egress-fqdn-state` (JSON) and `egress-fqdn-targets` (fqdn=ip/32 pairs)
// from the same entries — so the eviction charges each entry BOTH contributions
// against this single combined budget (R1-M1: a STATE-only budget let the two
// annotations sum past 256KB for long FQDNs and 422 the policy). 230KB leaves
// ~32KB headroom under 262144 for the annotation keys, resolved-at, and labels.
// A fixed entry COUNT cap cannot bound bytes — a 253-char FQDN serializes ~5× a
// short one — and an oversized annotation is rejected by the apiserver with a
// 422, looping the reconcile forever.
const MAX_ANNOTATION_BYTES = 230 * 1000

/**
 * DNS error codes that mean "the resolver/upstream is temporarily unavailable",
 * NOT "the name has no records". A failure with one of these is TRANSIENT and
 * must trigger fail-static freezing (H1); anything else is PERMANENT. This set is
 * the platform-wide source of truth, mirrored from the WRC resolver so both
 * controllers agree on what a transient failure is (issue #299).
 */
const TRANSIENT_DNS_CODES = new Set([
  'EAI_AGAIN',
  'ESERVFAIL',
  'EFORMERR',
  'ENOTIMP',
  'EREFUSED',
  'ETIMEOUT',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'ECANCELLED',
  'EBADRESP',
  'EOF',
  'EFILE',
  'ENOMEM',
  'EDESTRUCTION',
  'ENOTINITIALIZED',
  'ELOADIPHLPAPI',
  'EADDRGETNETWORKPARAMS',
])

/**
 * Classify a DNS failure as 'transient' or 'permanent'. Accepts a raw code
 * string or an Error carrying `.code`. Unknown/missing codes default to
 * 'permanent' (matches the WRC resolver): only a recognized transient code
 * freezes the accumulated set.
 */
function classifyDnsError(errOrCode) {
  const code =
    typeof errOrCode === 'string'
      ? errOrCode
      : errOrCode && typeof errOrCode === 'object'
        ? errOrCode.code
        : undefined
  return typeof code === 'string' && TRANSIENT_DNS_CODES.has(code) ? 'transient' : 'permanent'
}

function emptyState() {
  return { entries: [] }
}

/**
 * Syntactic IPv4 check (four 0-255 octets). Used to harden rehydration (audit
 * F3): a corrupted/tampered annotation must never rehydrate a malformed ip that
 * would render as "<junk>/32" and get the whole policy rejected (apiserver 422)
 * in a reconcile-error loop. Pure, no node:net dependency.
 */
function isValidIpv4(ip) {
  if (typeof ip !== 'string') return false
  const parts = ip.split('.')
  if (parts.length !== 4) return false
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false
    const octet = Number(part)
    if (octet < 0 || octet > 255) return false
  }
  return true
}

function keyOf(e) {
  return `${e.fqdn}\u0000${e.ip}\u0000${e.port}\u0000${e.protocol}`
}

function byKey(a, b) {
  const ka = keyOf(a)
  const kb = keyOf(b)
  return ka < kb ? -1 : ka > kb ? 1 : 0
}

/**
 * The DECLARED identity of a target — (fqdn,port,protocol) — WITHOUT the resolved
 * ip. Revocation/freeze classification keys on this (H-A) so that removing one
 * declared port of a multi-port fqdn (api.example.com:443 → :8443) revokes only
 * the removed port's entries, instead of letting them ride the still-declared
 * fqdn's `ok`/transient branch until their old TTL+overlap lapses.
 */
function idOf(fqdn, port, protocol) {
  return `${fqdn}\u0000${port}\u0000${protocol || DEFAULT_PROTOCOL}`
}

/**
 * Stable change hash over (fqdn,ip,port,protocol) ONLY — never expiresAt or
 * lastObservedAt (H4): a refresh that merely renews timestamps must be a no-op.
 */
function stateHash(entries) {
  return entries
    .map(e => `${e.fqdn}|${e.ip}|${e.port}|${e.protocol}`)
    .sort()
    .join(',')
}

/** The persisted view of one entry — the exact object serialized into the state
 * annotation. Shared by serializeState and the byte-aware eviction so both agree
 * on the on-wire size. */
function stateEntryView(e) {
  return {
    ip: e.ip,
    port: e.port,
    protocol: e.protocol,
    fqdn: e.fqdn,
    expiresAt: e.expiresAt,
    lastObservedAt: e.lastObservedAt == null ? 0 : e.lastObservedAt,
  }
}

function reconcileEgressState(previous, observations, now, config) {
  const overlapMs = config.overlapMs
  const maxEntries = config.maxEntries

  const map = new Map()
  for (const e of previous.entries) map.set(keyOf(e), { ...e })

  // Classify by the full DECLARED identity (fqdn,port,protocol), not fqdn alone
  // (H-A). An observation is emitted per declared (fqdn,port); a target whose
  // declared port was removed produces no observation for the old identity, so
  // its retained entries fall through to revocation below instead of surviving
  // under the still-declared fqdn.
  const okIds = new Set()
  const permanentIds = new Set()
  const transientIds = new Set()
  for (const o of observations) {
    const id = idOf(o.fqdn, o.port, o.protocol)
    if (o.kind === 'ok') okIds.add(id)
    else if (o.kind === 'permanent') permanentIds.add(id)
    else if (o.kind === 'transient') transientIds.add(id)
  }

  // Apply OK observations: add or RENEW (sliding window). Renewing updates both
  // expiresAt (window) and lastObservedAt (eviction LRU).
  for (const o of observations) {
    if (o.kind !== 'ok') continue
    const protocol = o.protocol || DEFAULT_PROTOCOL
    // Clamp the TTL (audit M2) so a hostile/misconfigured server cannot pin an
    // entry for years.
    const ttlMs = o.ttlMs > MAX_TTL_MS ? MAX_TTL_MS : o.ttlMs
    const expiresAt = now + ttlMs + overlapMs
    for (const ip of o.ips) {
      if (!ip) continue
      const entry = { ip, port: o.port, protocol, fqdn: o.fqdn, expiresAt, lastObservedAt: now }
      map.set(keyOf(entry), entry)
    }
  }

  // Expiry — H1 fail-static + F1 revocation (issue #299 audit).
  //  - Declared & resolved (ok) OR genuine no-records (permanent): normal expiry.
  //  - Declared but DNS transiently failing (explicit transient observation):
  //    FREEZE — never prune while the resolver is failing.
  //  - No observation for that (fqdn,port,protocol) identity this round: the
  //    target is no longer DECLARED on that port (removed from the spec, or its
  //    port changed) → REVOKE immediately. Freezing an undeclared identity would
  //    keep a removed host/port's egress forever — a regression worse than the
  //    original single-snapshot behavior. Only an explicit transient failure of
  //    the SAME identity freezes; absence of an observation means removal.
  const frozen = new Set()
  for (const [k, e] of map) {
    const id = idOf(e.fqdn, e.port, e.protocol)
    if (okIds.has(id) || permanentIds.has(id)) {
      if (e.expiresAt <= now) map.delete(k)
    } else if (transientIds.has(id)) {
      frozen.add(e.fqdn)
    } else {
      map.delete(k)
    }
  }

  // Eviction — H3. On overflow, remove the least-recently-OBSERVED first
  // (tiebreak by soonest expiry, then key, for determinism). Never reject/truncate
  // below the cap; the newly observed entries have the largest lastObservedAt so
  // they are never evicted.
  let entries = Array.from(map.values())
  const evicted = []
  let overCap = false
  if (entries.length > maxEntries) {
    overCap = true
    entries.sort(
      (a, b) => a.lastObservedAt - b.lastObservedAt || a.expiresAt - b.expiresAt || byKey(a, b)
    )
    const removeCount = entries.length - maxEntries
    for (let i = 0; i < removeCount; i++) evicted.push(entries[i])
    entries = entries.slice(removeCount)
  }

  // Byte-aware eviction (audit M-C prong 2 + R1-M1). Independent of the count
  // cap: keep the most-recently-observed entries until the COMBINED serialized
  // annotations (STATE json + TARGETS `fqdn=ip/32` pairs, both from these
  // entries) reach MAX_ANNOTATION_BYTES, then evict the rest. Bounds the on-wire
  // annotation size regardless of FQDN length so the apiserver can never 422 on
  // an oversized policy and loop the reconcile. O(n log n); the loop body evicts
  // nothing in the common case (a handful of short-FQDN /32s).
  if (entries.length > 0) {
    // Per-entry contribution to BOTH annotations (R1-M1): the STATE array element
    // and the TARGETS `fqdn=ip/32` fragment. serializeState (below) is the source
    // of truth for both shapes.
    // Charge UTF-8 BYTES, not UTF-16 code units: the apiserver caps total
    // annotation size by Go len() (bytes), and MAX_ANNOTATION_BYTES is a byte
    // budget. A multi-byte FQDN (e.g. 'ü' = 1 code unit, 2 bytes) would make a
    // .length meter under-count and clear a policy the apiserver then 422s.
    const sizeOf = new Map(
      entries.map(e => [
        e,
        Buffer.byteLength(JSON.stringify(stateEntryView(e)), 'utf8') +
          Buffer.byteLength(`${e.fqdn}=${e.ip}/32`, 'utf8'),
      ])
    )
    const byNewest = [...entries].sort(
      (a, b) => b.lastObservedAt - a.lastObservedAt || b.expiresAt - a.expiresAt || byKey(a, b)
    )
    const kept = []
    let bytes = 2 // the STATE array's enclosing "[]" (TARGETS has no brackets)
    for (const e of byNewest) {
      // Each entry after the first adds one comma to STATE and one to TARGETS.
      const add = sizeOf.get(e) + (kept.length > 0 ? 2 : 0)
      if (kept.length > 0 && bytes + add > MAX_ANNOTATION_BYTES) {
        evicted.push(e)
        overCap = true
        continue
      }
      bytes += add
      kept.push(e)
    }
    entries = kept
  }

  entries.sort(byKey)

  // Renewal signal (audit M1). The write gate is over the ip-set only (H4), so a
  // stable set never re-persists its renewed timestamps and the persisted window
  // silently ages. If it lapses before the set next changes, a rotated-away IP is
  // pruned with zero overlap grace. renewalDue tells the caller to write (to
  // re-persist the fresh window) when a SURVIVING entry's PERSISTED expiry is
  // within overlap/2 of now — bounding such writes to ~one per overlap/2 while
  // keeping the persisted window fresh enough to preserve the grace.
  const halfOverlap = overlapMs / 2
  const prevByKey = new Map(previous.entries.map(e => [keyOf(e), e]))
  let renewalDue = false
  for (const e of entries) {
    const prev = prevByKey.get(keyOf(e))
    // Only when a write would actually ADVANCE this entry's persisted expiry
    // (audit R2-2): a FROZEN entry (transient DNS, H1) or a retained rotated-away
    // IP has e.expiresAt === prev.expiresAt — a write cannot extend it, so forcing
    // one every tick would be pure churn during a DNS outage. Renew only entries
    // whose expiry moved forward this round and whose persisted window is aging.
    if (prev && e.expiresAt > prev.expiresAt && prev.expiresAt - now < halfOverlap) {
      renewalDue = true
      break
    }
  }

  return {
    state: { entries },
    entries,
    changed: stateHash(entries) !== stateHash(previous.entries),
    renewalDue,
    evicted,
    overCap,
    frozenFqdns: Array.from(frozen).sort(),
  }
}

function serializeState(state) {
  const sorted = [...state.entries].sort(byKey)
  const stateJson = JSON.stringify(sorted.map(stateEntryView))
  const targets = sorted.map(e => `${e.fqdn}=${e.ip}/32`).join(',')
  return { [STATE_ANNOTATION]: stateJson, [TARGETS_ANNOTATION]: targets }
}

function parseState(annotations, now, config, declarations) {
  const raw = annotations[STATE_ANNOTATION]
  if (raw) {
    try {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) {
        const entries = []
        for (const e of arr) {
          if (
            e &&
            isValidIpv4(e.ip) &&
            Number.isInteger(e.port) &&
            e.port >= 1 &&
            e.port <= 65535 &&
            typeof e.fqdn === 'string' &&
            Number.isFinite(e.expiresAt)
          ) {
            entries.push({
              ip: e.ip,
              port: e.port,
              protocol: typeof e.protocol === 'string' ? e.protocol : DEFAULT_PROTOCOL,
              fqdn: e.fqdn,
              expiresAt: e.expiresAt,
              lastObservedAt: typeof e.lastObservedAt === 'number' ? e.lastObservedAt : 0,
            })
          }
        }
        return { entries }
      }
    } catch (_err) {
      // fall through to legacy / empty
    }
  }

  // Legacy migration (H5): host=ip/32 human view → bounded grace, TTL unknown.
  // The legacy annotation is PORTLESS, so derive port/protocol from the current
  // declarations (H-B) instead of guessing 443/TCP — a target declared on 5432
  // would otherwise be widened to both 443 and 5432 for one grace window. When
  // `declarations` is supplied, drop any legacy pair whose fqdn is no longer
  // declared; when it is omitted (isolated callers that cannot supply it), fall
  // back to the historical 443/TCP grace so H5 continuity is preserved.
  const legacy = annotations[TARGETS_ANNOTATION]
  if (legacy) {
    const haveDeclarations = Array.isArray(declarations)
    const declByFqdn = new Map()
    if (haveDeclarations) {
      for (const d of declarations) {
        if (!d || typeof d.fqdn !== 'string') continue
        const list = declByFqdn.get(d.fqdn) || []
        list.push({ port: d.port, protocol: d.protocol || DEFAULT_PROTOCOL })
        declByFqdn.set(d.fqdn, list)
      }
    }
    const entries = []
    for (const pair of legacy.split(',')) {
      const eq = pair.indexOf('=')
      if (eq < 0) continue
      const fqdn = pair.slice(0, eq).trim()
      const cidr = pair.slice(eq + 1).trim()
      if (!fqdn || !cidr) continue
      const ip = cidr.split('/')[0]
      if (!isValidIpv4(ip)) continue
      if (haveDeclarations) {
        const decls = declByFqdn.get(fqdn)
        if (!decls || decls.length === 0) continue // undeclared identity → drop
        for (const d of decls) {
          entries.push({
            ip,
            port: d.port,
            protocol: d.protocol,
            fqdn,
            expiresAt: now + config.overlapMs,
            lastObservedAt: now,
          })
        }
      } else {
        entries.push({
          ip,
          port: LEGACY_PORT,
          protocol: DEFAULT_PROTOCOL,
          fqdn,
          expiresAt: now + config.overlapMs,
          lastObservedAt: now,
        })
      }
    }
    if (entries.length > 0) return { entries }
  }

  return { entries: [] }
}

// ───────────────────────────────────────────────────────────────────────────
// issue #299 Phase 2 — provider-CIDR pipeline (Part A). Provider-BLIND: every
// function here takes ranges / registry data as INPUTS. No provider name ever
// appears in this file (generality invariant, CI grep-gated).
// ───────────────────────────────────────────────────────────────────────────

// Blocked external-egress set — promoted byte-identically from HCC's
// PUBLIC_EGRESS_EXCEPT_CIDRS (networkPolicyReconciler.ts) so HCC/WRC/control-ui/
// control-api enforce ONE list (G2: verified identical 18/18). RFC1918,
// link-local, metadata 169.254/16, CGNAT, benchmarking, TEST-NET, multicast,
// reserved.
const BLOCKED_EXTERNAL_EGRESS_CIDRS = Object.freeze([
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
  '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
  '192.31.196.0/24', '192.52.193.0/24', '192.88.99.0/24', '192.168.0.0/16',
  '192.175.48.0/24', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
  '224.0.0.0/4', '240.0.0.0/4',
])

const DEFAULT_PROVIDER_BOUNDS = { minPrefixLength: 16, maxRanges: 256, maxSpanAddresses: 2 ** 22 }

// STRICT octet: no leading zeros (except "0" itself), 0-255. Rejects the
// leading-zero inputs the old HCC parser accepted (G2 intentional strictening).
function strictIpv4ToNumber(ip) {
  const parts = ip.split('.')
  if (parts.length !== 4) return undefined
  let value = 0
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return undefined
    const octet = Number(part)
    if (octet > 255) return undefined
    value = (value << 8) + octet
  }
  return value >>> 0
}

function numberToIpv4(n) {
  return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`
}

// STRICT CIDR parse: exactly "a.b.c.d/nn" — no trailing garbage, no leading-zero
// octets/prefix. Promoted (and strictened) from HCC's cidrRange (G2 deltas in
// the CORE-16 test enumerate the intentional differences).
function cidrRange(cidr) {
  if (typeof cidr !== 'string') return undefined
  const m = cidr.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(0|[1-9]\d?)$/)
  if (!m) return undefined
  const prefix = Number(m[2])
  const ipNumber = strictIpv4ToNumber(m[1])
  if (ipNumber === undefined || prefix > 32) return undefined
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  const start = (ipNumber & mask) >>> 0
  const size = 2 ** (32 - prefix)
  return { start, end: (start + size - 1) >>> 0, prefix, canonical: ipNumber === start }
}

function cidrOverlaps(left, right) {
  const a = cidrRange(left)
  const b = cidrRange(right)
  if (!a || !b) return false
  return a.start <= b.end && b.start <= a.end
}

// Promoted HCC predicate: a syntactically-valid public IPv4 CIDR that does not
// overlap the blocked set. Same semantics as HCC's for well-formed inputs;
// strictly narrower on malformed inputs (G2).
function isAllowedExternalEgressCidr(cidr) {
  if (!cidrRange(cidr)) return false
  return !BLOCKED_EXTERNAL_EGRESS_CIDRS.some(blocked => cidrOverlaps(cidr, blocked))
}

// Family split (H5). ipv4 = strict "a.b.c.d/nn" shape; anything with ':' is ipv6
// (stored inert, never rendered, never fails a binding); the rest is invalid.
function partitionCidrsByFamily(cidrs) {
  const ipv4 = []
  const ipv6 = []
  const invalid = []
  for (const c of cidrs) {
    if (typeof c !== 'string') {
      invalid.push(String(c))
      continue
    }
    const t = c.trim()
    if (t.includes(':')) ipv6.push(t)
    else if (/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(t)) ipv4.push(t)
    else invalid.push(t)
  }
  return { ipv4, ipv6, invalid }
}

// Validate + canonicalize declared provider ranges for one binding. Deterministic;
// collects ALL reasons; never partial-applies. See Part A.6.
function validateProviderRanges(ranges, bounds) {
  const b = bounds || {}
  const minPrefixLength = b.minPrefixLength != null ? b.minPrefixLength : DEFAULT_PROVIDER_BOUNDS.minPrefixLength
  const maxRanges = b.maxRanges != null ? b.maxRanges : DEFAULT_PROVIDER_BOUNDS.maxRanges
  const maxSpanAddresses = b.maxSpanAddresses != null ? b.maxSpanAddresses : DEFAULT_PROVIDER_BOUNDS.maxSpanAddresses

  if (!Array.isArray(ranges) || ranges.length === 0) {
    return { kind: 'invalid', reasons: ['no ranges declared'] }
  }

  // Steps 1-3: per-range syntactic + prefix floor + blocked overlap.
  const reasons = []
  const parsed = []
  for (const r of ranges) {
    const range = cidrRange(r)
    if (!range) {
      reasons.push(`"${r}" is not a valid IPv4 CIDR`)
      continue
    }
    if (range.prefix < minPrefixLength) {
      reasons.push(`"${r}" is broader than the /${minPrefixLength} prefix floor`)
    }
    const blocked = BLOCKED_EXTERNAL_EGRESS_CIDRS.find(cidr => cidrOverlaps(r, cidr))
    if (blocked) {
      reasons.push(`"${r}" overlaps blocked range ${blocked}`)
    }
    parsed.push(range)
  }
  if (reasons.length > 0) return { kind: 'invalid', reasons }

  // Step 4: canonicalize to network address.
  const canon = parsed.map(range => ({
    cidr: `${numberToIpv4(range.start)}/${range.prefix}`,
    start: range.start,
    end: range.end,
    prefix: range.prefix,
  }))
  // Step 5: dedup (canonical string) then containment-collapse (drop a range
  // strictly contained in a wider retained one). CIDRs never partially overlap.
  const byCidr = new Map()
  for (const c of canon) byCidr.set(c.cidr, c)
  const unique = [...byCidr.values()]
  const collapsed = unique.filter(
    a => !unique.some(o => o !== a && o.start <= a.start && a.end <= o.end && o.end - o.start > a.end - a.start)
  )
  const sorted = collapsed.slice().sort((x, y) => x.start - y.start || x.prefix - y.prefix)

  // Step 6: count cap.
  if (sorted.length > maxRanges) reasons.push(`${sorted.length} ranges exceed the cap of ${maxRanges}`)

  // Step 7: span cap over merged (disjoint) intervals — distinct addresses.
  let span = 0
  let curStart = null
  let curEnd = null
  for (const c of sorted) {
    if (curStart === null) {
      curStart = c.start
      curEnd = c.end
    } else if (c.start <= curEnd + 1) {
      if (c.end > curEnd) curEnd = c.end
    } else {
      span += curEnd - curStart + 1
      curStart = c.start
      curEnd = c.end
    }
  }
  if (curStart !== null) span += curEnd - curStart + 1
  if (span > maxSpanAddresses) {
    reasons.push(`declared ranges span ${span} addresses, exceeding the cap of ${maxSpanAddresses}`)
  }

  if (reasons.length > 0) return { kind: 'invalid', reasons }
  return { kind: 'ok', ranges: sorted.map(c => c.cidr) }
}

// Partition one resolution's fresh IPs against declared ranges. `covered` are
// enforced by the range rules (never enter the /32 window); `uncovered` are the
// residue fed to the window and the drift-canary signal. See Part A.7.
function partitionIpsByProviderRanges(ips, ranges) {
  const parsed = ranges.map(cidrRange).filter(Boolean)
  const covered = []
  const uncovered = []
  for (const ip of [...new Set(ips)].sort()) {
    const n = strictIpv4ToNumber(ip)
    if (n !== undefined && parsed.some(r => n >= r.start && n <= r.end)) covered.push(ip)
    else uncovered.push(ip)
  }
  return { covered, uncovered }
}

// Read the provider-netblocks ConfigMap data (provider-blind: keys are opaque
// `<provider>.<category>.<family>` strings). IPv6 keys are skipped (H5); `_meta`
// is JSON. See Part A.8.
function parseProviderNetblocks(cmData) {
  const categories = Object.create(null)
  const errors = []
  let meta = null
  if (!cmData) return { categories, meta, errors: ['configmap has no data'] }
  for (const [key, value] of Object.entries(cmData)) {
    if (key === '_meta') {
      try {
        meta = JSON.parse(value)
      } catch (_err) {
        errors.push('_meta is not valid JSON')
      }
      continue
    }
    const m = key.match(/^([a-z0-9-]+)\.([A-Za-z0-9_-]+)\.(ipv4|ipv6)$/)
    if (!m) {
      errors.push(`unrecognized data key "${key}"`)
      continue
    }
    if (m[3] === 'ipv6') continue // stored, inert (H5)
    categories[`${m[1]}.${m[2]}`] = value
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
  }
  return { categories, meta, errors }
}

// The single shared classification/validation composition used identically by
// the HCC reconciler, both WRC call sites, and the control-api writer. The
// registry row is INJECTED data (from providerRegistry.cjs) so this stays
// provider-blind. See Part A.9.
function resolveProviderRanges(input) {
  const { fqdn, declaredName, declaredCategories, registryLookup, cmCategories, bounds } = input

  // Step 1: effective categories (+ hostname-suffix-never-classifies guard).
  let categories
  if (Array.isArray(declaredCategories) && declaredCategories.length > 0) {
    if (registryLookup && registryLookup.kind === 'mapped' && registryLookup.row.provider !== declaredName) {
      return { kind: 'invalid', reasons: [`registry maps "${fqdn}" to provider "${registryLookup.row.provider}", not "${declaredName}"`] }
    }
    // An EXPLICIT off-pool/unmapped registry row (an enforced counterexample, e.g.
    // an Azure Front Door endpoint behind a wildcard-matched host) outranks a user
    // category declaration — declared categories cannot smuggle a mis-attributed
    // pool onto a host the registry deliberately excluded. The unknown-fqdn escape
    // hatch (NO registry row at all) is deliberately retained: adding a NEW provider
    // is data (a CM key + declaration), the generality invariant (REG-6). The two
    // real risks the reviewer raised are bounded elsewhere: a CURATED provider
    // claimed on a mapped host is capped by the F1 subset + provider-match checks
    // here, and the approval surface renders provider bindings as catalog-wide
    // WARNINGs (control-ui egressModel), never a /32 illusion.
    if (registryLookup && registryLookup.kind === 'unmapped') {
      return { kind: 'invalid', reasons: [`"${fqdn}" is registry-unmapped for provider mode (${registryLookup.note})`] }
    }
    // F1: a MAPPED registry row also BOUNDS the declaration — declared categories
    // must be a subset of the curated row's, or a narrow single-category row could
    // be silently widened to the whole pool.
    if (registryLookup && registryLookup.kind === 'mapped') {
      const rowCategories = registryLookup.row.categories
      const excess = declaredCategories.filter(c => !rowCategories.includes(c))
      if (excess.length > 0) {
        return {
          kind: 'invalid',
          reasons: [
            `declared categories [${declaredCategories.join(', ')}] exceed registry row categories [${rowCategories.join(', ')}] for provider "${declaredName}"`,
          ],
        }
      }
    }
    categories = declaredCategories
  } else if (!registryLookup) {
    return { kind: 'invalid', reasons: [`provider mapping for "${fqdn}" is unknown — declare provider.categories explicitly or add a registry row`] }
  } else if (registryLookup.kind === 'unmapped') {
    return { kind: 'invalid', reasons: [`"${fqdn}" is registry-unmapped for provider mode (${registryLookup.note})`] }
  } else if (registryLookup.kind === 'mapped' && registryLookup.row.provider !== declaredName) {
    return { kind: 'invalid', reasons: [`registry maps "${fqdn}" to provider "${registryLookup.row.provider}", not "${declaredName}"`] }
  } else {
    categories = registryLookup.row.categories
  }

  // Step 2: every category present in the catalog.
  const reasons = []
  for (const c of categories) {
    if (!Object.prototype.hasOwnProperty.call(cmCategories, `${declaredName}.${c}`)) {
      reasons.push(`category "${declaredName}.${c}" is not present in the netblocks catalog`)
    }
  }
  if (reasons.length > 0) return { kind: 'invalid', reasons }

  // Step 3: union → IPv4 family filter (H5 defense) → zero check.
  const union = []
  for (const c of categories) union.push(...cmCategories[`${declaredName}.${c}`])
  const ipv4 = partitionCidrsByFamily(union).ipv4
  if (ipv4.length === 0) return { kind: 'invalid', reasons: [`provider "${declaredName}" resolved to zero IPv4 ranges`] }

  // Step 4: shared bounds validation.
  const v = validateProviderRanges(ipv4, bounds)
  if (v.kind === 'invalid') return v
  return { kind: 'ok', ranges: v.ranges, categories }
}

module.exports = {
  STATE_ANNOTATION,
  TARGETS_ANNOTATION,
  RESOLVED_AT_ANNOTATION,
  emptyState,
  reconcileEgressState,
  stateHash,
  serializeState,
  parseState,
  classifyDnsError,
  BLOCKED_EXTERNAL_EGRESS_CIDRS,
  cidrRange,
  cidrOverlaps,
  isAllowedExternalEgressCidr,
  partitionCidrsByFamily,
  validateProviderRanges,
  partitionIpsByProviderRanges,
  parseProviderNetblocks,
  resolveProviderRanges,
}
