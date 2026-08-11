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
  /** true iff the (ip,port,protocol) set changed vs previous — else NO-OP write */
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

/** Stable change hash over (ip,port,protocol) only — excludes expiresAt (H4). */
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

/**
 * Classify a DNS failure as 'transient' (resolver/upstream temporarily
 * unavailable → fail-static freeze, H1) or 'permanent' (genuine no-records →
 * entries expire normally). Accepts a raw code string or an Error with `.code`.
 * Unknown/missing codes default to 'permanent'. Shared source of truth for WRC
 * and HCC so fail-static behaves identically platform-wide (issue #299).
 */
export declare function classifyDnsError(
  errOrCode: unknown
): 'transient' | 'permanent'
