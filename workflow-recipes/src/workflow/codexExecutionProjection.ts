import {
  collectCodexTargets,
  projectCodexExecution as projectSharedCodexExecution,
} from '@clerum/codex-catalog-projection'
import type {
  CodexCatalogSnapshot,
  CodexExecutionProjection,
} from '@clerum/codex-catalog-projection'
import type { WorkflowRecipeSpec } from '../types'

export {
  CODEX_EXECUTE_SCOPE,
  CODEX_PROVIDER,
  collectCodexTargets,
  projectCodexExecution,
} from '@clerum/codex-catalog-projection'
export type {
  CodexCatalogSnapshot,
  CodexEligibility,
  CodexExecutionProjection,
  CodexHostSpec,
  CodexSnapshotError,
  CodexTarget,
  CodexTargetSource,
} from '@clerum/codex-catalog-projection'

export type CodexProvenance = 'authoritative' | 'uncertain'

export function recipeToCodexHostSpec(spec: WorkflowRecipeSpec) {
  const allowedModels: Array<{ provider?: string; model?: string }> = []
  for (const step of spec.steps ?? []) {
    if (step.agent?.provider) {
      allowedModels.push({ provider: step.agent.provider, model: step.agent.model })
    }
  }
  return {
    model: spec.agent ? { provider: spec.agent.provider, name: spec.agent.model } : undefined,
    allowedModels,
  }
}

export function resolveCodexAuthoritativeSpec(input: {
  recipeName: string
  runtimeScopeRecipeName: string
  claimedParent: boolean
  ownSpec: WorkflowRecipeSpec
  parentSpec: WorkflowRecipeSpec | null
}): { spec: WorkflowRecipeSpec; provenance: CodexProvenance; reason: string } {
  if (input.claimedParent && input.runtimeScopeRecipeName === input.recipeName) {
    return { spec: input.ownSpec, provenance: 'uncertain', reason: 'parent_provenance_rejected' }
  }
  if (input.runtimeScopeRecipeName !== input.recipeName) {
    if (!input.parentSpec) {
      return { spec: input.ownSpec, provenance: 'uncertain', reason: 'parent_spec_unavailable' }
    }
    return { spec: input.parentSpec, provenance: 'authoritative', reason: 'inherited_parent' }
  }
  return { spec: input.ownSpec, provenance: 'authoritative', reason: 'standalone' }
}

export function projectRecipeCodexExecution(
  spec: WorkflowRecipeSpec,
  snapshot: CodexCatalogSnapshot,
  provenance: CodexProvenance = 'authoritative'
): CodexExecutionProjection {
  if (provenance !== 'authoritative') {
    return {
      targets: collectCodexTargets(recipeToCodexHostSpec(spec)),
      eligibleTargets: [],
      derivedScopes: [],
      requiresCodexProxyEgress: false,
      catalogContentHash: snapshot.catalogContentHash ?? null,
      catalogRevision: snapshot.catalogRevision ?? null,
      connectionRevision: snapshot.connectionRevision ?? null,
      eligibility: 'uncertain',
      reason: 'provenance_uncertain',
      driftHashInput: JSON.stringify({
        eligibleTargets: [],
        derivedScopes: [],
        eligibility: 'uncertain',
      }),
    }
  }
  return projectSharedCodexExecution(recipeToCodexHostSpec(spec), snapshot)
}
