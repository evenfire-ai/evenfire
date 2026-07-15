// Issue #637 back-fill planner — stamps `clerum.io/owner-recipe=<recipe>` on
// pre-existing recipe Secrets that were created before the ownership-label model
// and are therefore UNLABELED. The #637 fail-closed gate denies unlabeled
// envSecret / imagePullSecrets / snippet capability Secrets at reconcile time,
// which silently breaks any recipe whose credential Secrets predate the model
// (e.g. leadforge-mcp-credentials). New Secrets created via control-api's
// /admin/recipe-secrets are already labeled; only legacy / `kubectl
// apply`-created Secrets need this.
//
// CORRECTNESS: this planner mirrors the reconciler's two authoritative rules so it
// cannot drift from enforcement:
//   1. Workload→namespace resolution — identical to
//      WorkflowRecipeReconciler.resolveWorkloadNamespace (transport→mcp-server,
//      ui workloadRef→sandbox-ui, else→sandbox-recipes).
//   2. Ownership label keys — imported from @clerum/workflow-runtime-core, the
//      SINGLE source of truth shared with the reconciler and control-api.
//
// SAFETY: a Secret is stamped ONLY when it is (a) currently unlabeled (neither
// owner nor shared key present) AND (b) referenced by EXACTLY ONE recipe in the
// namespace it resolves to. A Secret referenced by 2+ recipes is `ambiguous`
// (could be a legitimate shared Secret an operator must mark `clerum.io/shared`,
// or the exact cross-recipe reference #637 guards against) and is never
// auto-claimed. Already-labeled Secrets (including those owned by a different
// recipe, or conflicting owner+shared) are left untouched.
import {
  OWNER_RECIPE_LABEL_KEY,
  SHARED_LABEL_KEY,
  parseSecretOwnership,
} from '@clerum/workflow-runtime-core'

export interface BackfillNamespaces {
  mcpServer: string
  sandboxUi: string
  sandbox: string
}

/** Minimal structural shape of a recipe workload (decoupled from WorkloadDef). */
export interface BackfillWorkload {
  id: string
  transport?: unknown
  envSecret?: { name?: string }
  imagePullSecrets?: string[]
}

export interface BackfillSnippetSecretRef {
  name: string
}

export interface BackfillRecipe {
  name: string
  uiWorkloadRef?: string
  workloads: BackfillWorkload[]
  snippetSecrets?: BackfillSnippetSecretRef[]
}

/** Returns the Secret's labels, or null when the Secret does not exist (missing). */
export type SecretLabelReader = (namespace: string, name: string) => Record<string, string> | null

export interface BackfillPlan {
  /** Unlabeled + single-owner — safe to stamp owner-recipe. */
  stamp: Array<{ namespace: string; secret: string; ownerRecipe: string }>
  /** Unlabeled but referenced by >1 recipe — needs an operator decision. */
  ambiguous: Array<{ namespace: string; secret: string; recipes: string[] }>
  /** Already carries an ownership label — left as-is. */
  alreadyLabeled: Array<{ namespace: string; secret: string; ownership: string }>
  /** Not found in its referenced namespace — kubelet-deferred, left as-is. */
  missing: Array<{ namespace: string; secret: string }>
}

/**
 * Mirror of WorkflowRecipeReconciler.resolveWorkloadNamespace. `uiWorkloadRef` is
 * the recipe's `spec.ui?.workloadRef`.
 */
export function resolveWorkloadNamespace(
  workload: BackfillWorkload,
  uiWorkloadRef: string | undefined,
  ns: BackfillNamespaces
): string {
  if (workload.transport) return ns.mcpServer
  if (uiWorkloadRef && workload.id === uiWorkloadRef) return ns.sandboxUi
  return ns.sandbox
}

/**
 * Map raw `kubectl get workflowrecipes -o json` items to the structural
 * {@link BackfillRecipe} shape the planner consumes. Pulls `spec.ui.workloadRef`
 * (drives the sandbox-ui namespace resolution), each workload's Secret refs, and
 * snippet capability Secret refs.
 */
export function mapRecipeListToBackfillRecipes(items: unknown[]): BackfillRecipe[] {
  return (items ?? []).map(raw => {
    const item = raw as {
      metadata?: { name?: string }
      spec?: {
        ui?: { workloadRef?: string }
        workloads?: Array<{
          id: string
          transport?: unknown
          envSecret?: { name?: string }
          imagePullSecrets?: string[]
        }>
        steps?: Array<{
          run?: {
            type?: string
            capabilities?: {
              secrets?: Array<{ secretRef?: { name?: string; key?: string } }>
            }
          }
        }>
      }
    }
    const snippetSecrets = collectSnippetSecretRefs(item.spec?.steps ?? []).map(s => ({
      name: s.name,
    }))
    return {
      name: item.metadata?.name ?? '',
      uiWorkloadRef: item.spec?.ui?.workloadRef,
      workloads: (item.spec?.workloads ?? []).map(w => ({
        id: w.id,
        transport: w.transport,
        envSecret: w.envSecret,
        imagePullSecrets: w.imagePullSecrets,
      })),
      ...(snippetSecrets.length > 0 ? { snippetSecrets } : {}),
    }
  })
}

function collectSnippetSecretRefs(
  steps: Array<{
    run?: {
      type?: string
      capabilities?: { secrets?: Array<{ secretRef?: { name?: string; key?: string } }> }
    }
  }>
): BackfillSnippetSecretRef[] {
  const byRef = new Map<string, BackfillSnippetSecretRef>()
  for (const step of steps) {
    const run = step.run
    if (run?.type !== 'snippet') continue
    for (const item of run.capabilities?.secrets ?? []) {
      const name = item.secretRef?.name
      if (!name) continue
      const key = item.secretRef?.key ?? ''
      byRef.set(`${name}/${key}`, { name })
    }
  }
  return [...byRef.values()]
}

/**
 * True when `context` names a protected production cluster — mirror of
 * post-deploy-sync.sh's is_prod_context. Used to gate `--apply` behind
 * CONFIRM=yes. dev / test / minikube / kind and unrelated (non-clerum) contexts
 * are NOT prod.
 */
export function isProdContext(context: string): boolean {
  if (!context) return false
  if (
    context.includes('example-dev') ||
    context.includes('clerum-test') ||
    context.includes('minikube') ||
    context.includes('kind')
  ) {
    return false
  }
  return context.includes('clerum')
}

/** True when the Secret has neither ownership label key present (legacy-unlabeled). */
export function isUnlabeled(labels: Record<string, string>): boolean {
  return !(OWNER_RECIPE_LABEL_KEY in labels) && !(SHARED_LABEL_KEY in labels)
}

function describeOwnership(labels: Record<string, string>): string {
  const o = parseSecretOwnership(labels)
  if (o.kind === 'owner-recipe') return `owner-recipe:${o.recipeName}`
  if (o.kind === 'shared') return 'shared'
  // parseSecretOwnership collapses conflicting owner+shared to 'unlabeled', but a
  // raw label IS present, so report it as a conflict rather than as bare.
  return 'conflict'
}

const SEP = '0000'

/**
 * Compute the back-fill plan from the live recipe set and a Secret-label reader.
 * Pure — all cluster I/O is injected via `getSecretLabels`.
 */
export function planSecretOwnershipBackfill(
  recipes: BackfillRecipe[],
  ns: BackfillNamespaces,
  getSecretLabels: SecretLabelReader
): BackfillPlan {
  // Build (namespace, secretName) → set of referencing recipe names, preserving
  // first-seen order so the plan is deterministic.
  const refs = new Map<string, string[]>()
  const order: string[] = []
  const addRef = (namespace: string, name: string, recipe: string) => {
    const key = `${namespace}${SEP}${name}`
    let recipesForKey = refs.get(key)
    if (!recipesForKey) {
      recipesForKey = []
      refs.set(key, recipesForKey)
      order.push(key)
    }
    if (!recipesForKey.includes(recipe)) recipesForKey.push(recipe)
  }

  for (const recipe of recipes) {
    for (const w of recipe.workloads ?? []) {
      const wns = resolveWorkloadNamespace(w, recipe.uiWorkloadRef, ns)
      if (w.envSecret?.name) addRef(wns, w.envSecret.name, recipe.name)
      for (const pull of w.imagePullSecrets ?? []) addRef(wns, pull, recipe.name)
    }
    for (const snippet of recipe.snippetSecrets ?? []) {
      addRef(ns.sandbox, snippet.name, recipe.name)
    }
  }

  const plan: BackfillPlan = { stamp: [], ambiguous: [], alreadyLabeled: [], missing: [] }
  for (const key of order) {
    const [namespace, secret] = key.split(SEP)
    const recipesForKey = refs.get(key)!
    const labels = getSecretLabels(namespace, secret)
    if (labels === null) {
      plan.missing.push({ namespace, secret })
      continue
    }
    if (!isUnlabeled(labels)) {
      plan.alreadyLabeled.push({ namespace, secret, ownership: describeOwnership(labels) })
      continue
    }
    if (recipesForKey.length === 1) {
      plan.stamp.push({ namespace, secret, ownerRecipe: recipesForKey[0] })
    } else {
      plan.ambiguous.push({ namespace, secret, recipes: recipesForKey })
    }
  }
  return plan
}
