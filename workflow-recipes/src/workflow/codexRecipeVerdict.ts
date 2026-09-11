import {
  CODEX_PROVIDER,
  type CodexCatalogSnapshot,
  type CodexConfigMapView,
  type CodexExecutionProjection,
  snapshotForAssignedCodexGrant,
  toEligiblePolicyBinding,
} from '@clerum/codex-catalog-projection'
import type { WorkflowRecipeSpec } from '../types'
import {
  type CodexProvenance,
  projectRecipeCodexExecution,
  resolveCodexAuthoritativeSpec,
} from './codexExecutionProjection'
import {
  type PluginWorkloadSdkCodexBindingProof,
  mintSdkOnlyCodexBindingProof,
} from './sdkOnlyCodexBinding'

/*
 * ONE Codex verdict per reconcile pass.
 *
 * This seam has been fixed four times across four reviews, and every
 * fix converged one more dimension while leaving another live. The shape of
 * the bug never changed: two consumers answered the same question along
 * different paths, so `readOk` disagreed with `eligibility`, and then
 * `snapshotError` agreed while `provenance` did not.
 *
 * Converging one dimension at a time cannot end, because nothing forbids the
 * next dimension. So this module does not converge dimensions: it removes the
 * possibility of divergence. `projectCodexRecipeVerdict` computes the WHOLE
 * verdict once, from one captured set of inputs, and every consumer — control
 * scopes, scope uncertainty, the execution binding, the configure skip, the
 * Codex-proxy egress decision — reads a FIELD of the returned object.
 *
 * There is deliberately no derived boolean anyone can force, no second
 * projection, and no second read of the reconciler's live allowlist view
 * inside the same pass. The provenance-blind entry points are deleted rather
 * than deprecated, for the same reason `readOk` was deleted: a reachable
 * blind path is an invitation for the sibling to come back.
 */

export type CodexReconcileContext = {
  recipeUid: string
  recipeName: string
  runtimeScopeRecipeName: string
  claimedParent: boolean
  parentSpec: WorkflowRecipeSpec | null
  /**
   * Grant (connection key) the recipe is bound to via the
   * `clerum.io/codex-connection-ref` annotation on the authoritative recipe
   * (the runtime-scope parent when inherited). REQUIRED: an optional key with
   * a `?? unassigned` default at the call site is a silent fallback, and the
   * only producer (`bindCodexReconcileContext`) always fills it.
   */
  connectionKey: string
}

/**
 * The allowlist refresh, captured once by the caller. Passing the view rather
 * than reading `this.codexView` inside is what keeps a concurrently-refreshed
 * snapshot from splitting one pass across two views (scope dimension).
 */
export type CodexAllowlistView = {
  configMap?: CodexConfigMapView
  snapshot: CodexCatalogSnapshot
}

export type CodexRecipeVerdict = {
  readonly provenance: CodexProvenance
  readonly provenanceReason: string
  readonly connectionKey: string
  /** Scope authority: eligibility, derivedScopes, egress, revisions. */
  readonly projection: CodexExecutionProjection
  /**
   * v3 execution binding for the agent this pod runs.
   *
   * Non-null ONLY when `projection.eligibility === 'eligible'` AND
   * `provenance === 'authoritative'`. A null under an eligible projection is a
   * DECISION (the host agent is not Codex, its model is not the eligible one,
   * or the revisions are out of range) — never uncertainty. That asymmetry is
   * the one the type cannot express, so it is asserted in the verdict tests.
   */
  readonly hostBinding: PluginWorkloadSdkCodexBindingProof | null
  readonly hostBindingReason: string
}

export function projectCodexRecipeVerdict(input: {
  ownSpec: WorkflowRecipeSpec
  context: CodexReconcileContext
  hostAgent: { provider: string; model: string } | undefined
  view: CodexAllowlistView
  log?: {
    warn(msg: string, fields?: Record<string, unknown>): void
    debug(msg: string, fields?: Record<string, unknown>): void
  }
}): CodexRecipeVerdict {
  const { context, view } = input
  const resolved = resolveCodexAuthoritativeSpec({
    recipeName: context.recipeName,
    runtimeScopeRecipeName: context.runtimeScopeRecipeName,
    claimedParent: context.claimedParent,
    ownSpec: input.ownSpec,
    parentSpec: context.parentSpec,
  })
  const snapshot = snapshotForAssignedCodexGrant(
    context.connectionKey,
    view.configMap,
    view.snapshot
  )
  const projection = projectRecipeCodexExecution(resolved.spec, snapshot, resolved.provenance)

  const base = {
    provenance: resolved.provenance,
    provenanceReason: resolved.reason,
    connectionKey: context.connectionKey,
    projection,
  } as const

  if (projection.eligibility !== 'eligible') {
    // Warn ONLY for a recipe that actually targets Codex, and
    // only when the doubt is about provenance. An unreadable ConfigMap already
    // produces three warns in `refreshCodexSnapshot`, and it makes EVERY recipe
    // uncertain — including those with no Codex target — because the shared
    // projection checks `snapshotError` before it checks whether the spec has
    // any Codex target at all. Warning there buried the case this line exists
    // to surface: a recipe wedged in awaiting_policy by a stray parent label.
    if (
      projection.eligibility === 'uncertain' &&
      resolved.provenance !== 'authoritative' &&
      input.hostAgent?.provider === CODEX_PROVIDER
    ) {
      input.log?.warn('Codex provenance is undecidable; withholding scope and binding', {
        recipeName: context.recipeName,
        connectionKey: context.connectionKey,
        provenanceReason: resolved.reason,
        reason: projection.reason,
      })
    }
    return { ...base, hostBinding: null, hostBindingReason: projection.reason }
  }

  if (!input.hostAgent || input.hostAgent.provider !== CODEX_PROVIDER) {
    return { ...base, hostBinding: null, hostBindingReason: 'host_agent_not_codex' }
  }

  // Reached only past the provenance + eligibility gate above, and re-parsing
  // the SAME captured ConfigMap deterministically: a derivation of this
  // verdict, not a second source of truth.
  const { binding, reason } = toEligiblePolicyBinding(
    view.configMap,
    context.connectionKey,
    input.hostAgent.model
  )
  if (!binding || binding.catalogRevision < 1 || binding.credentialRevision < 1) {
    const withheld = binding ? 'revision_out_of_range' : reason
    input.log?.debug('Codex execution binding withheld', {
      recipeName: context.recipeName,
      model: input.hostAgent.model,
      connectionKey: context.connectionKey,
      reason: withheld,
    })
    return { ...base, hostBinding: null, hostBindingReason: withheld }
  }
  return { ...base, hostBinding: mintSdkOnlyCodexBindingProof(binding), hostBindingReason: reason }
}
