'use strict'

/**
 * @clerum/network-policy-core — see index.d.ts for the contract and the
 * H1–H5 guarantees. Pure module: no Kubernetes, no DNS, injectable clock.
 */

const STATE_ANNOTATION = 'clerum.io/egress-fqdn-state'
const TARGETS_ANNOTATION = 'clerum.io/egress-fqdn-targets'
const RESOLVED_AT_ANNOTATION = 'clerum.io/egress-fqdn-resolved-at'

// Pre-deploy network-readiness handshake keys (WRC producer/consumer, HCC producer).
// Shared here so WRC (workflow-recipes) and HCC (host-context-controller) derive the
// exact same literals — a divergence becomes a compile error, not a silent 30s
// fail-open timeout. Consumed by both services' reconcilers.
const PRE_DEPLOY_ANNOTATION = 'clerum.io/pre-deploy'
const NETWORK_READY_ANNOTATION = 'clerum.io/network-ready'
const NETWORK_READY_GENERATION_ANNOTATION = 'clerum.io/network-ready-observed-generation'

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
 * DNS codes that are a POSITIVE permanent verdict about the NAME (issue #513):
 * the two genuine no-records answers, plus EBADNAME — c-ares refused to send
 * the query because the name is malformed. EBADNAME is reachable from user
 * input through exactly one field today: `spec.ui.egress.external[].fqdn`, whose
 * CRD pattern admits labels over 63 octets and which no controller validates
 * further. (The other two hostname fields do not reach it: HCC's
 * `isPublicDnsHostname` and WRC's workload-binding validator both apply a
 * per-label regex before resolving.) A malformed name is the operator's
 * misconfiguration — not a resolver outage, not a controller fault — so it
 * prunes and is reported as rejected exactly like NXDOMAIN.
 *
 * Every other non-transient code stays OUT on purpose: EBADFAMILY, EBADFLAGS,
 * EBADHINTS, ENONAME, EBADQUERY and EBADSTR describe arguments neither
 * controller derives from user data, so if one of them fires the call is ours.
 * `classifyDnsError` still defaults those to 'permanent' — its contract is
 * pinned by this package's tests — which is exactly why the controllers gate on
 * THIS set to decide what may reach the sliding-window classifier, and rethrow
 * the rest instead of laundering a fault into a prune.
 */
const PERMANENT_DNS_CODES = new Set(['ENODATA', 'ENOTFOUND', 'EBADNAME'])

/**
 * Seam worth knowing about, not a defect today: this set and TRANSIENT_DNS_CODES
 * decide what the egress gates treat as a DNS verdict, while WRC's downstream
 * retry classifier keys on a DIFFERENT set — RETRYABLE_SOCKET_CODES in
 * `workflow-recipes/src/reconciler/k8sErrors.ts`. Codes in the gap
 * (EHOSTUNREACH, ENETDOWN, EPIPE, UND_ERR_*) would be called a controller fault
 * here and then re-rescued into a retry there. Unreachable in practice: c-ares
 * emits ETIMEOUT/ENETUNREACH, both already transient. It is recorded because two
 * sources of truth for "which failures are worth retrying" drifting apart is the
 * same class of bug as issue #513 itself — one question's answer reused for
 * another question.
 */

function isPermanentDnsCode(code) {
  return typeof code === 'string' && PERMANENT_DNS_CODES.has(code)
}

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

module.exports = {
  STATE_ANNOTATION,
  TARGETS_ANNOTATION,
  RESOLVED_AT_ANNOTATION,
  PRE_DEPLOY_ANNOTATION,
  NETWORK_READY_ANNOTATION,
  NETWORK_READY_GENERATION_ANNOTATION,
  emptyState,
  reconcileEgressState,
  stateHash,
  serializeState,
  parseState,
  classifyDnsError,
  PERMANENT_DNS_CODES,
  isPermanentDnsCode,
}
