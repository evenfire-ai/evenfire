import type { V1ConfigMap } from '@kubernetes/client-node'
import type { CodexCatalogSnapshot, CodexSnapshotError } from './codexExecutionProjection'

export const ALLOWED_MODELS_CONFIGMAP_NAME = 'clerum-llm-allowed-models'
export const CONTENT_HASH_ANNOTATION = 'clerum.io/content-hash'
export const CATALOG_REVISION_ANNOTATION = 'clerum.io/catalog-revision'
export const CONNECTION_REVISION_ANNOTATION = 'clerum.io/connection-revision'
export const CODEX_CONNECTION_STATUS_ANNOTATION = 'clerum.io/codex-connection-status'
export const CODEX_ENABLED_ANNOTATION = 'clerum.io/codex-enabled'
export const CODEX_CONNECTIONS_ANNOTATION = 'clerum.io/codex-connections'
/**
 * WorkflowRecipe metadata annotation naming the Codex grant (connection key)
 * the recipe executes against. Recipes have no Host `spec.model.connectionRef`
 * field by design: grants are created in Secrets and a recipe only *chooses*
 * an existing grant through this annotation. HCC (Hosts), WRC (recipes), the
 * control-api authorizer, and mcp-host must agree on the same key.
 */
export const CODEX_CONNECTION_REF_ANNOTATION = 'clerum.io/codex-connection-ref'
/** Fail-closed sentinel. Not a grant row; never aliases deployment-default. */
export const CODEX_UNASSIGNED_CONNECTION_KEY = 'unassigned'
export const ALLOWLIST_CONFIGMAP_NAMESPACE = process.env.CLERUM_MODEL_CONFIG_NAMESPACE ?? 'mcp-host'

/**
 * Recipe annotation reader. Empty/missing is `unassigned`, never the reserved
 * grant: only an explicit annotation may spend a ChatGPT subscription.
 */
export function readRecipeCodexConnectionRef(
  annotations: Record<string, string> | undefined
): string {
  const raw = annotations?.[CODEX_CONNECTION_REF_ANNOTATION]
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  if (!trimmed) return CODEX_UNASSIGNED_CONNECTION_KEY
  return trimmed
}

export function snapshotFromConfigMapError(error: CodexSnapshotError): CodexCatalogSnapshot {
  return { flagEnabled: false, snapshotError: error }
}

const CODEX_PROVIDER_PREFIX = 'codex-subscription:'

function dropCodexModels(enabledModels: Set<string>, staleModels: Set<string>): void {
  for (const key of [...enabledModels]) {
    if (key.startsWith(CODEX_PROVIDER_PREFIX)) {
      enabledModels.delete(key)
      staleModels.delete(key)
    }
  }
}

function intersectCodexModels(
  enabledModels: Set<string>,
  staleModels: Set<string>,
  models: string[] | undefined,
  _connectionKey: string
): void {
  if (!Array.isArray(models)) {
    dropCodexModels(enabledModels, staleModels)
    return
  }
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

function parseOptionalIntegerAnnotation(
  annotations: Record<string, string>,
  key: string
): number | null | 'invalid' {
  if (!(key in annotations)) return null
  const parsed = Number(annotations[key])
  return Number.isInteger(parsed) ? parsed : 'invalid'
}

export function parseAllowedModelsSnapshot(
  cm: V1ConfigMap | undefined,
  connectionKey = 'unassigned'
): CodexCatalogSnapshot {
  if (!cm) return snapshotFromConfigMapError('missing')
  const annotations = cm.metadata?.annotations ?? {}
  const enabledModels = new Set<string>()
  const staleModels = new Set<string>()
  for (const [provider, raw] of Object.entries(cm.data ?? {})) {
    try {
      const rows = JSON.parse(raw) as Array<{ model?: string; stale?: boolean }>
      if (!Array.isArray(rows)) return snapshotFromConfigMapError('malformed')
      for (const row of rows) {
        if (typeof row.model === 'string' && row.model.trim()) {
          const key = `${provider}:${row.model}`
          enabledModels.add(key)
          if (row.stale === true) staleModels.add(key)
        }
      }
    } catch {
      return snapshotFromConfigMapError('malformed')
    }
  }
  let catalogRevision = parseOptionalIntegerAnnotation(annotations, CATALOG_REVISION_ANNOTATION)
  let connectionRevision = parseOptionalIntegerAnnotation(
    annotations,
    CONNECTION_REVISION_ANNOTATION
  )
  if (catalogRevision === 'invalid' || connectionRevision === 'invalid') {
    return snapshotFromConfigMapError('malformed')
  }
  let connectionStatus =
    (annotations[CODEX_CONNECTION_STATUS_ANNOTATION] as CodexCatalogSnapshot['connectionStatus']) ??
    null
  const rawMap = annotations[CODEX_CONNECTIONS_ANNOTATION]
  if (rawMap) {
    try {
      const parsed = JSON.parse(rawMap) as Record<
        string,
        {
          status?: string
          catalogRevision?: number
          connectionRevision?: number
          models?: string[]
        }
      >
      const assigned = parsed[connectionKey]
      if (assigned) {
        connectionStatus =
          (assigned.status as CodexCatalogSnapshot['connectionStatus']) ?? connectionStatus
        if (Number.isInteger(assigned.catalogRevision)) {
          catalogRevision = assigned.catalogRevision as number
        }
        if (Number.isInteger(assigned.connectionRevision)) {
          connectionRevision = assigned.connectionRevision as number
        }
        intersectCodexModels(enabledModels, staleModels, assigned.models, connectionKey)
      } else {
        connectionStatus = 'disconnected'
        dropCodexModels(enabledModels, staleModels)
      }
    } catch {
      return snapshotFromConfigMapError('malformed')
    }
  }
  // No connections map: keep the flat catalog (legacy single-grant). Do not
  // invent deployment-default; a multi-grant map already fail-closed above.
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

/**
 * Per-recipe snapshot. `unassigned` never inherits a legacy flat catalog —
 * that would let a recipe without a grant spend the cluster default.
 */
export function snapshotForAssignedCodexGrant(
  connectionKey: string,
  lastConfigMap: V1ConfigMap | undefined | null,
  fallback: CodexCatalogSnapshot
): CodexCatalogSnapshot {
  if (connectionKey === CODEX_UNASSIGNED_CONNECTION_KEY) {
    return {
      flagEnabled: fallback.flagEnabled,
      connectionStatus: 'disconnected',
      enabledModels: [],
      staleModels: [],
    }
  }
  if (!lastConfigMap) return fallback
  return parseAllowedModelsSnapshot(lastConfigMap, connectionKey)
}
