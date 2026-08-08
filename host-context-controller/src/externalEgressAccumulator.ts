/**
 * externalEgressAccumulator (HCC) — the host-context-controller adapter between
 * `dns.resolve4` and the pure sliding-window core (`@clerum/network-policy-core`),
 * for issue #299.
 *
 * HCC's `reconcileExternalEgress` materializes a single-generation DNS snapshot
 * per McpServer egress binding (`dns.resolve4(binding.dns)` → one /32 per A
 * record). A provider that serves ONE rotating A record (GitHub's api.github.com,
 * TTL ~15s over 140.82.112.0/20) makes that snapshot pin one IP of ~16, so the
 * pod's next resolution lands on an un-pinned IP and the NetworkPolicy drops it.
 *
 * This adapter folds each per-binding snapshot into the accumulated set persisted
 * on THAT policy's annotations, so the effective egress set is the union of
 * recently-live IPs rather than a single photo. Each policy holds the state for a
 * single FQDN (HCC builds one NetworkPolicy per binding), so the cap and window
 * apply per-FQDN.
 *
 * It is a PURE function (clock injected as `now`, previous state read from the
 * caller-supplied annotations). All Kubernetes and DNS I/O stays in the reconciler.
 *
 * Guarantees delegated to the core (see plan §0/§3/§5): H1 fail-static (a
 * `transient` resolver failure freezes the FQDN's entries), H3 eviction (evict,
 * never reject), H4 no-op (change hash over ip/port/protocol only), H5 rehydration
 * (legacy `egress-fqdn-targets` is not blanked).
 */
import {
  type EgressCoreConfig,
  type Observation,
  RESOLVED_AT_ANNOTATION,
  emptyState,
  parseState,
  reconcileEgressState,
  serializeState,
} from '@clerum/network-policy-core'

/** This round's DNS outcome for one binding, normalized for the core. */
export type HostEgressResolution =
  | { kind: 'ok'; ips: string[]; ttlSeconds: number }
  | { kind: 'transient' }
  | { kind: 'permanent' }

export interface AccumulateHostEgressInput {
  /** The binding's exact-host FQDN. */
  fqdn: string
  /** The binding's destination port. */
  port: number
  /** The binding's protocol (TCP/UDP). */
  protocol: string
  /** This round's resolution outcome. */
  resolution: HostEgressResolution
  /** Annotations of the existing NetworkPolicy for this binding, or undefined on bootstrap. */
  previousAnnotations: Record<string, string> | undefined
  /** Injected clock (epoch ms). */
  now: number
  config: EgressCoreConfig
}

export interface AccumulateHostEgressOutput {
  /** The effective accumulated /32 set to render as ipBlocks (sorted, deduped). */
  cidrs: string[]
  /** Annotations to stamp on the policy: serialized state + resolved-at. */
  annotations: Record<string, string>
  /** True iff the (ip,port,protocol) set changed vs the previous state. */
  changed: boolean
  /** True iff the persisted window is aging and must be re-persisted (audit M1). */
  renewalDue: boolean
  /** True iff this FQDN was frozen this round (transient failure with a prior set). */
  frozen: boolean
  /** Number of entries removed by the cap this round (for a Warning event / metric). */
  evicted: number
  /** True iff the cap was hit and eviction happened. */
  overCap: boolean
}

/**
 * Fold one binding's DNS resolution into the accumulated egress set persisted on
 * its policy's annotations, applying the sliding window, fail-static expiry, and
 * eviction from `@clerum/network-policy-core`.
 */
export function accumulateHostExactHostEgress(
  input: AccumulateHostEgressInput
): AccumulateHostEgressOutput {
  const { fqdn, port, protocol, resolution, previousAnnotations, now, config } = input

  const previous = previousAnnotations ? parseState(previousAnnotations, now, config) : emptyState()

  let observation: Observation
  if (resolution.kind === 'ok') {
    observation = {
      fqdn,
      port,
      protocol,
      kind: 'ok',
      ips: resolution.ips,
      ttlMs: resolution.ttlSeconds * 1000,
    }
  } else if (resolution.kind === 'transient') {
    observation = { fqdn, port, protocol, kind: 'transient' }
  } else {
    observation = { fqdn, port, protocol, kind: 'permanent' }
  }

  const out = reconcileEgressState(previous, [observation], now, config)

  return {
    cidrs: out.entries.map(entry => `${entry.ip}/32`),
    annotations: {
      ...serializeState(out.state),
      [RESOLVED_AT_ANNOTATION]: new Date(now).toISOString(),
    },
    changed: out.changed,
    renewalDue: out.renewalDue,
    frozen: out.frozenFqdns.includes(fqdn),
    evicted: out.evicted.length,
    overCap: out.overCap,
  }
}
