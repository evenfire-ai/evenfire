// Recipe↔Secret ownership boundary (Issue #637) — the SINGLE source of truth for
// "may this recipe reference this Secret?", shared by every enforcement point:
// the WRC reconciler (authoritative, workflow-recipes) and control-api's
// pre-persistence validation (defense-in-depth, non-authoritative). A
// WorkflowRecipe may reference a Secret only when it is explicitly shared OR owned
// by that recipe — this stops a third-party recipe from naming another recipe's
// Secret to exfiltrate credentials into its own runtime.
//
// This lives in @clerum/workflow-runtime-core (not copied per service) precisely
// so the rule cannot drift between the two enforcement points. A two-sources-of-
// truth drift between Secret-projection surfaces is the exact defect that caused
// #637, so the fix must not reintroduce one.

export const OWNER_RECIPE_LABEL_KEY = 'clerum.io/owner-recipe'
export const SHARED_LABEL_KEY = 'clerum.io/shared'

export type SecretOwnership =
  | { kind: 'shared' }
  | { kind: 'owner-recipe'; recipeName: string }
  | { kind: 'unlabeled' }

export function parseSecretOwnership(labels: Record<string, string> | undefined): SecretOwnership {
  const l = labels ?? {}
  const owner = l[OWNER_RECIPE_LABEL_KEY]
  const shared = l[SHARED_LABEL_KEY] === 'true'
  // Conflicting labels (owner AND shared) → treat as unlabeled so access is
  // refused until an operator picks one. Fail closed rather than silently
  // privileging one label over the other.
  if (owner && shared) return { kind: 'unlabeled' }
  if (shared) return { kind: 'shared' }
  if (owner) return { kind: 'owner-recipe', recipeName: owner }
  return { kind: 'unlabeled' }
}

/** True only when the Secret is shared or owned by `recipeName`. */
export function isSecretAccessibleByRecipe(
  labels: Record<string, string> | undefined,
  recipeName: string
): boolean {
  const o = parseSecretOwnership(labels)
  if (o.kind === 'shared') return true
  if (o.kind === 'owner-recipe') return o.recipeName === recipeName
  return false
}
