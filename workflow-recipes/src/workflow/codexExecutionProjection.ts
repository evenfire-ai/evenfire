import type { WorkflowRecipeSpec } from '../types'

export const CODEX_EXECUTE_SCOPE = 'llm:codex:execute'
export const CODEX_PROVIDER = 'codex-subscription'

export type CodexTargetSource = 'primary' | 'allowed' | 'fallback'
export type CodexTarget = {
  source: CodexTargetSource
  provider: string
  model: string
}
export type CodexEligibility = 'eligible' | 'ineligible' | 'uncertain'
export type CodexSnapshotError = 'missing' | 'forbidden' | 'timeout' | 'malformed'
export type CodexProvenance = 'authoritative' | 'uncertain'

export type CodexCatalogSnapshot = {
  flagEnabled: boolean
  connectionStatus?: 'connected' | 'disconnected' | 'reauth-required' | 'unavailable' | null
  catalogContentHash?: string | null
  catalogRevision?: number | null
  connectionRevision?: number | null
  enabledModels?: Iterable<string>
  staleModels?: Iterable<string>
  snapshotError?: CodexSnapshotError
}

export type CodexHostSpec = {
  model?: { provider?: string; name?: string }
  allowedModels?: Array<{ provider?: string; model?: string }>
  llmPolicy?: { fallbacks?: Array<{ provider?: string; model?: string }> }
}

export type CodexExecutionProjection = {
  targets: CodexTarget[]
  eligibleTargets: CodexTarget[]
  derivedScopes: string[]
  requiresCodexProxyEgress: boolean
  driftHashInput: string
  catalogContentHash: string | null
  catalogRevision: number | null
  connectionRevision: number | null
  eligibility: CodexEligibility
  reason: string
}

export function collectCodexTargets(spec: CodexHostSpec): CodexTarget[] {
  const targets: CodexTarget[] = []
  if (spec.model?.provider) {
    targets.push({
      source: 'primary',
      provider: spec.model.provider,
      model: spec.model.name ?? '',
    })
  }
  for (const row of spec.allowedModels ?? []) {
    if (row.provider) {
      targets.push({ source: 'allowed', provider: row.provider, model: row.model ?? '' })
    }
  }
  for (const row of spec.llmPolicy?.fallbacks ?? []) {
    if (row.provider) {
      targets.push({ source: 'fallback', provider: row.provider, model: row.model ?? '' })
    }
  }
  return targets
}

export function recipeToCodexHostSpec(spec: WorkflowRecipeSpec): CodexHostSpec {
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

export function projectCodexExecution(
  spec: CodexHostSpec,
  snapshot: CodexCatalogSnapshot
): CodexExecutionProjection {
  const targets = collectCodexTargets(spec)
  const brokerTargets = targets.filter(target => target.provider === CODEX_PROVIDER)
  const enabled = new Set(snapshot.enabledModels ?? [])
  const stale = new Set(snapshot.staleModels ?? [])

  if (snapshot.snapshotError) {
    return freezeProjection({
      targets,
      eligibleTargets: [],
      derivedScopes: [],
      requiresCodexProxyEgress: false,
      catalogContentHash: snapshot.catalogContentHash ?? null,
      catalogRevision: snapshot.catalogRevision ?? null,
      connectionRevision: snapshot.connectionRevision ?? null,
      eligibility: 'uncertain',
      reason: `snapshot_${snapshot.snapshotError}`,
    })
  }
  if (!snapshot.flagEnabled) {
    return freezeProjection({
      targets,
      eligibleTargets: [],
      derivedScopes: [],
      requiresCodexProxyEgress: false,
      catalogContentHash: snapshot.catalogContentHash ?? null,
      catalogRevision: snapshot.catalogRevision ?? null,
      connectionRevision: snapshot.connectionRevision ?? null,
      eligibility: 'ineligible',
      reason: 'flag_off',
    })
  }
  if (brokerTargets.length === 0) {
    return freezeProjection({
      targets,
      eligibleTargets: [],
      derivedScopes: [],
      requiresCodexProxyEgress: false,
      catalogContentHash: snapshot.catalogContentHash ?? null,
      catalogRevision: snapshot.catalogRevision ?? null,
      connectionRevision: snapshot.connectionRevision ?? null,
      eligibility: 'ineligible',
      reason: 'static_only',
    })
  }
  if (snapshot.connectionStatus !== 'connected') {
    return freezeProjection({
      targets,
      eligibleTargets: [],
      derivedScopes: [],
      requiresCodexProxyEgress: false,
      catalogContentHash: snapshot.catalogContentHash ?? null,
      catalogRevision: snapshot.catalogRevision ?? null,
      connectionRevision: snapshot.connectionRevision ?? null,
      eligibility: 'ineligible',
      reason: `connection_${snapshot.connectionStatus ?? 'unknown'}`,
    })
  }

  const eligibleTargets = brokerTargets.filter(target => {
    if (!target.model.trim()) return false
    const key = `${target.provider}:${target.model}`
    return enabled.has(key) && !stale.has(key)
  })
  const eligible = eligibleTargets.length > 0
  return freezeProjection({
    targets,
    eligibleTargets,
    derivedScopes: eligible ? [CODEX_EXECUTE_SCOPE] : [],
    requiresCodexProxyEgress: eligible,
    catalogContentHash: snapshot.catalogContentHash ?? null,
    catalogRevision: snapshot.catalogRevision ?? null,
    connectionRevision: snapshot.connectionRevision ?? null,
    eligibility: eligible ? 'eligible' : 'ineligible',
    reason: eligible ? 'eligible' : 'no_eligible_broker_target',
  })
}

export function projectRecipeCodexExecution(
  spec: WorkflowRecipeSpec,
  snapshot: CodexCatalogSnapshot,
  provenance: CodexProvenance = 'authoritative'
): CodexExecutionProjection {
  if (provenance !== 'authoritative') {
    return freezeProjection({
      targets: collectCodexTargets(recipeToCodexHostSpec(spec)),
      eligibleTargets: [],
      derivedScopes: [],
      requiresCodexProxyEgress: false,
      catalogContentHash: snapshot.catalogContentHash ?? null,
      catalogRevision: snapshot.catalogRevision ?? null,
      connectionRevision: snapshot.connectionRevision ?? null,
      eligibility: 'uncertain',
      reason: 'provenance_uncertain',
    })
  }
  return projectCodexExecution(recipeToCodexHostSpec(spec), snapshot)
}

function freezeProjection(
  input: Omit<CodexExecutionProjection, 'driftHashInput'>
): CodexExecutionProjection {
  const driftHashInput = JSON.stringify({
    eligibleTargets: input.eligibleTargets,
    derivedScopes: input.derivedScopes,
    connectionRevision: input.connectionRevision,
    eligibility: input.eligibility,
  })
  return Object.freeze({ ...input, driftHashInput })
}
