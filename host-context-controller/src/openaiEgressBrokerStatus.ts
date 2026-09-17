/**
 * Host `status.conditions` feedback for the openai-compatible egress broker.
 *
 * validateSlot has several silent-drop paths (cluster-internal target, the
 * fail-closed guard, an unparseable/unsafe URL) and a provision can fail after
 * admission — none of which control-api or control-ui can see, because they run
 * the CIDR-blind classifier and never learn what HCC actually did. This module
 * reflects every one of those outcomes onto a single Host status condition
 * (`OpenAiEgressBrokersReady`), the one place the whole class of drops surfaces,
 * regardless of how the Host was written (control-api, kubectl, GitOps).
 *
 * The write is best-effort (a status-write failure never blocks reconciliation)
 * and dirty-checked against a FRESH read so it does not oscillate: a status write
 * bumps resourceVersion → MODIFIED watch event → a fresh reconcile → which would
 * write again, forever, without the dirty check.
 */
import * as k8s from '@kubernetes/client-node'
import { OAI_EGRESS_BROKERS_CONDITION_TYPE } from '@clerum/egress-policy'
import { hccLogger } from './logger'
import { HostCRD, HostCondition, HostCrdStatus } from './types'
import { getErrorCode } from './utils'

const log = hccLogger.child({ module: 'oai-egress-status' })

const GROUP = 'clerum.io'
const VERSION = 'v1alpha1'
const PLURAL_HOSTS = 'hosts'

/** A slot HCC did NOT provision, with the machine-readable reason. */
export type SlotOutcome = { slotId: string; reason: string }

/** Inputs the condition is derived from for one Host reconcile. */
export type BrokerOutcomes = {
  /** True when the Host declares an openai-compatible primary or fallback. */
  declaresOpenAiCompatible: boolean
  /** Slots that got a broker (validated + provisioned without error). */
  provisioned: number
  /** Slots dropped by validateSlot or failed during provisioning. */
  dropped: SlotOutcome[]
}

/** snake_case (or hyphenated) machine reason → PascalCase condition reason. */
function reasonToPascalCase(reason: string): string {
  return reason
    .split(/[_-]/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

/**
 * The condition HCC wants on `host` given this reconcile's outcomes, or null when
 * the Host declares no openai-compatible slot (the writer then REMOVES any
 * existing condition of this type). `lastTransitionTime` is preserved from the
 * Host's current condition when `status` + `reason` are unchanged, matching the
 * Kubernetes convention (and stampCondition elsewhere in HCC): the timestamp
 * tracks a real transition, not every re-assessment.
 */
export function buildBrokersCondition(
  host: HostCRD,
  outcomes: BrokerOutcomes,
  now: () => Date = () => new Date()
): HostCondition | null {
  if (!outcomes.declaresOpenAiCompatible) return null

  let next: Omit<HostCondition, 'lastTransitionTime'>
  if (outcomes.dropped.length === 0) {
    next = {
      type: OAI_EGRESS_BROKERS_CONDITION_TYPE,
      status: 'True',
      reason: 'AllSlotsProvisioned',
      message: `${outcomes.provisioned} broker(s) provisioned`,
    }
  } else {
    // reason = the FIRST drop (in slot order: primary, then fallbacks); the
    // message enumerates every dropped slot so an operator sees all of them.
    next = {
      type: OAI_EGRESS_BROKERS_CONDITION_TYPE,
      status: 'False',
      reason: reasonToPascalCase(outcomes.dropped[0].reason),
      message: outcomes.dropped.map(d => `${d.slotId}: ${d.reason}`).join('; '),
    }
  }

  const prior = host.status?.conditions?.find(c => c.type === OAI_EGRESS_BROKERS_CONDITION_TYPE)
  const priorTransitionTime =
    prior !== undefined && prior.status === next.status && prior.reason === next.reason
      ? prior.lastTransitionTime
      : undefined
  return { ...next, lastTransitionTime: priorTransitionTime ?? now().toISOString() }
}

/** Two conditions are equivalent for the dirty check ignoring lastTransitionTime. */
function conditionEquivalent(a: HostCondition, b: HostCondition): boolean {
  return a.status === b.status && a.reason === b.reason && a.message === b.message
}

async function readFreshHost(customApi: k8s.CustomObjectsApi, host: HostCRD): Promise<HostCRD> {
  const response = await customApi.getNamespacedCustomObject({
    group: GROUP,
    version: VERSION,
    namespace: host.namespace,
    plural: PLURAL_HOSTS,
    name: host.name,
  })
  const obj = response as {
    metadata: { name: string; namespace?: string; uid?: string; resourceVersion?: string }
    spec: HostCRD['spec']
    status?: HostCrdStatus
  }
  return {
    name: obj.metadata.name,
    namespace: obj.metadata.namespace ?? host.namespace,
    uid: obj.metadata.uid,
    resourceVersion: obj.metadata.resourceVersion,
    spec: obj.spec,
    status: obj.status,
  }
}

/**
 * Reflect the broker outcome onto the Host status condition. `build` is evaluated
 * against a FRESH read so lastTransitionTime is stable and a 409 retry re-derives
 * against the winning resourceVersion. Best-effort: any error (including retry
 * exhaustion) is logged, never thrown — the caller's reconcile must not fail on a
 * status write. Preserves every OTHER condition (e.g. the stateless-lifecycle
 * conditions another writer owns) and writes under a resourceVersion precondition.
 */
export async function writeBrokersCondition(
  customApi: k8s.CustomObjectsApi,
  host: HostCRD,
  build: (fresh: HostCRD) => HostCondition | null
): Promise<void> {
  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let fresh: HostCRD
    try {
      fresh = await readFreshHost(customApi, host)
    } catch (err) {
      log.error('Failed to read Host for broker status condition write', {
        host: host.name,
        err,
      })
      return
    }

    const freshConditions = fresh.status?.conditions ?? []
    const existing = freshConditions.find(c => c.type === OAI_EGRESS_BROKERS_CONDITION_TYPE)
    const others = freshConditions.filter(c => c.type !== OAI_EGRESS_BROKERS_CONDITION_TYPE)
    const next = build(fresh)

    let conditions: HostCondition[]
    if (next === null) {
      // Host no longer declares openai-compatible: remove our condition. Nothing
      // to remove ⇒ no write (no needless MODIFIED churn).
      if (!existing) return
      conditions = others
    } else {
      // Dirty check: an equivalent condition already present ⇒ no write. This is
      // what breaks the status-write → MODIFIED → reconcile → status-write loop.
      if (existing && conditionEquivalent(existing, next)) return
      conditions = [...others, next]
    }

    const ops: Array<{ op: 'add'; path: string; value: unknown }> = []
    if (fresh.resourceVersion !== undefined) {
      ops.push({ op: 'add', path: '/metadata/resourceVersion', value: fresh.resourceVersion })
    }
    const status = fresh.status
    if (
      status === undefined ||
      (status.lifecycle === undefined && status.conditions === undefined)
    ) {
      // A Host with no /status yet: `add /status/conditions` would fail on the
      // missing parent, so seed the whole subresource once (mirrors HCC's
      // lifecycle writer). Preserve any other status members already present.
      ops.push({ op: 'add', path: '/status', value: { ...(status ?? {}), conditions } })
    } else {
      ops.push({ op: 'add', path: '/status/conditions', value: conditions })
    }

    try {
      await customApi.patchNamespacedCustomObjectStatus({
        group: GROUP,
        version: VERSION,
        namespace: host.namespace,
        plural: PLURAL_HOSTS,
        name: host.name,
        body: ops,
      })
      return
    } catch (err) {
      if (getErrorCode(err) === 409 && attempt < maxAttempts) {
        // The CR changed under us; re-read fresh and re-derive on the next loop.
        continue
      }
      log.error('Failed to write broker status condition', {
        host: host.name,
        code: getErrorCode(err) ?? 'none',
        err,
      })
      return
    }
  }
}
