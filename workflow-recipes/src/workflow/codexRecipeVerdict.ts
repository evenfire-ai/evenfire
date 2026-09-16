import {
  CODEX_PROVIDER,
  CODEX_UNASSIGNED_CONNECTION_KEY,
  type CodexCatalogSnapshot,
  type CodexConfigMapView,
  type CodexExecutionProjection,
  GROK_PROVIDER,
  parseGrokAllowedModelsSnapshot,
  projectGrokExecution,
  snapshotForAssignedCodexGrant,
  toEligibleGrokPolicyBinding,
  toEligiblePolicyBinding,
} from '@clerum/codex-catalog-projection'
import type { WorkflowRecipeSpec } from '../types'
import {
  type CodexProvenance,
  projectRecipeCodexExecution,
  recipeToCodexHostSpec,
  resolveCodexAuthoritativeSpec,
} from './codexExecutionProjection'
import {
  type PluginWorkloadSdkCodexBindingProof,
  mintSdkOnlyCodexBindingProof,
} from './sdkOnlyCodexBinding'
import { mintSdkOnlyGrokBindingProof } from './sdkOnlyGrokBinding'

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
  /**
   * Canonical Grok grant key. Codex alias leftovers fail closed to
   * `unassigned` at the reader. Optional so existing Codex-only callers
   * keep compiling; missing is `unassigned` and cannot spend Grok.
   */
  grokConnectionKey?: string
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
  readonly grokProjection: CodexExecutionProjection & { requiresGrokProxyEgress: boolean }
  readonly grokBinding: PluginWorkloadSdkCodexBindingProof | null
  readonly grokBindingReason: string
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
  const grokKey = context.grokConnectionKey ?? CODEX_UNASSIGNED_CONNECTION_KEY
  const grokSnapshot = parseGrokAllowedModelsSnapshot(view.configMap, grokKey)
  const grokRaw = projectGrokExecution(recipeToCodexHostSpec(resolved.spec), grokSnapshot)
  const grokProjection =
    resolved.provenance === 'authoritative'
      ? grokRaw
      : {
          ...grokRaw,
          eligibleTargets: [],
          derivedScopes: [],
          requiresGrokProxyEgress: false,
          eligibility: 'uncertain' as const,
          reason: 'provenance_uncertain',
        }

  const hostBinding = mintCodexHostBinding({
    hostAgent: input.hostAgent,
    connectionKey: context.connectionKey,
    view,
    projection,
    log: input.log,
  })
  const grokBinding = mintGrokHostBinding({
    hostAgent: input.hostAgent,
    grokKey,
    view,
    grokProjection,
    log: input.log,
  })

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

  return {
    provenance: resolved.provenance,
    provenanceReason: resolved.reason,
    connectionKey: context.connectionKey,
    projection,
    grokProjection,
    hostBinding: hostBinding.binding,
    hostBindingReason: hostBinding.reason,
    grokBinding: grokBinding.binding,
    grokBindingReason: grokBinding.reason,
  }
}

function mintCodexHostBinding(input: {
  hostAgent: { provider: string; model: string } | undefined
  connectionKey: string
  view: CodexAllowlistView
  projection: CodexExecutionProjection
  log?: { debug(msg: string, fields?: Record<string, unknown>): void }
}): { binding: PluginWorkloadSdkCodexBindingProof | null; reason: string } {
  if (input.projection.eligibility !== 'eligible') {
    return { binding: null, reason: input.projection.reason }
  }
  if (!input.hostAgent || input.hostAgent.provider !== CODEX_PROVIDER) {
    return { binding: null, reason: 'host_agent_not_codex' }
  }
  const minted = toEligiblePolicyBinding(
    input.view.configMap,
    input.connectionKey,
    input.hostAgent.model
  )
  if (
    !minted.binding ||
    minted.binding.catalogRevision < 1 ||
    minted.binding.credentialRevision < 1
  ) {
    const withheld = minted.binding ? 'revision_out_of_range' : minted.reason
    input.log?.debug('Codex execution binding withheld', {
      model: input.hostAgent.model,
      connectionKey: input.connectionKey,
      reason: withheld,
    })
    return { binding: null, reason: withheld }
  }
  return { binding: mintSdkOnlyCodexBindingProof(minted.binding), reason: minted.reason }
}

function mintGrokHostBinding(input: {
  hostAgent: { provider: string; model: string } | undefined
  grokKey: string
  view: CodexAllowlistView
  grokProjection: CodexExecutionProjection
  log?: { debug(msg: string, fields?: Record<string, unknown>): void }
}): { binding: PluginWorkloadSdkCodexBindingProof | null; reason: string } {
  if (input.grokKey === CODEX_UNASSIGNED_CONNECTION_KEY) {
    return { binding: null, reason: 'unassigned' }
  }
  if (input.grokProjection.eligibility !== 'eligible') {
    return { binding: null, reason: input.grokProjection.reason }
  }
  if (!input.hostAgent || input.hostAgent.provider !== GROK_PROVIDER) {
    return { binding: null, reason: 'host_agent_not_grok' }
  }
  const minted = toEligibleGrokPolicyBinding(
    input.view.configMap,
    input.grokKey,
    input.hostAgent.model
  )
  if (
    !minted.binding ||
    minted.binding.catalogRevision < 1 ||
    minted.binding.credentialRevision < 1
  ) {
    const withheld = minted.binding ? 'revision_out_of_range' : minted.reason
    input.log?.debug('Grok execution binding withheld', {
      model: input.hostAgent.model,
      connectionKey: input.grokKey,
      reason: withheld,
    })
    return { binding: null, reason: withheld }
  }
  return { binding: mintSdkOnlyGrokBindingProof(minted.binding), reason: minted.reason }
}
