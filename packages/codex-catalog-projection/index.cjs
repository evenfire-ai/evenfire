'use strict'

const ALLOWED_MODELS_CONFIGMAP_NAME = 'clerum-llm-allowed-models'
const CONTENT_HASH_ANNOTATION = 'clerum.io/content-hash'
const CATALOG_REVISION_ANNOTATION = 'clerum.io/catalog-revision'
const CONNECTION_REVISION_ANNOTATION = 'clerum.io/connection-revision'
const CODEX_CONNECTION_STATUS_ANNOTATION = 'clerum.io/codex-connection-status'
const CODEX_ENABLED_ANNOTATION = 'clerum.io/codex-enabled'
const CODEX_CONNECTIONS_ANNOTATION = 'clerum.io/codex-connections'
const CODEX_CONNECTION_REF_ANNOTATION = 'clerum.io/codex-connection-ref'
const CODEX_UNASSIGNED_CONNECTION_KEY = 'unassigned'
const CODEX_PROVIDER = 'codex-subscription'
const CODEX_EXECUTE_SCOPE = 'llm:codex:execute'
const CODEX_PROVIDER_PREFIX = `${CODEX_PROVIDER}:`

function assignedCodexConnectionKey(value) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed || CODEX_UNASSIGNED_CONNECTION_KEY
}

function isCodexUnassignedConnectionKey(value) {
  return assignedCodexConnectionKey(value) === CODEX_UNASSIGNED_CONNECTION_KEY
}

function snapshotFromConfigMapError(error) {
  return { flagEnabled: false, snapshotError: error }
}

function parseOptionalIntegerAnnotation(annotations, key) {
  if (!annotations || !Object.prototype.hasOwnProperty.call(annotations, key)) return null
  const parsed = Number(annotations[key])
  return Number.isInteger(parsed) ? parsed : 'invalid'
}

function dropCodexModels(enabledModels, staleModels) {
  for (const key of [...enabledModels]) {
    if (key.startsWith(CODEX_PROVIDER_PREFIX)) {
      enabledModels.delete(key)
      staleModels.delete(key)
    }
  }
}

function intersectCodexModels(enabledModels, staleModels, models) {
  const allowed = new Set(models.filter(model => typeof model === 'string' && model.trim()))
  for (const key of [...enabledModels]) {
    if (!key.startsWith(CODEX_PROVIDER_PREFIX)) continue
    const model = key.slice(CODEX_PROVIDER_PREFIX.length)
    if (!allowed.has(model)) {
      enabledModels.delete(key)
      staleModels.delete(key)
    }
  }
}

function parseFlatCatalog(data) {
  const enabledModels = new Set()
  const staleModels = new Set()
  for (const [provider, raw] of Object.entries(data ?? {})) {
    let rows
    try {
      rows = JSON.parse(raw)
    } catch {
      return { error: 'malformed' }
    }
    if (!Array.isArray(rows)) return { error: 'malformed' }
    for (const row of rows) {
      if (row && typeof row.model === 'string' && row.model.trim()) {
        const key = `${provider}:${row.model}`
        enabledModels.add(key)
        if (row.stale === true) staleModels.add(key)
      }
    }
  }
  return { enabledModels, staleModels }
}

function parseAllowedModelsSnapshot(cm, connectionKey) {
  if (!cm) return snapshotFromConfigMapError('missing')
  const annotations = (cm.metadata && cm.metadata.annotations) || {}
  const catalog = parseFlatCatalog(cm.data)
  if (catalog.error) return snapshotFromConfigMapError('malformed')
  const enabledModels = catalog.enabledModels
  const staleModels = catalog.staleModels
  let catalogRevision = parseOptionalIntegerAnnotation(annotations, CATALOG_REVISION_ANNOTATION)
  let connectionRevision = parseOptionalIntegerAnnotation(
    annotations,
    CONNECTION_REVISION_ANNOTATION
  )
  if (catalogRevision === 'invalid' || connectionRevision === 'invalid') {
    return snapshotFromConfigMapError('malformed')
  }
  let connectionStatus = annotations[CODEX_CONNECTION_STATUS_ANNOTATION] || null
  const assignedKey = assignedCodexConnectionKey(connectionKey)
  const rawMap = annotations[CODEX_CONNECTIONS_ANNOTATION]
  if (rawMap) {
    let parsed
    try {
      parsed = JSON.parse(rawMap)
    } catch {
      return snapshotFromConfigMapError('malformed')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return snapshotFromConfigMapError('malformed')
    }
    const assigned = parsed[assignedKey]
    // Mapped miss OR models[] omitted: disconnected, empty Codex, no rematch.
    if (!assigned || !Array.isArray(assigned.models)) {
      connectionStatus = 'disconnected'
      dropCodexModels(enabledModels, staleModels)
    } else {
      connectionStatus = assigned.status || connectionStatus
      if (Number.isInteger(assigned.catalogRevision)) {
        catalogRevision = assigned.catalogRevision
      }
      if (Number.isInteger(assigned.connectionRevision)) {
        connectionRevision = assigned.connectionRevision
      }
      intersectCodexModels(enabledModels, staleModels, assigned.models)
    }
  } else if (assignedKey === CODEX_UNASSIGNED_CONNECTION_KEY) {
    // Unassigned never inherits a legacy flat catalog.
    connectionStatus = 'disconnected'
    dropCodexModels(enabledModels, staleModels)
  }
  return {
    flagEnabled: annotations[CODEX_ENABLED_ANNOTATION] === 'true',
    connectionStatus,
    catalogContentHash: annotations[CONTENT_HASH_ANNOTATION] ?? null,
    catalogRevision,
    connectionRevision,
    enabledModels,
    staleModels,
  }
}

function snapshotForAssignedCodexGrant(connectionKey, lastConfigMap, fallback) {
  const key = assignedCodexConnectionKey(connectionKey)
  if (key === CODEX_UNASSIGNED_CONNECTION_KEY) {
    return {
      flagEnabled: Boolean(fallback && fallback.flagEnabled),
      connectionStatus: 'disconnected',
      enabledModels: [],
      staleModels: [],
    }
  }
  if (!lastConfigMap) return fallback
  return parseAllowedModelsSnapshot(lastConfigMap, key)
}

function collectCodexTargets(spec) {
  const targets = []
  if (spec && spec.model && spec.model.provider) {
    targets.push({
      source: 'primary',
      provider: spec.model.provider,
      model: spec.model.name ?? '',
    })
  }
  for (const row of (spec && spec.allowedModels) || []) {
    if (row && row.provider) {
      targets.push({ source: 'allowed', provider: row.provider, model: row.model ?? '' })
    }
  }
  for (const row of (spec && spec.llmPolicy && spec.llmPolicy.fallbacks) || []) {
    if (row && row.provider) {
      targets.push({ source: 'fallback', provider: row.provider, model: row.model ?? '' })
    }
  }
  return targets
}

function freezeProjection(input) {
  const driftHashInput = JSON.stringify({
    eligibleTargets: input.eligibleTargets,
    derivedScopes: input.derivedScopes,
    eligibility: input.eligibility,
  })
  return Object.freeze({ ...input, driftHashInput })
}

function projectCodexExecution(spec, snapshot) {
  const targets = collectCodexTargets(spec || {})
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

function toPolicyBinding(cm, connectionKey) {
  const key = assignedCodexConnectionKey(connectionKey)
  if (!cm || key === CODEX_UNASSIGNED_CONNECTION_KEY) return null
  const annotations = (cm.metadata && cm.metadata.annotations) || {}
  let catalogRevision = parseOptionalIntegerAnnotation(annotations, CATALOG_REVISION_ANNOTATION)
  let credentialRevision = parseOptionalIntegerAnnotation(
    annotations,
    CONNECTION_REVISION_ANNOTATION
  )
  const rawMap = annotations[CODEX_CONNECTIONS_ANNOTATION]
  if (rawMap) {
    let parsed
    try {
      parsed = JSON.parse(rawMap)
    } catch {
      return null
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const assigned = parsed[key]
    if (
      !assigned ||
      !Array.isArray(assigned.models) ||
      !Number.isInteger(assigned.catalogRevision) ||
      !Number.isInteger(assigned.connectionRevision)
    ) {
      return null
    }
    return {
      catalogRevision: assigned.catalogRevision,
      credentialRevision: assigned.connectionRevision,
      connectionKey: key,
      models: assigned.models.filter(model => typeof model === 'string' && model),
    }
  }
  if (
    catalogRevision === null ||
    catalogRevision === 'invalid' ||
    credentialRevision === null ||
    credentialRevision === 'invalid'
  ) {
    return null
  }
  return { catalogRevision, credentialRevision, connectionKey: key }
}

/**
 * Mint an execution policy binding for one (grant, model) pair using the SAME
 * eligibility cascade that decides `llm:codex:execute`. It is deliberately a
 * caller of `projectCodexExecution` with a synthetic single-target spec, not a
 * second copy of the cascade: the invariant
 * `binding !== null ⇔ derivedScopes.includes(CODEX_EXECUTE_SCOPE)`
 * is what keeps the scope gate and the binding gate from drifting apart.
 *
 * Always returns an object so the caller can log `reason` (e.g.
 * `connection_reauth-required`) without projecting a second time.
 */
function toEligiblePolicyBinding(cm, connectionKey, model) {
  const key = assignedCodexConnectionKey(connectionKey)
  const trimmedModel = typeof model === 'string' ? model.trim() : ''
  if (key === CODEX_UNASSIGNED_CONNECTION_KEY) {
    return { binding: null, eligibility: 'ineligible', reason: 'unassigned' }
  }
  if (!trimmedModel) {
    return { binding: null, eligibility: 'ineligible', reason: 'model_missing' }
  }
  const snapshot = parseAllowedModelsSnapshot(cm, key)
  const projection = projectCodexExecution(
    { model: { provider: CODEX_PROVIDER, name: trimmedModel } },
    snapshot
  )
  if (projection.eligibility !== 'eligible') {
    return { binding: null, eligibility: projection.eligibility, reason: projection.reason }
  }
  // Revisions come from the normalized snapshot (assigned.* first, global
  // annotations as the legacy shape). The writer always emits both.
  if (
    !Number.isInteger(snapshot.catalogRevision) ||
    !Number.isInteger(snapshot.connectionRevision)
  ) {
    return { binding: null, eligibility: 'ineligible', reason: 'revision_missing' }
  }
  return {
    binding: {
      connectionKey: key,
      catalogRevision: snapshot.catalogRevision,
      credentialRevision: snapshot.connectionRevision,
      model: trimmedModel,
    },
    eligibility: 'eligible',
    reason: 'eligible',
  }
}

module.exports = {
  ALLOWED_MODELS_CONFIGMAP_NAME,
  CONTENT_HASH_ANNOTATION,
  CATALOG_REVISION_ANNOTATION,
  CONNECTION_REVISION_ANNOTATION,
  CODEX_CONNECTION_STATUS_ANNOTATION,
  CODEX_ENABLED_ANNOTATION,
  CODEX_CONNECTIONS_ANNOTATION,
  CODEX_CONNECTION_REF_ANNOTATION,
  CODEX_UNASSIGNED_CONNECTION_KEY,
  CODEX_PROVIDER,
  CODEX_EXECUTE_SCOPE,
  assignedCodexConnectionKey,
  isCodexUnassignedConnectionKey,
  snapshotFromConfigMapError,
  parseAllowedModelsSnapshot,
  snapshotForAssignedCodexGrant,
  collectCodexTargets,
  projectCodexExecution,
  toPolicyBinding,
  toEligiblePolicyBinding,
}
