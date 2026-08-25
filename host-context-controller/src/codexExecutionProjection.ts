export const CODEX_EXECUTE_SCOPE = 'llm:codex:execute'
export const CODEX_PROVIDER = 'codex-subscription'
/** Fail-closed Host sentinel. Empty/missing is not the reserved grant. */
export const CODEX_UNASSIGNED_CONNECTION_KEY = 'unassigned' as const

export function assignedHostCodexConnectionRef(value?: string | null): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed || CODEX_UNASSIGNED_CONNECTION_KEY
}

export function isCodexUnassignedConnectionRef(value?: string | null): boolean {
  return assignedHostCodexConnectionRef(value) === CODEX_UNASSIGNED_CONNECTION_KEY
}

export type CodexTargetSource = 'primary' | 'allowed' | 'fallback'

export type CodexTarget = {
  source: CodexTargetSource
  provider: string
  model: string
}

export type CodexEligibility = 'eligible' | 'ineligible' | 'uncertain'

export type CodexSnapshotError = 'missing' | 'forbidden' | 'timeout' | 'malformed'

export type CodexCatalogSnapshot = {
  flagEnabled: boolean
  connectionStatus?:
    | 'connected'
    | 'disconnected'
    | 'reauth-required'
    | 'unavailable'
    | 'revoked'
    | null
  catalogContentHash?: string | null
  catalogRevision?: number | null
  connectionRevision?: number | null
  enabledModels?: Iterable<string>
  staleModels?: Iterable<string>
  snapshotError?: CodexSnapshotError
}

export type CodexHostSpec = {
  model?: { provider?: string; name?: string; connectionRef?: string }
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
