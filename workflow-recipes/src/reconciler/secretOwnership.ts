// Recipe-secret ownership model — paired with control-api's POST
// /admin/recipe-secrets. Every recipe Secret in `sandbox-recipes` must carry
// exactly one of these labels; an envSecret reference is honored only when
// the Secret is shared OR explicitly owned by the requesting recipe. This
// prevents a malicious third-party recipe from referencing another recipe's
// Secret by name to exfiltrate credentials into its own env vars.
//
// The ownership PREDICATE (label constants + parseSecretOwnership /
// isSecretAccessibleByRecipe) now lives in @clerum/workflow-runtime-core — the
// SINGLE source of truth shared with control-api's pre-persistence check — so the
// rule cannot drift between the two enforcement points (the two-sources-of-truth
// drift is the exact defect that caused #637). The K8s-client-aware classification
// below (classifySecretAccess / combineSecretAccess) stays here because it depends
// on a caller-injected Secret reader.
import {
  OWNER_RECIPE_LABEL_KEY,
  SHARED_LABEL_KEY,
  isSecretAccessibleByRecipe,
  parseSecretOwnership,
} from '@clerum/workflow-runtime-core'
import type { SecretAccess } from './resourceBuilder'

// Re-export the shared predicate so in-service consumers keep importing it from
// this module unchanged (single import surface for the reconciler).
export {
  OWNER_RECIPE_LABEL_KEY,
  SHARED_LABEL_KEY,
  parseSecretOwnership,
  isSecretAccessibleByRecipe,
}
export type { SecretOwnership } from '@clerum/workflow-runtime-core'

/** Minimal shape of a read Secret needed to classify access. */
interface ReadSecretLike {
  metadata?: { labels?: Record<string, string> }
  data?: Record<string, string>
  stringData?: Record<string, string>
}

/**
 * Single source of truth (Issue #637) for "may this recipe project this Secret?"
 * across EVERY Secret-projection surface: envSecret render, imagePullSecrets,
 * the McpServer CRD copy for transport workloads, and snippet capability secrets.
 * Reads the Secret in the given namespace and classifies ownership into the
 * `SecretAccess` state machine so no surface re-derives the rule and drifts —
 * the two-sources-of-truth drift between the envSecret and webhook paths is the
 * exact defect that caused #637.
 *
 * `read` / `getErrorCode` are injected so this module stays free of a hard
 * `@kubernetes/client-node` dependency and matches each caller's K8s client.
 * A non-404 read failure is classified `error` (ownership UNVERIFIED) — callers
 * must fail closed (never project) and requeue, never treat it as `accessible`.
 */
export async function classifySecretAccess(
  read: (name: string, namespace: string) => Promise<ReadSecretLike>,
  getErrorCode: (err: unknown) => number | undefined,
  secretName: string,
  namespace: string,
  recipeName: string
): Promise<SecretAccess> {
  try {
    const secret = await read(secretName, namespace)
    if (!isSecretAccessibleByRecipe(secret.metadata?.labels, recipeName)) {
      return { state: 'denied' }
    }
    const keys = new Set<string>([
      ...Object.keys(secret.data ?? {}),
      ...Object.keys(secret.stringData ?? {}),
    ])
    return { state: 'accessible', keys }
  } catch (err) {
    if (getErrorCode(err) === 404) return { state: 'missing' }
    return { state: 'error' }
  }
}

/**
 * Issue #637 (cross-namespace collision) — combine the {@link SecretAccess}
 * verdicts for the SAME Secret NAME classified in MULTIPLE namespaces. The same
 * name can be referenced by workloads that resolve to different runtime
 * namespaces (transport → `mcp-server`, ui → `sandbox-ui`, rest →
 * `sandbox-recipes`), so a single name→namespace map (classifying the name in
 * only one of them) lets a workload listed first mask a foreign Secret that lives
 * in another workload's namespace.
 *
 * Fail-closed precedence: `denied` > `error` > `accessible` > `missing`. A name
 * `denied` (foreign / unlabeled) in ANY namespace is denied everywhere; a name
 * whose ownership could not be verified (`error`) in any namespace requeues. Only
 * when NO namespace denies/errors is the name `accessible` (visible keys unioned,
 * which affects optional-key skipping only — never the security decision) or, if
 * absent everywhere it is read, `missing` (kubelet-deferred).
 */
export function combineSecretAccess(a: SecretAccess, b: SecretAccess): SecretAccess {
  const rank = (s: SecretAccess['state']): number =>
    s === 'denied' ? 0 : s === 'error' ? 1 : s === 'accessible' ? 2 : 3
  const worst = rank(a.state) <= rank(b.state) ? a : b
  const other = worst === a ? b : a
  if (worst.state === 'accessible' && other.state === 'accessible') {
    return { state: 'accessible', keys: new Set<string>([...worst.keys, ...other.keys]) }
  }
  return worst
}
