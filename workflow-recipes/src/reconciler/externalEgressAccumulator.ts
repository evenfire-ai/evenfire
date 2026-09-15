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
 *  - H3 eviction: on overflow, evict least-recently-observed (soonest-to-expire is only a tiebreak), NEVER reject/truncate.
 *  - H4 no-op: `changed` is over (fqdn,ip,port,protocol) only — a timestamp-only
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
  parseStateStrict,
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
  /** True iff the (fqdn,ip,port,protocol) set changed vs the previous state. */
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

export interface ContractInput {
  externals: DeclaredExternal[]
  previousAnnotations: Record<string, string> | undefined
  now: number
  config: EgressCoreConfig
  /** Optional lane-specific safety filter applied to persisted IPs. */
  isAllowedIp?: (ip: string) => boolean
}

export interface ContractOutput {
  entries: EgressEntry[]
  resolved: ResolvedExternalEgressInput[]
  annotations: Record<string, string>
  changed: boolean
  evicted: EgressEntry[]
  overCap: boolean
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

function priorAcceptedResolvedAt(
  previousAnnotations: Record<string, string> | undefined,
  config: EgressCoreConfig,
  externals: DeclaredExternal[]
): string | undefined {
  if (!previousAnnotations) return undefined
  const annotated = previousAnnotations[RESOLVED_AT_ANNOTATION]
  if (annotated && Number.isFinite(Date.parse(annotated))) return annotated
  const strict = parseStateStrict(previousAnnotations, config, externals)
  if (strict.kind !== 'valid' || strict.state.entries.length === 0) return undefined
  const latestObservedAt = Math.max(...strict.state.entries.map(entry => entry.lastObservedAt))
  return Number.isFinite(new Date(latestObservedAt).getTime())
    ? new Date(latestObservedAt).toISOString()
    : undefined
}

/**
 * Fold this reconcile's DNS snapshot into the accumulated egress set persisted
 * on the policy's annotations, applying the sliding window, fail-static expiry,
 * and eviction from `@clerum/network-policy-core`.
 */
export function accumulateExternalEgress(input: AccumulateInput): AccumulateOutput {
  const { externals, resolveResult, previousAnnotations, now, config } = input

  // Pass the declared externals so a legacy (portless) migration takes the
  // current declared port, not a guessed 443, and drops undeclared FQDNs (H-B).
  const previous = previousAnnotations
    ? parseState(previousAnnotations, now, config, externals)
    : emptyState()

  const observations = buildObservations(externals, resolveResult)
  const out = reconcileEgressState(previous, observations, now, config)
  const permanentFqdns = new Set(
    resolveResult.failures.filter(failure => !failure.retryable).map(failure => failure.fqdn)
  )
  // A conclusive negative answer blocks this reconcile and revokes that
  // identity immediately. The shared core's normal TTL expiry remains useful
  // for other consumers, but WRC must not keep a known-negative allow live.
  const entries = out.entries.filter(entry => !permanentFqdns.has(entry.fqdn))

  const resolved: ResolvedExternalEgressInput[] = entries.map(entry => ({
    cidr: `${entry.ip}/32`,
    port: entry.port,
    source: { kind: 'fqdn', fqdn: entry.fqdn },
  }))

  const annotations: Record<string, string> = serializeState({ entries })
  const resolvedAt =
    resolveResult.resolved.length > 0
      ? new Date(now).toISOString()
      : priorAcceptedResolvedAt(previousAnnotations, config, externals)
  if (resolvedAt) annotations[RESOLVED_AT_ANNOTATION] = resolvedAt

  return {
    entries,
    resolved,
    annotations,
    changed: out.changed || entries.length !== out.entries.length,
    renewalDue: out.renewalDue,
    evicted: out.evicted,
    overCap: out.overCap,
    frozenFqdns: out.frozenFqdns,
  }
}

/**
 * Contract an existing aggregate policy to the declarations that still exist,
 * without performing or pretending to perform a DNS observation. Current
 * identities are frozen for this pure subtractive phase; undeclared identities
 * are removed and the normal cap still applies. The last successful resolved-at
 * timestamp is preserved because contraction is not a resolution event.
 */
export function contractExternalEgress(input: ContractInput): ContractOutput {
  const { externals, previousAnnotations, now, config, isAllowedIp } = input
  const previous = previousAnnotations
    ? parseState(previousAnnotations, now, config, externals)
    : emptyState()
  const observations: Observation[] = externals.map(external => ({
    fqdn: external.fqdn,
    port: external.port,
    kind: 'transient',
  }))
  const out = reconcileEgressState(previous, observations, now, config)
  const entries = isAllowedIp ? out.entries.filter(entry => isAllowedIp(entry.ip)) : out.entries
  const resolved: ResolvedExternalEgressInput[] = entries.map(entry => ({
    cidr: `${entry.ip}/32`,
    port: entry.port,
    source: { kind: 'fqdn', fqdn: entry.fqdn },
  }))
  const annotations = serializeState({ entries })
  const lastResolvedAt = priorAcceptedResolvedAt(previousAnnotations, config, externals)
  if (lastResolvedAt) annotations[RESOLVED_AT_ANNOTATION] = lastResolvedAt

  return {
    entries,
    resolved,
    annotations,
    changed: out.changed || entries.length !== out.entries.length,
    evicted: out.evicted,
    overCap: out.overCap,
  }
}
