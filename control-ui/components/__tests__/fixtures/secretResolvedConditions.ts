import type { McpServerCondition } from '@lib/api'

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
 * Producer sites, all in `host-context-controller/src/reconciler.ts`:
 *
 * | builder             | type            | status  | reason              | written at |
 * |---------------------|-----------------|---------|---------------------|------------|
 * | `secretFound`       | SecretResolved  | 'True'  | 'SecretFound'       | :1981 (managed), :2063 (WRC-owned) |
 * | `secretNotFound`    | SecretResolved  | 'False' | 'SecretNotFound'    | :1872 / :2041, reason from validateSecret :468-472 |
 * | `secretMissingKey`  | SecretResolved  | 'False' | 'SecretMissingKey'  | :1872 / :2041, reason from validateSecret :456-459 |
 * | `secretAccessDenied`| SecretResolved  | 'False' | 'SecretAccessDenied'| :1872 / :2041, reason from validateSecret :474-479 |
 *
 * The messages are copied from the same producer branches, so a fixture reads
 * like a real resource dump rather than an approximation of one.
 *
 * Anything the producer CANNOT emit — a `SecretResolved` at status `Unknown`, a
 * reason carried by the wrong condition type, a malformed or absent
 * `lastTransitionTime` — must come from `syntheticCondition` /
 * `withoutTimestamp` below, which exist precisely so an adversarial fixture is
 * never mistaken for producer shape.
 */

/** The condition type this module builds. Exported so a test can assert against
 *  the same constant instead of re-typing the string. */
export const SECRET_RESOLVED = 'SecretResolved'

const DEFAULT_SECRET_NAME = 'linear-credentials'
const DEFAULT_NAMESPACE = 'mcp-server'
const DEFAULT_SECRET_KEY = 'workspace-id'
const DEFAULT_ENV_VAR = 'LINEAR_WORKSPACE'

/** Every builder takes the instant the controller stamped the transition at.
 *  It is mandatory: `lastTransitionTime` is the resolver's only recency
 *  evidence, so a fixture that leaves it implicit hides the thing under test. */
type Stamped = { at: string }

/** `SecretResolved=True` — the Secret exists and every declared key is present.
 *  reconciler.ts:1981 (managed) and :2063 (WRC-owned) write this exact triple. */
export function secretFound({ at }: Stamped): McpServerCondition {
  return {
    type: SECRET_RESOLVED,
    status: 'True',
    reason: 'SecretFound',
    message: 'Secret resolved and validated',
    lastTransitionTime: at,
  }
}

/** `SecretResolved=False/SecretNotFound` — the Secret does not exist. This is
 *  the ONLY condition that may send a managed connector to the create form.
 *  Message from reconciler.ts:468 (the k8s 404 branch of validateSecret). */
export function secretNotFound({
  at,
  secretName = DEFAULT_SECRET_NAME,
  namespace = DEFAULT_NAMESPACE,
}: Stamped & { secretName?: string; namespace?: string }): McpServerCondition {
  return {
    type: SECRET_RESOLVED,
    status: 'False',
    reason: 'SecretNotFound',
    message: `Secret "${secretName}" not found in namespace "${namespace}"`,
    lastTransitionTime: at,
  }
}

/** `SecretResolved=False/SecretMissingKey` — the Secret EXISTS but lacks a
 *  declared key. The rotate merge-patch adds it, so this must never reach the
 *  create form. Message from reconciler.ts:456-457. */
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
    status: 'False',
    reason: 'SecretMissingKey',
    message:
      `Secret "${secretName}" is missing required key "${secretKey}" ` +
      `(needed for env var ${envVar})`,
    lastTransitionTime: at,
  }
}

/** `SecretResolved=False/SecretAccessDenied` — the Secret may well exist; HCC
 *  could not read it (k8s 401/403). Message from reconciler.ts:476-477. */
export function secretAccessDenied({
  at,
  secretName = DEFAULT_SECRET_NAME,
  namespace = DEFAULT_NAMESPACE,
  code = 403,
}: Stamped & { secretName?: string; namespace?: string; code?: number }): McpServerCondition {
  return {
    type: SECRET_RESOLVED,
    status: 'False',
    reason: 'SecretAccessDenied',
    message:
      `Access denied reading Secret "${secretName}" in namespace "${namespace}" ` +
      `(K8s API ${code})`,
    lastTransitionTime: at,
  }
}

/**
 * SYNTHETIC ADVERSARY — deliberately NOT producer output.
 *
 * Use only for shapes the host-context-controller cannot write but a legacy,
 * hand-edited or partially-reconciled resource can still present to the UI:
 * a `SecretResolved` at status `Unknown`, an absence reason carried by the wrong
 * condition type, a malformed `lastTransitionTime`. Every call site must say in
 * a comment WHY the impossible value is the point of the test.
 *
 * Defaults to the `SecretNotFound` triple so a call only has to state the one
 * field it is adversarial about.
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
