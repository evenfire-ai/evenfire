import { rootLogger } from '../../observability/logger.js'
import { type CoverageSet, OFFERED_KEY_SEP } from './modelAllowlistTolerance.js'

/**
 * Audit signal for the asymmetric "no-worsening" tolerance of the global
 * `model_not_allowed` write gate (spec Fase 2, Pieza D).
 *
 * When a gate tolerates a `(provider, model)` pair that is NOT in the operator
 * allowlist — because the write does not worsen a pre-existing incoherence
 * (`isNonWorseningToleration`) — it MUST never be silent. Each tolerated gate
 * decision emits exactly one structured audit event through this single shared
 * helper, so the four call sites (the 3 Host gates + the grant gate) cannot
 * diverge on the event shape or forget to emit. Emission is deferred until the
 * write PERSISTS: the write gates only QUEUE tolerations, and the caller emits
 * them after the K8s/DB write succeeds — a write rejected by a later gate
 * (422/400) or that fails to persist (K8s 409, DB error) leaves no audit record,
 * so the trail records only tolerations that actually took hold.
 * (A single pair filling two roles — e.g. primary AND a `spec.allowedModels`
 * entry — is a distinct decision at each gate and legitimately emits once per
 * gate, each event carrying its own `gate`.)
 *
 * This is an OBSERVABILITY signal, not a governed authority mutation: the Host/
 * grant write that provoked the tolerance is already recorded in the governed
 * administrative trail. So it rides the audit-only `rootLogger.warn` channel
 * (the same idiom as `namespaceAudit`'s SECURITY events), NOT the tamper-evident
 * tracing pipeline — which, fed fabricated write-gate context, would only
 * degrade that pipeline's guarantees.
 */
export const HOST_SPEC_INCOHERENCE_TOLERATED_EVENT = 'host_spec_incoherence_tolerated' as const

/** Which of the four global-allowlist gates tolerated the pair. */
export type IncoherenceToleranceGate = 'primary' | 'subset' | 'fallback' | 'grant'

export interface HostSpecIncoherenceToleratedEvent {
  /** The resource whose write was tolerated. */
  resourceKind: 'host' | 'grant'
  /** Namespace of the Host CR / grant recipe. */
  namespace: string
  /** Host name / grant recipe name. */
  name: string
  /** The disallowed pair that was tolerated. */
  provider: string
  model: string
  /** The gate that tolerated it. */
  gate: IncoherenceToleranceGate
  /** Coverage the record offered BEFORE this write (evidence of no-worsening). */
  offeredBefore: CoverageSet
  /** Coverage the record offers AFTER this write. */
  offeredAfter: CoverageSet
}

/** Callback shape injected into the write gates so emission is testable via the seam. */
export type EmitHostSpecIncoherenceTolerated = (event: HostSpecIncoherenceToleratedEvent) => void

function coverageForLog(
  coverage: CoverageSet
): 'universal' | Array<{ provider?: string; model: string }> {
  if (coverage === 'UNIVERSAL') return 'universal'
  // Host coverage keys are `offeredKey(provider, model)` joined by a NUL byte;
  // split them back into readable pairs so the structured log carries no control
  // char. GRANT coverage keys are plain model names (grant `allowed_models` is a
  // flat, provider-less list) — those have no separator, so we log just `model`
  // (the event's top-level `provider` already carries the grant's provider).
  return [...coverage].sort().map(key => {
    const sep = key.indexOf(OFFERED_KEY_SEP)
    return sep === -1
      ? { model: key }
      : { provider: key.slice(0, sep), model: key.slice(sep + OFFERED_KEY_SEP.length) }
  })
}

/**
 * Default emitter: a single structured audit-log line. Callers inject this by
 * default; tests inject a spy through the same seam.
 */
export const emitHostSpecIncoherenceTolerated: EmitHostSpecIncoherenceTolerated = event => {
  rootLogger.warn(
    {
      module: 'host-write-gate',
      event: HOST_SPEC_INCOHERENCE_TOLERATED_EVENT,
      resourceKind: event.resourceKind,
      namespace: event.namespace,
      name: event.name,
      provider: event.provider,
      model: event.model,
      gate: event.gate,
      offeredBefore: coverageForLog(event.offeredBefore),
      offeredAfter: coverageForLog(event.offeredAfter),
    },
    `tolerated pre-existing model_not_allowed incoherence on ${event.resourceKind} write (no worsening)`
  )
}
