/**
 * externalEgressAccumulator — the WRC-side adapter between the DNS resolver
 * (`fqdnResolver.ts`) and the pure sliding-window core
 * (`@clerum/network-policy-core`), for issue #299.
 *
 * The resolver produces a single-generation DNS snapshot (one /32 per A record
 * of this reconcile). A provider that serves ONE rotating A record (GitHub's
 * api.github.com, TTL ~15s over 140.82.112.0/20) makes that snapshot pin one IP
 * of ~16, so the pod's next resolution lands on an un-pinned IP and the
 * NetworkPolicy drops it. This adapter folds each snapshot into the accumulated
 * set persisted on the policy's annotations, so the effective egress set is the
 * union of recently-live IPs rather than a single photo.
 *
 * It is a PURE function (clock injected as `now`, previous state read from the
 * caller-supplied annotations), so it is unit-testable without Kubernetes or
 * DNS. All Kubernetes I/O (reading the existing NetworkPolicy, writing it) stays
 * in the reconciler.
 *
 * Guarantees delegated to the core (see plan §0/§3/§5):
 *  - H1 fail-static: a `transient` resolver failure FREEZES that FQDN's entries
 *    (never prunes them while DNS is failing) and surfaces it in `frozenFqdns`.
 *  - H3 eviction: on overflow, evict soonest-to-expire, NEVER reject/truncate.
 *  - H4 no-op: `changed` is over (ip,port,protocol) only — a timestamp-only
 *    refresh writes nothing.
 *  - H5 rehydration: previous state is parsed from the policy's annotations; an
 *    unparseable/legacy format is NOT collapsed to an empty set.
 */
import {
  type EgressCoreConfig,
  type EgressEntry,
  type Observation,
  RESOLVED_AT_ANNOTATION,
  emptyState,
  parseState,
  reconcileEgressState,
  serializeState,
} from '@clerum/network-policy-core'
import type { ResolveResult } from './fqdnResolver'
import type { ResolvedExternalEgressInput } from './resourceBuilder'

/** A declared external egress target (fqdn + port) for one policy. */
export interface DeclaredExternal {
  fqdn: string
  port: number
}

export interface AccumulateInput {
  /** The `external[]`/`egressBindings[]` targets declared on the recipe. */
  externals: DeclaredExternal[]
  /** This reconcile's resolver output (with per-fqdn TTLs). */
  resolveResult: ResolveResult
  /** Annotations of the existing NetworkPolicy, or undefined on bootstrap. */
  previousAnnotations: Record<string, string> | undefined
  /** Injected clock (epoch ms). */
  now: number
  config: EgressCoreConfig
}

export interface AccumulateOutput {
  /** The effective live entries (the accumulated set) to render as ipBlocks. */
  entries: EgressEntry[]
  /** `entries` mapped to the builder's ipBlock input shape. */
  resolved: ResolvedExternalEgressInput[]
  /** Annotations to stamp on the policy: serialized state + resolved-at. */
  annotations: Record<string, string>
  /** True iff the (ip,port,protocol) set changed vs the previous state. */
  changed: boolean
  /** True iff the persisted window is aging and must be re-persisted (audit M1). */
  renewalDue: boolean
  /** Entries removed by the cap this round (for a Warning event / metric). */
  evicted: EgressEntry[]
  /** True iff the cap was hit and eviction happened. */
  overCap: boolean
  /** FQDNs frozen this round because their observation was transient. */
  frozenFqdns: string[]
}

/**
 * Turn the declared externals + this round's resolver output into normalized
 * observations for the core. Iterating the DECLARED list (not the resolver
 * output) is deliberate: a name that resolved OK-but-empty produces no resolved
 * entry and no failure, yet the core still needs an `ok` observation with an
 * empty ip set so its stale entries can expire.
 */
function buildObservations(
  externals: DeclaredExternal[],
  resolveResult: ResolveResult
): Observation[] {
  // A failing fqdn yields one failure per declared entry; retryability is
  // consistent per fqdn (one lookup), so index by fqdn.
  const retryableByFqdn = new Map<string, boolean>()
  for (const f of resolveResult.failures) {
    // If a fqdn ever has a non-retryable failure this round, it is permanent.
    const prior = retryableByFqdn.get(f.fqdn)
    retryableByFqdn.set(f.fqdn, prior === false ? false : f.retryable)
  }

  // Group resolved /32s back to their fqdn: ip set + the fqdn's TTL (ms).
  const okByFqdn = new Map<string, { ips: string[]; ttlMs: number }>()
  for (const r of resolveResult.resolved) {
    const fqdn = r.source.fqdn
    const ip = r.cidr.replace(/\/\d+$/, '')
    const existing = okByFqdn.get(fqdn)
    if (existing) {
      existing.ips.push(ip)
    } else {
      okByFqdn.set(fqdn, { ips: [ip], ttlMs: r.ttlSeconds * 1000 })
    }
  }

  const observations: Observation[] = []
  for (const ext of externals) {
    const failure = retryableByFqdn.get(ext.fqdn)
    if (failure !== undefined) {
      observations.push({
        fqdn: ext.fqdn,
        port: ext.port,
        kind: failure ? 'transient' : 'permanent',
      })
      continue
    }
    const ok = okByFqdn.get(ext.fqdn)
    observations.push({
      fqdn: ext.fqdn,
      port: ext.port,
      kind: 'ok',
      ips: ok?.ips ?? [],
      ttlMs: ok?.ttlMs ?? 0,
    })
  }
  return observations
}

/**
 * Fold this reconcile's DNS snapshot into the accumulated egress set persisted
 * on the policy's annotations, applying the sliding window, fail-static expiry,
 * and eviction from `@clerum/network-policy-core`.
 */
export function accumulateExternalEgress(input: AccumulateInput): AccumulateOutput {
  const { externals, resolveResult, previousAnnotations, now, config } = input

  const previous = previousAnnotations ? parseState(previousAnnotations, now, config) : emptyState()

  const observations = buildObservations(externals, resolveResult)
  const out = reconcileEgressState(previous, observations, now, config)

  const resolved: ResolvedExternalEgressInput[] = out.entries.map(entry => ({
    cidr: `${entry.ip}/32`,
    port: entry.port,
    source: { kind: 'fqdn', fqdn: entry.fqdn },
  }))

  const annotations: Record<string, string> = {
    ...serializeState(out.state),
    [RESOLVED_AT_ANNOTATION]: new Date(now).toISOString(),
  }

  return {
    entries: out.entries,
    resolved,
    annotations,
    changed: out.changed,
    renewalDue: out.renewalDue,
    evicted: out.evicted,
    overCap: out.overCap,
    frozenFqdns: out.frozenFqdns,
  }
}
