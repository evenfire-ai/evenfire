import type { McpServerCondition } from '@lib/api'
import {
  EGRESS_PRODUCER_CONDITION_TYPE,
  EGRESS_PRODUCER_REFUSAL,
  EGRESS_PRODUCER_WITHIN_CLASS,
  egressProducerRefusalMessage,
} from './producerContract'

/**
 * The ONE place egress-proxy preflight conditions are built for tests.
 *
 * The rollout wait reads the preflight verdict off the McpServer CRD, and
 * every such condition is written by the host-context-controller. This module
 * restates none of it: the type, both statuses, both reasons and both message
 * shapes come from `./producerContract`, which extracts them from the
 * reconciler source at import time and throws rather than yield a partial
 * contract. The hand-written fixture this replaced had already drifted from
 * the producer's refusal wording while every suite stayed green; with the
 * values derived, a producer change travels into the mocked `getMcpServer`
 * answers and the suites asserting the old behaviour go red.
 *
 * `../secretResolvedProducerContract.test.ts` re-derives the same pair from
 * its own independent reading of the producer and pins the values, so a
 * rename fails there even where the UI itself only compares the status.
 */

/** The condition type this module builds — the producer's own, derived from
 *  its block verdict rather than re-typed here. */
export const EGRESS_PROXY_VALUES_VALID: string = EGRESS_PRODUCER_CONDITION_TYPE

const DEFAULT_PLACEHOLDER = 'API_KEY'
const DEFAULT_SECRET_NAME = 'remote-creds'
const DEFAULT_SECRET_KEY = 'api-key'

/** The instant the controller stamped the transition at, plus the generation
 *  it observed when the fixture models a current-generation verdict. Omitting
 *  `observedGeneration` models a condition written before the producer
 *  stamped one — the rollout wait must not read it as this write's verdict. */
type Stamped = { at: string; observedGeneration?: number }

function observed({ observedGeneration }: Stamped): Pick<McpServerCondition, 'observedGeneration'> {
  return observedGeneration === undefined ? {} : { observedGeneration }
}

/**
 * The block path's refusal: one query-position Secret value outside its
 * class. The message is the producer's own rendering for that single
 * violation — placeholder, Secret and key are the only variables in it.
 */
export function egressValuesRefused({
  at,
  observedGeneration,
  placeholder = DEFAULT_PLACEHOLDER,
  secretName = DEFAULT_SECRET_NAME,
  secretKey = DEFAULT_SECRET_KEY,
}: Stamped & {
  placeholder?: string
  secretName?: string
  secretKey?: string
}): McpServerCondition {
  return {
    type: EGRESS_PROXY_VALUES_VALID,
    status: EGRESS_PRODUCER_REFUSAL.status,
    reason: EGRESS_PRODUCER_REFUSAL.reason,
    message: egressProducerRefusalMessage({ placeholder, secretName, secretKey }),
    lastTransitionTime: at,
    ...observed({ at, observedGeneration }),
  }
}

/** The managed reconcile's pass: every substituted value is within its class. */
export function egressValuesWithinClass({ at, observedGeneration }: Stamped): McpServerCondition {
  return {
    type: EGRESS_PROXY_VALUES_VALID,
    status: EGRESS_PRODUCER_WITHIN_CLASS.status,
    reason: EGRESS_PRODUCER_WITHIN_CLASS.reason,
    message: EGRESS_PRODUCER_WITHIN_CLASS.message,
    lastTransitionTime: at,
    ...observed({ at, observedGeneration }),
  }
}
