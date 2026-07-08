// Recipe↔Secret ownership boundary (Issue #637). The rule lives in ONE place —
// @clerum/workflow-runtime-core — and is re-exported here so control-api's
// pre-persistence validation and the WRC reconciler share a SINGLE source of
// truth. A WorkflowRecipe may reference a Secret only when it is explicitly
// shared OR owned by that recipe; this prevents a malicious third-party recipe
// from naming another recipe's Secret to exfiltrate credentials. control-api is
// the NON-authoritative defense-in-depth enforcement point; the WRC reconciler
// remains authoritative. Consolidating into the shared package removes the
// previous two-copies-kept-in-lock-step-by-comment arrangement — that
// two-sources-of-truth drift is the exact defect that caused #637.
export {
  OWNER_RECIPE_LABEL_KEY,
  SHARED_LABEL_KEY,
  parseSecretOwnership,
  isSecretAccessibleByRecipe,
} from '@clerum/workflow-runtime-core'
export type { SecretOwnership } from '@clerum/workflow-runtime-core'
