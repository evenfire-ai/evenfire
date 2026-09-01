import type { McpServerCondition } from '@lib/api'
import {
  PRODUCER_CONDITION_TYPE,
  PRODUCER_FAILURE_STATUS,
  PRODUCER_SUCCESS,
  producerFailure,
} from './producerContract'

/**
 * The ONE place `SecretResolved` test fixtures are built (mini-spec §3).
 *
 * Every `SecretResolved` condition the UI can ever observe is written by the
 * host-context-controller, and by nothing else. Hand-writing the triple at each
 * call site meant the same strings were re-typed in two suites, and a drift in
 * the producer would have to be chased through both — which is exactly how
 * `reason: 'SecretResolved'` (the condition TYPE reused as a reason, a value the
 * producer never emits) survived in the resolver fixtures for two rounds.
 *
 * THESE BUILDERS RESTATE NOTHING (R1-H2).
 *
 * An earlier revision of this file mirrored the producer BY HAND and relied on
 * `../secretResolvedProducerContract.test.ts` to notice when the mirror went
 * stale. That detected drift in one file but did not PROPAGATE it: renaming a
 * reason in the reconciler turned the contract suite red and left the page, the
 * resolver and the invariants suites green, still asserting the old behaviour
 * against fixtures that no controller would ever produce.
 *
 * So the type, the status, the reason and the message SHAPE all come from
 * `./producerContract`, which extracts them from
 * `host-context-controller/src/reconciler.ts` at import time and throws loudly
 * rather than yield a partial contract. A producer change now travels through
 * `getMcpServer` → page → resolver → component, and every suite whose
 * expectation no longer holds goes red on its own terms.
 *
 * The builders name a producer failure by its BRANCH, not by its reason string,
 * so a rename moves the value the fixture carries instead of making the fixture
 * unbuildable:
 *
 * | builder              | producer branch                        |
 * |----------------------|----------------------------------------|
 * | `secretFound`        | the success write (both sites)          |
 * | `secretNotFound`     | `absent` — the k8s 404 read             |
 * | `secretMissingKey`   | `missingKey` — the declared-key check    |
 * | `secretAccessDenied` | `accessDenied` — the k8s 401/403 read   |
 *
 * The producer's fourth failure branch, `readError`, has no builder on purpose;
 * `./producerContract` still extracts and accounts for it, and both it and the
 * contract suite fail if a FIFTH branch ever appears unmodelled.
 *
 * Anything the producer CANNOT emit — a `SecretResolved` at status `Unknown`, a
 * reason carried by the wrong condition type, a malformed or absent
 * `lastTransitionTime` — must come from `syntheticCondition` /
 * `withoutTimestamp` below, which exist precisely so an adversarial fixture is
 * never mistaken for producer shape.
 */

/** The condition type this module builds — the producer's own, derived from the
 *  writes that forward a `validateSecret` failure. Exported so a test can use
 *  the same value instead of re-typing the string. */
export const SECRET_RESOLVED: string = PRODUCER_CONDITION_TYPE

const DEFAULT_SECRET_NAME = 'linear-credentials'
const DEFAULT_NAMESPACE = 'mcp-server'
const DEFAULT_SECRET_KEY = 'workspace-id'
const DEFAULT_ENV_VAR = 'LINEAR_WORKSPACE'

/** Every builder takes the instant the controller stamped the transition at.
 *  It is mandatory: `lastTransitionTime` is the resolver's only recency
 *  evidence, so a fixture that leaves it implicit hides the thing under test. */
type Stamped = { at: string }

/** The producer's success write — the Secret exists and every declared key is
 *  present. Both success sites, managed and WRC-owned, write one triple; the
 *  extraction fails if they ever stop agreeing. */
export function secretFound({ at }: Stamped): McpServerCondition {
  return {
    type: SECRET_RESOLVED,
    status: PRODUCER_SUCCESS.status,
    reason: PRODUCER_SUCCESS.reason,
    message: PRODUCER_SUCCESS.message,
    lastTransitionTime: at,
  }
}

/** The producer's k8s-404 branch: the Secret does not exist. This is the ONLY
 *  condition that may send a managed connector to the create form. */
export function secretNotFound({
  at,
  secretName = DEFAULT_SECRET_NAME,
  namespace = DEFAULT_NAMESPACE,
}: Stamped & { secretName?: string; namespace?: string }): McpServerCondition {
  return {
    type: SECRET_RESOLVED,
    status: PRODUCER_FAILURE_STATUS,
    ...producerFailure('absent', { secretName, namespace }),
    lastTransitionTime: at,
  }
}

/** The producer's declared-key branch: the Secret EXISTS but lacks a key. The
 *  rotate merge-patch adds it, so this must never reach the create form. */
export function secretMissingKey({
  at,
  secretName = DEFAULT_SECRET_NAME,
  secretKey = DEFAULT_SECRET_KEY,
  envVar = DEFAULT_ENV_VAR,
}: Stamped & {
  secretName?: string
  secretKey?: string
  envVar?: string
}): McpServerCondition {
  return {
    type: SECRET_RESOLVED,
    status: PRODUCER_FAILURE_STATUS,
    ...producerFailure('missingKey', { secretName, secretKey, envVar }),
    lastTransitionTime: at,
  }
}

/** The producer's k8s-401/403 branch: the Secret may well exist; HCC could not
 *  read it. No evidence of absence, so this must never reach the create form. */
export function secretAccessDenied({
  at,
  secretName = DEFAULT_SECRET_NAME,
  namespace = DEFAULT_NAMESPACE,
  code = 403,
}: Stamped & { secretName?: string; namespace?: string; code?: number }): McpServerCondition {
  return {
    type: SECRET_RESOLVED,
    status: PRODUCER_FAILURE_STATUS,
    ...producerFailure('accessDenied', { secretName, namespace, code }),
    lastTransitionTime: at,
  }
}

// ─── SYNTHETIC ADVERSARIES — deliberately outside the producer contract ────
//
// Everything above is producer-derived and nothing below is. These two helpers
// build shapes the host-context-controller CANNOT write, and that separation is
// load-bearing: a fixture that is impossible by construction must never be
// mistaken for evidence about what the controller does.
//
// The overrides they take are always hand-written — that is the point of them —
// and `../secretResolvedProducerContract.test.ts` proves, from its own reading
// of the producer, that the shapes they produce are ones the producer never
// writes.

/**
 * SYNTHETIC ADVERSARY — deliberately NOT producer output.
 *
 * Use only for shapes the host-context-controller cannot write but a legacy,
 * hand-edited or partially-reconciled resource can still present to the UI:
 * a `SecretResolved` at status `Unknown`, an absence reason carried by the wrong
 * condition type, a malformed `lastTransitionTime`. Every call site must say in
 * a comment WHY the impossible value is the point of the test.
 *
 * The BASE is the real absence condition, so an adversary that misplaces the
 * absence reason misplaces the producer's actual one rather than a plausible
 * invention; the OVERRIDES on top of it are what make the result impossible.
 */
export function syntheticCondition(
  overrides: Partial<McpServerCondition> & { lastTransitionTime: string }
): McpServerCondition {
  return { ...secretNotFound({ at: overrides.lastTransitionTime }), ...overrides }
}

/**
 * SYNTHETIC ADVERSARY — a condition with NO `lastTransitionTime` at all.
 *
 * The CRD marks the field required and HCC always stamps it, so this cannot
 * come off a live API server; it models a hand-edited resource. The cast is
 * deliberate — the type says `string`, and the resolver must survive the field
 * being absent anyway (mini-spec C3).
 */
export function withoutTimestamp(condition: McpServerCondition): McpServerCondition {
  const rest: Record<string, unknown> = { ...condition }
  delete rest.lastTransitionTime
  return rest as unknown as McpServerCondition
}
