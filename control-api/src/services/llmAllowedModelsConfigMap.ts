/**
 * Materializes the operator allowlist (`llm_allowed_models`, enabled rows) into
 * the `clerum-llm-allowed-models` ConfigMap in the `mcp-host` namespace so the
 * runtime consumers (mcp-host ConfigStore, WRC secret broker) can enforce it
 * without a hot dependency on control-api (the NetworkPolicy denies
 * mcp-host→control-api by design).
 *
 * Contract (fixed, shared with mcp-host/WRC/control-ui):
 *   - name `clerum-llm-allowed-models`, namespace `mcp-host`
 *   - `data`: one key per provider whose value is a JSON array of
 *     `{ model, displayName?, contextWindowTokens?, vendor? }` (enabled rows only)
 *   - annotation `clerum.io/content-hash` = sha256 over the serialized `data`
 *
 * Anti-drift (spec §3-R3.4 / V7): the K8s write happens OUTSIDE the Postgres
 * transaction, so it is best-effort with a short retry. Postgres stays the
 * source of truth; the CM is reconciled again on every mutation and on boot.
 * A persistent write failure surfaces loudly (503 to the operator + metric) —
 * never silently.
 */
import * as k8s from '@kubernetes/client-node'
import { createHash } from 'node:crypto'
import { config } from '../config.js'
import type { DbClient } from '../db.js'
import { pool } from '../db.js'
import { listEnabledCodexModelsGroupedByConnection } from './codexSubscriptionCatalog.js'
import {
  type CodexSubscriptionSafeConnection,
  listSafeCodexSubscriptionConnections,
} from './codexSubscriptionConnection.js'
import { type AllowedModelEntry, listEnabledGroupedByProvider } from './llmAllowedModels.js'

// CROSS-SERVICE CONTRACT: producer side of the allowlist ConfigMap. Consumers
// read this exact name/namespace: mcp-host (mcp-host/src/config.ts,
// CLERUM_LLM_ALLOWED_MODELS_CM) and WRC (workflow-recipes/src/workflow/
// modelConfigHandler.ts, ALLOWLIST_CONFIGMAP_NAME). Keep name + data format in sync.
export const ALLOWED_MODELS_CONFIGMAP_NAME = 'clerum-llm-allowed-models'
export const CONTENT_HASH_ANNOTATION = 'clerum.io/content-hash'
export const CATALOG_REVISION_ANNOTATION = 'clerum.io/catalog-revision'
export const CONNECTION_REVISION_ANNOTATION = 'clerum.io/connection-revision'
export const CODEX_CONNECTION_STATUS_ANNOTATION = 'clerum.io/codex-connection-status'
export const CODEX_ENABLED_ANNOTATION = 'clerum.io/codex-enabled'
export const CODEX_CONNECTIONS_ANNOTATION = 'clerum.io/codex-connections'

const KNOWN_CONNECTION_STATUSES = new Set([
  'disconnected',
  'connecting',
  'connected',
  'reauth_required',
  'revoked',
])

export function mapCodexConnectionStatusForSnapshot(
  connection: CodexSubscriptionSafeConnection | null
): 'connected' | 'disconnected' | 'reauth-required' | 'unavailable' | 'revoked' {
  if (!connection || !KNOWN_CONNECTION_STATUSES.has(connection.status)) return 'disconnected'
  if (connection.status === 'revoked') return 'revoked'
  if (connection.status === 'reauth_required' || connection.catalogStatus === 'auth-rejected') {
    return 'reauth-required'
  }
  if (connection.catalogStatus === 'unavailable') return 'unavailable'
  if (connection.status === 'connected' && connection.catalogStatus === 'ready') return 'connected'
  return 'disconnected'
}

export function buildCodexReadinessAnnotations(
  connection: CodexSubscriptionSafeConnection | null,
  connections: CodexSubscriptionSafeConnection[] = [],
  modelsByKey: Record<string, string[]> = {}
): Record<string, string> {
  const annotations: Record<string, string> = {
    [CODEX_ENABLED_ANNOTATION]: config.codexSubscriptionEnabled ? 'true' : 'false',
    [CODEX_CONNECTION_STATUS_ANNOTATION]: mapCodexConnectionStatusForSnapshot(connection),
  }
  if (
    connection &&
    KNOWN_CONNECTION_STATUSES.has(connection.status) &&
    Number.isInteger(connection.catalogRevision) &&
    Number.isInteger(connection.credentialRevision)
  ) {
    annotations[CATALOG_REVISION_ANNOTATION] = String(connection.catalogRevision)
    annotations[CONNECTION_REVISION_ANNOTATION] = String(connection.credentialRevision)
  }
  const map: Record<
    string,
    {
      status: ReturnType<typeof mapCodexConnectionStatusForSnapshot>
      catalogRevision: number
      connectionRevision: number
      models: string[]
    }
  > = {}
  for (const row of connections) {
    map[row.connectionKey] = {
      status: mapCodexConnectionStatusForSnapshot(row),
      catalogRevision: row.catalogRevision,
      connectionRevision: row.credentialRevision,
      models: modelsByKey[row.connectionKey] ?? [],
    }
  }
  if (Object.keys(map).length > 0) {
    annotations[CODEX_CONNECTIONS_ANNOTATION] = JSON.stringify(map)
  }
  return annotations
}

const MANAGED_BY_LABEL = 'clerum.io/managed-by'

/** The materializer surface the routes / boot module depend on (test seam). */
export interface AllowedModelsConfigMapMaterializer {
  materialize(db?: DbClient): Promise<void>
}

/**
 * Push the current Postgres allowlist + per-grant Codex snapshot to the
 * runtime ConfigMap. Catalog sync, revoke, and a successful OAuth persist
 * must call this — mcp-host/HCC never read Postgres, and a cluster in
 * operation cannot wait for the next control-api boot.
 *
 * Missing writer is a no-op so unit tests without a K8s gateway stay local.
 */
export async function publishAllowedModelsConfigMapAfterGrantChange(
  writer: AllowedModelsConfigMapMaterializer | undefined
): Promise<'published' | 'skipped'> {
  if (!writer) return 'skipped'
  await writer.materialize()
  return 'published'
}

/**
 * Build the ConfigMap `data` and its content hash from grouped enabled rows.
 * Provider keys and per-provider model arrays are already deterministically
 * ordered by the query (provider, model), so the serialized form — and thus the
 * hash — is stable for a given allowlist state.
 */
export function buildConfigMapData(grouped: Record<string, AllowedModelEntry[]>): {
  data: Record<string, string>
  contentHash: string
} {
  const data: Record<string, string> = Object.create(null)
  for (const provider of Object.keys(grouped).sort()) {
    data[provider] = JSON.stringify(grouped[provider])
  }
  const contentHash = createHash('sha256').update(JSON.stringify(data)).digest('hex')
  return { data, contentHash }
}

function isErrorCode(err: unknown, code: number): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: number; statusCode?: number; response?: { statusCode?: number } }
  return e.code === code || e.statusCode === code || e.response?.statusCode === code
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class LlmAllowedModelsConfigMapWriter implements AllowedModelsConfigMapMaterializer {
  constructor(
    private readonly coreApi: Pick<
      k8s.CoreV1Api,
      'createNamespacedConfigMap' | 'readNamespacedConfigMap' | 'replaceNamespacedConfigMap'
    >,
    private readonly namespace: string,
    private readonly maxAttempts = 3
  ) {}

  async materialize(db: DbClient = pool): Promise<void> {
    const grouped = await listEnabledGroupedByProvider(db)
    const { data, contentHash } = buildConfigMapData(grouped)
    const connections = await listSafeCodexSubscriptionConnections(db)
    const modelsByKey = await listEnabledCodexModelsGroupedByConnection(db)
    const defaultConnection =
      connections.find(row => row.connectionKey === 'deployment-default') ?? null
    const readiness = buildCodexReadinessAnnotations(defaultConnection, connections, modelsByKey)
    let lastError: unknown
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        await this.writeOnce(data, contentHash, readiness)
        return
      } catch (err) {
        lastError = err
        if (attempt < this.maxAttempts) await sleep(100 * attempt)
      }
    }
    throw lastError
  }

  private async writeOnce(
    data: Record<string, string>,
    contentHash: string,
    readiness: Record<string, string>
  ): Promise<void> {
    const body: k8s.V1ConfigMap = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: ALLOWED_MODELS_CONFIGMAP_NAME,
        namespace: this.namespace,
        labels: { [MANAGED_BY_LABEL]: 'control-api' },
        annotations: {
          [CONTENT_HASH_ANNOTATION]: contentHash,
          ...readiness,
        },
      },
      data,
    }
    try {
      await this.coreApi.createNamespacedConfigMap({ namespace: this.namespace, body })
      return
    } catch (err) {
      if (!isErrorCode(err, 409)) throw err
    }
    const existing = await this.coreApi.readNamespacedConfigMap({
      namespace: this.namespace,
      name: ALLOWED_MODELS_CONFIGMAP_NAME,
    })
    body.metadata!.resourceVersion = existing.metadata?.resourceVersion
    await this.coreApi.replaceNamespacedConfigMap({
      namespace: this.namespace,
      name: ALLOWED_MODELS_CONFIGMAP_NAME,
      body,
    })
  }
}
