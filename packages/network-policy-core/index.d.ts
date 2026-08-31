/**
 * @clerum/network-policy-core — shared sliding-window egress IP accumulation
 * for FQDN NetworkPolicies (issue #299).
 *
 * Pure module: no Kubernetes and no DNS dependency. The caller (WRC/HCC
 * resolver) does the DNS resolution and passes normalized Observations; the
 * clock is injected as `now` (epoch ms) so the sliding window is deterministic
 * and unit-testable without fake timers.
 *
 * Design guarantees (see plan §0/§3/§5):
 *  - Monotonically permissive vs the single snapshot: the latest OK response is
 *    always in the set.
 *  - H1 fail-static: a DECLARED FQDN whose DNS is transiently failing (an explicit
 *    `transient` observation) is FROZEN — its entries never expire while the
 *    resolver is failing. A DECLARED FQDN with an `ok`/`permanent` observation
 *    expires normally. An FQDN with NO observation this round is no longer
 *    declared (removed from the spec) and is REVOKED immediately, never frozen
 *    (audit F1: freezing an undeclared FQDN keeps a removed host's egress
 *    forever — worse than the original snapshot).
 *  - H3 eviction: on overflow, evict the LEAST-RECENTLY-OBSERVED first (tiebreak
 *    soonest-expiry, then key), NEVER reject/truncate the policy.
 *  - H4 no-op: the change hash is over (fqdn,ip,port,protocol) only, NOT expiry,
 *    so a refresh that only renews timestamps writes nothing.
 *  - H5 rehydration: parse the previous state from annotations; an old/invalid
 *    format is NOT turned into an empty set (the caller keeps the live policy).
 */

export interface EgressEntry {
  ip: string
  port: number
  protocol: string
  fqdn: string
  /** absolute epoch ms; entry is live while now < expiresAt (window) */
  expiresAt: number
  /**
   * epoch ms of the last OK observation of this IP. Eviction (H3) removes the
   * least-recently-OBSERVED first — a faithful LRU that, unlike expiresAt, does
   * not misrank when a host serves a variable TTL. A stable IP re-observed every
   * tick is never evicted.
   */
  lastObservedAt: number
}

export interface EgressState {
  entries: EgressEntry[]
}

export interface EgressCoreConfig {
  /** grace/overlap kept after the DNS TTL, in ms (plan default 300000) */
  overlapMs: number
  /** alarm cap; on overflow we evict, never reject (plan default >=128) */
  maxEntries: number
}

/**
 * A normalized DNS observation for one (fqdn,port,protocol) produced by the
 * resolver this round:
 *  - ok:        records resolved; `ips` is the A-record set, `ttlMs` the TTL.
 *  - transient: resolver/upstream failure (SERVFAIL/timeout) — fail-static (H1).
 *  - permanent: the name genuinely has no records — entries expire normally.
 */
export type Observation =
  | { fqdn: string; port: number; protocol?: string; kind: 'ok'; ips: string[]; ttlMs: number }
  | { fqdn: string; port: number; protocol?: string; kind: 'transient' }
  | { fqdn: string; port: number; protocol?: string; kind: 'permanent' }

export interface ReconcileOutput {
  /** next state to persist in annotations */
  state: EgressState
  /** live effective entries to render as ipBlocks (== state.entries) */
  entries: EgressEntry[]
  /** true iff the (fqdn,ip,port,protocol) set changed vs previous — else NO-OP write */
  changed: boolean
  /**
   * true iff a SURVIVING entry's persisted window is within overlap/2 of lapsing
   * (audit M1). The caller should write even when `changed` is false, to
   * re-persist the renewed window and preserve the overlap grace on the next
   * rotation. Bounded to ~one write per overlap/2 for a stable set.
   */
  renewalDue: boolean
  /** entries removed by the cap this round (for Warning event / metric) */
  evicted: EgressEntry[]
  /** true iff the cap was hit and eviction happened (alarm) */
  overCap: boolean
  /** FQDNs frozen this round because their observation was transient (staleness alarm) */
  frozenFqdns: string[]
}

/** Empty state (bootstrap). */
export declare function emptyState(): EgressState

/**
 * Fold this round's observations into the previous state using the sliding
 * window, fail-static expiry (H1), and eviction (H3). Pure; `now` is injected.
 */
export declare function reconcileEgressState(
  previous: EgressState,
  observations: Observation[],
  now: number,
  config: EgressCoreConfig
): ReconcileOutput

/** Stable change hash over (fqdn,ip,port,protocol) only — excludes expiresAt (H4). */
export declare function stateHash(entries: EgressEntry[]): string

/** Deterministic, ordered annotation map for the policy (new format + human view). */
export declare function serializeState(state: EgressState): Record<string, string>

/**
 * Rehydrate state from a policy's annotations (H5). Understands the new state
 * format and, as a safe migration, the legacy `egress-fqdn-targets` host=ip/32
 * view (rehydrated with a bounded grace = now + overlapMs since TTL is unknown).
 * Returns an empty state only when nothing parses — the caller then keeps the
 * existing live policy rather than blanking egress.
 *
 * `declarations` (H-B): the currently-declared external targets. The legacy
 * annotation is portless, so when supplied, each migrated entry takes the
 * port/protocol of its current declaration (not a guessed 443/TCP) and pairs for
 * no-longer-declared FQDNs are dropped. Omit it only from callers that cannot
 * supply the declarations, which then fall back to the historical 443/TCP grace.
 */
export declare function parseState(
  annotations: Record<string, string>,
  now: number,
  config: EgressCoreConfig,
  declarations?: ReadonlyArray<{ fqdn: string; port: number; protocol?: string }>
): EgressState

export declare const STATE_ANNOTATION: string
export declare const TARGETS_ANNOTATION: string
export declare const RESOLVED_AT_ANNOTATION: string

/** Pre-deploy network-readiness handshake annotation keys (shared by WRC and HCC). */
export declare const PRE_DEPLOY_ANNOTATION: string
export declare const NETWORK_READY_ANNOTATION: string
export declare const NETWORK_READY_GENERATION_ANNOTATION: string

/**
 * Classify a DNS failure as 'transient' (resolver/upstream temporarily
 * unavailable → fail-static freeze, H1) or 'permanent' (genuine no-records →
 * entries expire normally). Accepts a raw code string or an Error with `.code`.
 * Unknown/missing codes default to 'permanent'. Shared source of truth for WRC
 * and HCC so fail-static behaves identically platform-wide (issue #299).
 */
export declare function classifyDnsError(errOrCode: unknown): 'transient' | 'permanent'

// ─── issue #299 Phase 2 — provider-CIDR pipeline (Part A). Provider-blind. ───

/** Config bounds for provider-range validation (injected; the module stays pure). */
export interface ProviderRangeBounds {
  /** Reject any range with prefix < this (default 16). Per-provider override injected by the caller. */
  minPrefixLength?: number
  /** Max ranges after canonicalization (default 256 — H1: must fit a full /meta category union). */
  maxRanges?: number
  /** Max total distinct addresses across all ranges (default 2**22 = 4194304). */
  maxSpanAddresses?: number
}

export type ProviderRangeValidation =
  | { kind: 'ok'; ranges: string[] } // canonical: network-addr normalized, deduped, containment-collapsed, sorted
  | { kind: 'invalid'; reasons: string[] }

export interface ProviderRegistryRow {
  provider: string
  categories: string[]
}

export type ProviderRegistryLookup =
  | { kind: 'mapped'; row: ProviderRegistryRow }
  | { kind: 'unmapped'; note: string }
  | undefined

/** The blocked external-egress set (RFC1918/link-local/metadata/CGNAT/…), shared by all controllers (G2). */
export declare const BLOCKED_EXTERNAL_EGRESS_CIDRS: readonly string[]

/** Strict IPv4 CIDR parse: exactly "a.b.c.d/nn", no trailing garbage or leading-zero octets/prefix. */
export declare function cidrRange(
  cidr: string
): { start: number; end: number; prefix: number; canonical: boolean } | undefined

/** True iff two IPv4 CIDRs share any address. */
export declare function cidrOverlaps(left: string, right: string): boolean

/** Promoted HCC predicate: a valid public IPv4 CIDR not overlapping the blocked set. */
export declare function isAllowedExternalEgressCidr(cidr: string): boolean

/** Split CIDRs by family (H5): ipv4 rendered, ipv6 stored inert, invalid rejected loudly by the writer. */
export declare function partitionCidrsByFamily(cidrs: readonly string[]): {
  ipv4: string[]
  ipv6: string[]
  invalid: string[]
}

/**
 * Validate + canonicalize declared provider ranges for one binding: syntactic
 * IPv4 CIDR, prefix >= minPrefixLength, zero overlap with the blocked set, count
 * cap, span cap, dedup/containment-collapse. Collects ALL reasons; never partial.
 */
export declare function validateProviderRanges(
  ranges: readonly string[],
  bounds?: ProviderRangeBounds
): ProviderRangeValidation

/**
 * Partition one resolution's fresh IPs against declared ranges. `covered` are
 * enforced by the range rules (do NOT enter the window); `uncovered` are the
 * residue fed to the window — and the drift-canary signal.
 */
export declare function partitionIpsByProviderRanges(
  ips: readonly string[],
  ranges: readonly string[]
): { covered: string[]; uncovered: string[] }

/**
 * Read the provider-netblocks ConfigMap data (provider-blind: `<provider>.<category>`
 * keys are opaque). IPv6 keys are skipped (H5); `_meta` is parsed as JSON.
 */
export declare function parseProviderNetblocks(cmData: Record<string, string> | undefined): {
  categories: Record<string, string[]>
  meta: unknown
  errors: string[]
}

/**
 * The single shared classification/validation composition used by the HCC
 * reconciler, both WRC call sites, and the control-api writer. The registry row
 * is injected data so this stays provider-blind.
 */
export declare function resolveProviderRanges(input: {
  fqdn: string
  declaredName: string
  declaredCategories?: readonly string[]
  registryLookup: ProviderRegistryLookup
  cmCategories: Record<string, string[]>
  bounds: ProviderRangeBounds
  /**
   * Curated provider names, supplied by the caller from the registry's
   * `providerNames`. When present, a declaration naming a curated provider on an
   * FQDN the registry has no row for is REJECTED — otherwise any host could claim
   * a curated provider's whole pool. Omitting this keeps the pre-REG-6 behaviour,
   * so every render path should pass it.
   */
  curatedProviders?: readonly string[]
}): { kind: 'ok'; ranges: string[]; categories: string[] } | { kind: 'invalid'; reasons: string[] }

/**
 * issue #510 — ports reachable by an `egressClass: provider` binding on a
 * NON-TRANSPORT workload.
 *
 * These are exactly the ports `public-web` allows. Capping here makes
 * `provider` a strict subset of `public-web` in both address space and ports,
 * so the tier that is permitted on non-transport workloads cannot reach further
 * than the tier that is refused on them. Transport workloads are not capped.
 *
 * The CRD's CEL rule carries the same literal; a parity test pins them together.
 */
export declare const PROVIDER_NON_TRANSPORT_ALLOWED_PORTS: readonly number[]

/**
 * True when `port` is reachable by a `provider` binding on a non-transport
 * workload. Do not consult this for transport workloads — the cap does not
 * apply there.
 */
export declare function isProviderNonTransportPortAllowed(port: unknown): boolean
