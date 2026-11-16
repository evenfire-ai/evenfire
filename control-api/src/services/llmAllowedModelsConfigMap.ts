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
 *     `{ model, displayName?, contextWindowTokens?, vendor?, imageInput? }`
 *     (enabled rows only). `imageInput` is omitted when the row carries no
 *     capability metadata, so an allowlist that predates #654 materializes
 *     byte-identically; a published capability changes the hash on purpose.
 *   - annotation `clerum.io/content-hash` = sha256 over the serialized `data`
 *
 * Anti-drift (spec §3-R3.4 / V7): the CM is not part of any data transaction,
 * so publication is best-effort with a short retry. Postgres stays the source of
 * truth; the CM is reconciled again on every mutation, on boot and on every
 * catalog sync. A persistent write failure surfaces loudly (503 to the operator
 * + metric) — never silently.
 *
 * Publication is serialized across replicas: every publish holds one global
 * advisory lock while it reads Postgres AND writes the CM, so writes land in the
 * order of their reads and the last write always carries every earlier commit.
 * Without it, a publisher that read before a commit and wrote after it would
 * overwrite the newer snapshot, and nothing would ever re-publish.
 */
import * as k8s from '@kubernetes/client-node'
import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { config } from '../config.js'
import type { DbClient } from '../db.js'
import { boundCarrierTransactionIdleTimeout, pool, withTransaction } from '../db.js'
import { listEnabledCodexModelsGroupedByConnection } from './codexSubscriptionCatalog.js'
import {
  type CodexSubscriptionSafeConnection,
  listLiveCodexSubscriptionConnections,
} from './codexSubscriptionConnection.js'
import { listEnabledGrokModelsGroupedByConnection } from './grokSubscriptionCatalog.js'
import {
  type GrokSubscriptionSafeConnection,
  listLiveGrokSubscriptionConnections,
} from './grokSubscriptionConnection.js'
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
export const GROK_CONNECTION_STATUS_ANNOTATION = 'clerum.io/grok-connection-status'
export const GROK_ENABLED_ANNOTATION = 'clerum.io/grok-enabled'
export const GROK_CONNECTIONS_ANNOTATION = 'clerum.io/grok-connections'

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

export function mapGrokConnectionStatusForSnapshot(
  connection: GrokSubscriptionSafeConnection | null
): 'connected' | 'disconnected' | 'reauth-required' | 'unavailable' | 'revoked' {
  return mapCodexConnectionStatusForSnapshot(
    connection as unknown as CodexSubscriptionSafeConnection | null
  )
}

export function buildGrokReadinessAnnotations(
  connections: GrokSubscriptionSafeConnection[] = [],
  modelsByKey: Record<string, string[]> = {}
): Record<string, string> {
  const annotations: Record<string, string> = {
    [GROK_ENABLED_ANNOTATION]: config.grokSubscriptionEnabled ? 'true' : 'false',
  }
  const map: Record<
    string,
    {
      status: ReturnType<typeof mapGrokConnectionStatusForSnapshot>
      catalogRevision: number
      connectionRevision: number
      models: string[]
    }
  > = {}
  for (const row of connections) {
    map[row.connectionKey] = {
      status: mapGrokConnectionStatusForSnapshot(row),
      catalogRevision: row.catalogRevision,
      connectionRevision: row.credentialRevision,
      models: modelsByKey[row.connectionKey] ?? [],
    }
  }
  if (Object.keys(map).length > 0) {
    annotations[GROK_CONNECTIONS_ANNOTATION] = JSON.stringify(map)
    const first = connections[0]
    if (first) {
      annotations[GROK_CONNECTION_STATUS_ANNOTATION] = mapGrokConnectionStatusForSnapshot(first)
    }
  }
  return annotations
}

const MANAGED_BY_LABEL = 'clerum.io/managed-by'

/**
 * The publish surface of every writer except the catalog sync: it ALWAYS writes.
 *
 * A write that is skipped because the content hash already matches leaves the
 * resourceVersion untouched, so an older replace still in flight from a
 * publisher that lost the lock would land on top of it. Writing unconditionally
 * bumps the resourceVersion and turns that stale replace into a 409. The hash
 * also covers only `data`: a change that only moves the Codex/Grok readiness
 * annotations would never be published if these callers could skip.
 */
export interface AllowedModelsConfigMapMaterializer {
  materialize(): Promise<void>
}

export type AllowedModelsPublishOutcome = 'written' | 'unchanged'

/**
 * Adds the hash-gated publish, reserved to the catalog sync and its publish
 * retry: they publish by state (CM hash vs the hash of what Postgres projects
 * now), not by what the run happened to change, so a run with nothing new still
 * repairs a CM that an earlier failure or another writer left behind. Neither
 * of them changes readiness inputs, so skipping on an equal `data` hash cannot
 * hide a readiness change.
 */
export interface AllowedModelsConfigMapPublisher extends AllowedModelsConfigMapMaterializer {
  materializeIfChanged(): Promise<AllowedModelsPublishOutcome>
}

/**
 * Push the current Postgres allowlist + per-grant Codex snapshot to the
 * runtime ConfigMap. Catalog sync (including recorded non-ready outcomes),
 * manual refresh, revoke, and a successful OAuth persist must call this —
 * mcp-host/HCC never read Postgres, and a cluster in operation cannot wait
 * for the next control-api boot.
 *
 * Missing writer is a no-op so unit tests without a K8s gateway stay local.
 */
/**
 * Did this catalog sync change the connection row, and therefore owe a publish?
 *
 * The rule belongs here, beside the publish it gates, because it was previously
 * written inline in three places in three shapes — the cron, the Grok route and
 * the Codex route — and one of them was wrong.
 *
 * `catalogStatus` describes the CATALOG, so it cannot answer this on its own. A
 * rejected Grok refresh token writes `status = 'reauth_required'` to the row and
 * only then throws, leaving `catalogStatus: 'never_synced'` on a row that did
 * change; `mapCodexConnectionStatusForSnapshot` puts that status in the
 * ConfigMap, so a skipped publish leaves mcp-host and HCC serving a grant the
 * control plane already knows is broken. `persisted` is the services' explicit
 * answer for exactly that case.
 */
export function syncOutcomeChangedTheRow(outcome: {
  ok: boolean
  catalogStatus: string
  persisted?: boolean
}): boolean {
  if (outcome.ok) return true
  return outcome.persisted === true || outcome.catalogStatus !== 'never_synced'
}

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

// Global (not per-provider): the CM is one object, so every publisher must queue
// on the same key.
const PUBLISH_LOCK_KEY = 'llm-allowlist-cm-v1'

/**
 * Bound of each Kubernetes call made while holding the publish lock. The K8s
 * client sets no per-request timeout, and the lock holder keeps a core-pool
 * connection checked out for as long as it waits: an unbounded call against a
 * hung apiserver would pin one connection per publish until the pool ran dry.
 * A call that times out counts as a failed attempt.
 */
export const ALLOWLIST_K8S_CALL_TIMEOUT_MS = 3_000

/**
 * Idle-in-transaction backstop for the publish lock holder. With every K8s call
 * bounded above, the holder is never idle longer than one call plus the
 * between-attempt backoff, far below this; it only fires if the process itself
 * stalls, and then frees the lock and makes the holder's next Postgres read fail
 * so that publish aborts without writing.
 *
 * It does NOT bound how long a waiter queues: the holder's total tenancy is up
 * to maxAttempts × (GET + write) at ALLOWLIST_K8S_CALL_TIMEOUT_MS each, plus
 * backoff, and a waiter gives up when the pool's statement_timeout
 * (CORE_POOL_STATEMENT_TIMEOUT_MS, 100 ms–30 s, default 15 s) ends its lock
 * wait, failing through its caller's error path (admin 503, sync retry).
 */
export const ALLOWLIST_PUBLISH_IDLE_TIMEOUT_MS = 10_000

class K8sCallTimeoutError extends Error {
  constructor(operation: string, ms: number) {
    super(`allowlist ConfigMap ${operation} timed out after ${ms} ms`)
    this.name = 'K8sCallTimeoutError'
  }
}

/**
 * Race a K8s call against a timer. The losing call keeps running (it cannot be
 * cancelled), but its outcome is never observed: a late `create` fails with 409
 * if any publisher created the CM since, and a late `replace` fails its
 * resourceVersion CAS once anyone has written, so neither can overwrite a newer
 * snapshot.
 */
async function withK8sTimeout<T>(
  operation: string,
  ms: number,
  call: () => Promise<T>
): Promise<T> {
  const pending = call()
  pending.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new K8sCallTimeoutError(operation, ms)), ms)
  })
  try {
    return await Promise.race([pending, timeout])
  } finally {
    clearTimeout(timer)
  }
}

interface AllowlistSnapshot {
  data: Record<string, string>
  contentHash: string
  readiness: Record<string, string>
}

async function readAllowlistSnapshot(db: DbClient): Promise<AllowlistSnapshot> {
  const grouped = await listEnabledGroupedByProvider(db)
  const { data, contentHash } = buildConfigMapData(grouped)
  const connections = await listLiveCodexSubscriptionConnections(db)
  const modelsByKey = await listEnabledCodexModelsGroupedByConnection(db)
  const defaultConnection =
    connections.find(row => row.connectionKey === 'deployment-default') ?? null
  const grokConnections = await listLiveGrokSubscriptionConnections(db)
  const grokModelsByKey = await listEnabledGrokModelsGroupedByConnection(db)
  const readiness = {
    ...buildCodexReadinessAnnotations(defaultConnection, connections, modelsByKey),
    ...buildGrokReadinessAnnotations(grokConnections, grokModelsByKey),
  }
  return { data, contentHash, readiness }
}

export class LlmAllowedModelsConfigMapWriter implements AllowedModelsConfigMapPublisher {
  constructor(
    private readonly coreApi: Pick<
      k8s.CoreV1Api,
      'createNamespacedConfigMap' | 'readNamespacedConfigMap' | 'replaceNamespacedConfigMap'
    >,
    private readonly namespace: string,
    private readonly maxAttempts = 3,
    // Injectable so tests can run the lock against a dedicated database or a
    // fake pool; production always uses the core pool.
    private readonly txPool: Pool = pool,
    private readonly k8sCallTimeoutMs = ALLOWLIST_K8S_CALL_TIMEOUT_MS
  ) {}

  async materialize(): Promise<void> {
    await this.publish('always')
  }

  async materializeIfChanged(): Promise<AllowedModelsPublishOutcome> {
    return this.publish('if-changed')
  }

  /**
   * Each attempt reads the CM's resourceVersion BEFORE reading Postgres, and
   * then writes with that version. If this publisher lost the lock (its session
   * hit the idle bound), either the Postgres read fails and nothing is written,
   * or the read succeeded first and any publisher that wrote since our GET has
   * moved the resourceVersion, so our replace fails its CAS. Reading the version
   * after the data would let a write from a lock-less holder land with a snapshot
   * older than the CM it replaces. For the same reason a retry never reuses data
   * read in an earlier attempt.
   */
  private async publish(mode: 'always' | 'if-changed'): Promise<AllowedModelsPublishOutcome> {
    return withTransaction(async db => {
      await boundCarrierTransactionIdleTimeout(db, ALLOWLIST_PUBLISH_IDLE_TIMEOUT_MS)
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [PUBLISH_LOCK_KEY])
      let lastError: unknown
      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        if (attempt > 1 && !isErrorCode(lastError, 409)) await sleep(100 * (attempt - 1))
        let current: k8s.V1ConfigMap | null
        try {
          current = await this.readCurrent()
        } catch (err) {
          lastError = err
          continue
        }
        // Deliberately outside the K8s try/catch: a failed read means the lock
        // session is gone, and the only safe outcome is to abort without writing.
        const snapshot = await readAllowlistSnapshot(db)
        if (
          mode === 'if-changed' &&
          current?.metadata?.annotations?.[CONTENT_HASH_ANNOTATION] === snapshot.contentHash
        ) {
          return 'unchanged'
        }
        try {
          await this.write(snapshot, current)
          return 'written'
        } catch (err) {
          lastError = err
        }
      }
      throw lastError
    }, this.txPool)
  }

  private async readCurrent(): Promise<k8s.V1ConfigMap | null> {
    try {
      return await withK8sTimeout('read', this.k8sCallTimeoutMs, () =>
        this.coreApi.readNamespacedConfigMap({
          namespace: this.namespace,
          name: ALLOWED_MODELS_CONFIGMAP_NAME,
        })
      )
    } catch (err) {
      if (isErrorCode(err, 404)) return null
      throw err
    }
  }

  private async write(snapshot: AllowlistSnapshot, current: k8s.V1ConfigMap | null): Promise<void> {
    const body: k8s.V1ConfigMap = {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: {
        name: ALLOWED_MODELS_CONFIGMAP_NAME,
        namespace: this.namespace,
        labels: { [MANAGED_BY_LABEL]: 'control-api' },
        annotations: {
          [CONTENT_HASH_ANNOTATION]: snapshot.contentHash,
          ...snapshot.readiness,
        },
      },
      data: snapshot.data,
    }
    if (!current) {
      await withK8sTimeout('create', this.k8sCallTimeoutMs, () =>
        this.coreApi.createNamespacedConfigMap({ namespace: this.namespace, body })
      )
      return
    }
    const resourceVersion = current.metadata?.resourceVersion
    // Without a version the replace would be unconditional and lose the CAS.
    if (!resourceVersion) throw new Error('allowlist ConfigMap has no resourceVersion')
    body.metadata!.resourceVersion = resourceVersion
    await withK8sTimeout('replace', this.k8sCallTimeoutMs, () =>
      this.coreApi.replaceNamespacedConfigMap({
        namespace: this.namespace,
        name: ALLOWED_MODELS_CONFIGMAP_NAME,
        body,
      })
    )
  }
}
