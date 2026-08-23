import type { V1ConfigMap } from '@kubernetes/client-node'
import type { CodexCatalogSnapshot, CodexSnapshotError } from './codexExecutionProjection'

export const ALLOWED_MODELS_CONFIGMAP_NAME = 'clerum-llm-allowed-models'
export const CONTENT_HASH_ANNOTATION = 'clerum.io/content-hash'
export const CATALOG_REVISION_ANNOTATION = 'clerum.io/catalog-revision'
export const CONNECTION_REVISION_ANNOTATION = 'clerum.io/connection-revision'
export const CODEX_CONNECTION_STATUS_ANNOTATION = 'clerum.io/codex-connection-status'
export const CODEX_ENABLED_ANNOTATION = 'clerum.io/codex-enabled'
export const CODEX_CONNECTIONS_ANNOTATION = 'clerum.io/codex-connections'

export function snapshotFromConfigMapError(error: CodexSnapshotError): CodexCatalogSnapshot {
  return { flagEnabled: false, snapshotError: error }
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
  connectionKey = 'deployment-default'
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
        { status?: string; catalogRevision?: number; connectionRevision?: number }
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
      } else if (connectionKey !== 'deployment-default') {
        connectionStatus = 'disconnected'
      }
    } catch {
      return snapshotFromConfigMapError('malformed')
    }
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
