import jwt from 'jsonwebtoken'
import { config } from '../config.js'
import { type DbClient, withTransaction } from '../db.js'
import { rootLogger } from '../observability/logger.js'
import {
  CODEX_SUBSCRIPTION_CONNECTION_KEY,
  type CodexSubscriptionCatalogStatus,
  type CodexSubscriptionConnectionStatus,
  type CodexSubscriptionSafeConnection,
  getSafeCodexSubscriptionConnection,
  isCodexUnassignedConnectionKey,
  normalizeCodexConnectionKey,
  readHostCodexConnectionRef,
  recordCodexCatalogOutcome,
} from './codexSubscriptionConnection.js'
import { boundDiscoveredCatalogModels } from './subscriptionCatalogBounds.js'

const log = rootLogger.child({ module: 'codex-subscription-catalog' })
const PROVIDER = 'codex-subscription'

export type CodexCatalogOutcome = 'ready' | 'auth-rejected' | 'unavailable'

/**
 * Runs `work` inside one database transaction and commits only when it
 * resolves.
 */
export type CodexTransactionRunner = <T>(work: (tx: DbClient) => Promise<T>) => Promise<T>

type PoolLike = DbClient & {
  connect: () => Promise<DbClient & { release: (err?: Error | boolean) => void }>
  totalCount: number
}

function isPoolLike(db: DbClient): db is PoolLike {
  const candidate = db as Partial<PoolLike>
  return typeof candidate.connect === 'function' && typeof candidate.totalCount === 'number'
}

/**
 * Transaction runner for the DbClient a caller passed. A pg Pool gets a
 * dedicated session from that same pool (real-PostgreSQL callers); any other
 * DbClient (the admin routes' `{ query }` wrapper around the Control API pool)
 * uses the Control API pool's `withTransaction`.
 */
export function codexTransactionRunnerFor(db: DbClient): CodexTransactionRunner {
  if (!isPoolLike(db)) return work => withTransaction(work)
  return async work => {
    const client = await db.connect()
    let releaseError: Error | boolean | undefined
    try {
      await client.query('BEGIN')
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch (rollbackError) {
        releaseError = rollbackError instanceof Error ? rollbackError : true
      }
      throw err
    } finally {
      client.release(releaseError)
    }
  }
}

export type CodexDiscoveredModel = {
  model: string
  displayName?: string
  contextWindowTokens?: number
}

export type CodexCatalogTransportResult =
  | { outcome: 'ready'; models: CodexDiscoveredModel[] }
  | { outcome: 'auth-rejected' }
  | { outcome: 'unavailable' }

export type CodexCatalogTransport = {
  listModels(input: { accessToken: string }): Promise<CodexCatalogTransportResult>
}

export type CodexCatalogRow = {
  model: string
  source: 'manual' | 'discovery'
  enabled: boolean
  stale: boolean
}

export type CodexCatalogPlan = {
  inserts: CodexDiscoveredModel[]
  /** Existing discovery rows seen again, carrying what the catalog now reports. */
  refresh: CodexDiscoveredModel[]
  stale: string[]
  catalogStatus: CodexCatalogOutcome
  connectionStatus?: Extract<CodexSubscriptionConnectionStatus, 'reauth_required'>
  mutateRows: boolean
}

export function planCodexCatalogReconcile(
  existing: CodexCatalogRow[],
  result: CodexCatalogTransportResult
): CodexCatalogPlan {
  if (result.outcome === 'auth-rejected') {
    return {
      inserts: [],
      refresh: [],
      stale: [],
      catalogStatus: 'auth-rejected',
      connectionStatus: 'reauth_required',
      mutateRows: false,
    }
  }
  if (result.outcome === 'unavailable') {
    return {
      inserts: [],
      refresh: [],
      stale: [],
      catalogStatus: 'unavailable',
      mutateRows: false,
    }
  }

  const discovered = new Map(result.models.map(model => [model.model, model]))
  const inserts: CodexDiscoveredModel[] = []
  const refresh: CodexDiscoveredModel[] = []
  const stale: string[] = []
  for (const model of discovered.values()) {
    const row = existing.find(candidate => candidate.model === model.model)
    if (!row) {
      inserts.push(model)
      continue
    }
    if (row.source === 'manual') continue
    refresh.push(model)
  }
  for (const row of existing) {
    if (row.source !== 'discovery') continue
    if (!discovered.has(row.model)) stale.push(row.model)
  }
  return {
    inserts,
    refresh,
    stale,
    catalogStatus: 'ready',
    mutateRows: true,
  }
}

export async function applyCodexCatalogModelsSchema(db: DbClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS codex_catalog_models (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      connection_id UUID NOT NULL REFERENCES codex_subscription_connections(id),
      model TEXT NOT NULL,
      display_name TEXT,
      context_window_tokens INTEGER,
      enabled BOOLEAN NOT NULL DEFAULT false,
      source TEXT NOT NULL CHECK (source IN ('manual', 'discovery')),
      stale BOOLEAN NOT NULL DEFAULT false,
      discovered_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT codex_catalog_models_connection_model_unique UNIQUE (connection_id, model)
    );

    REVOKE ALL PRIVILEGES ON TABLE codex_catalog_models FROM PUBLIC;
    REVOKE ALL PRIVILEGES ON TABLE codex_catalog_models
      FROM trace_maintenance_runtime, workflow_recipes_runtime;
    GRANT SELECT, INSERT, UPDATE ON TABLE codex_catalog_models TO control_api_runtime;
    REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE codex_catalog_models FROM control_api_runtime;

    INSERT INTO codex_catalog_models (
      connection_id, model, display_name, context_window_tokens, enabled, source, stale,
      discovered_at, last_seen_at
    )
    SELECT c.id, m.model, m.display_name, m.context_window_tokens, m.enabled, m.source, m.stale,
           m.discovered_at, m.last_seen_at
      FROM llm_allowed_models m
      JOIN codex_subscription_connections c
        ON c.connection_key = '${CODEX_SUBSCRIPTION_CONNECTION_KEY}'
     WHERE m.provider = '${PROVIDER}'
    ON CONFLICT (connection_id, model) DO NOTHING;
  `)
}

export async function getCodexCatalogModelState(
  db: DbClient,
  connectionId: string,
  model: string
): Promise<{ enabled: boolean; stale: boolean } | null> {
  const result = await db.query(
    `SELECT enabled, stale
       FROM codex_catalog_models
      WHERE connection_id = $1
        AND model = $2
      LIMIT 1`,
    [connectionId, model]
  )
  const row = result.rows[0] as { enabled?: boolean; stale?: boolean } | undefined
  if (!row) return null
  return { enabled: row.enabled === true, stale: row.stale === true }
}

export async function isCodexAssignmentAllowed(
  db: DbClient,
  connectionRef: string,
  model: string
): Promise<boolean> {
  const key = readHostCodexConnectionRef(connectionRef)
  if (isCodexUnassignedConnectionKey(key)) return false
  const connection = await getSafeCodexSubscriptionConnection(db, key)
  if (
    !connection ||
    connection.status !== 'connected' ||
    connection.revokedAt ||
    connection.catalogStatus !== 'ready'
  ) {
    return false
  }
  const state = await getCodexCatalogModelState(db, connection.id, model)
  return Boolean(state?.enabled && !state.stale)
}

/**
 * ChatGPT bind still needs a concrete spec.model.name. Keep the current name
 * only when that grant already offers it. Otherwise seed the first offered
 * model — never invent deployment-default or a global allowlist default.
 */
export function pickCodexGrantModel(
  current: string,
  offered: string[],
  grantDefault?: string | null
): string {
  const trimmed = current.trim()
  if (trimmed && offered.includes(trimmed)) return trimmed
  const fallback = grantDefault?.trim() ?? ''
  if (fallback && offered.includes(fallback)) return fallback
  return offered[0] ?? ''
}

/** Enabled, non-stale models on a connected grant whose catalog is ready. */
export async function listOfferedCodexModelsForAssignment(
  db: DbClient,
  connectionKey: string
): Promise<string[]> {
  const result = await db.query(
    `SELECT m.model
       FROM codex_catalog_models m
       JOIN codex_subscription_connections c ON c.id = m.connection_id
      WHERE c.connection_key = $1
        AND c.revoked_at IS NULL
        AND c.status = 'connected'
        AND c.catalog_status = 'ready'
        AND m.enabled
        AND m.stale = false
      ORDER BY m.model ASC`,
    [connectionKey]
  )
  return (result.rows as Array<{ model: string }>).map(row => String(row.model))
}

export async function listEnabledCodexModelsGroupedByConnection(
  db: DbClient
): Promise<Record<string, string[]>> {
  const result = await db.query(
    `SELECT c.connection_key AS connection_key, m.model
       FROM codex_catalog_models m
       JOIN codex_subscription_connections c ON c.id = m.connection_id
      WHERE c.revoked_at IS NULL
        AND m.enabled
        AND m.stale = false
      ORDER BY c.connection_key ASC, m.model ASC`
  )
  const grouped: Record<string, string[]> = {}
  for (const row of result.rows as Array<{ connection_key: string; model: string }>) {
    const key = String(row.connection_key)
    grouped[key] ??= []
    grouped[key].push(String(row.model))
  }
  return grouped
}

export async function setCodexCatalogModelEnabled(
  db: DbClient,
  connectionId: string,
  model: string,
  enabled: boolean
): Promise<Array<{ model: string; enabled: boolean; stale: boolean }> | null> {
  const updated = await db.query(
    `UPDATE codex_catalog_models
        SET enabled = $3,
            updated_at = now()
      WHERE connection_id = $1
        AND model = $2
      RETURNING model`,
    [connectionId, model, enabled]
  )
  if (updated.rowCount === 0) return null
  if (!enabled) {
    await db.query(
      `UPDATE codex_subscription_connections
          SET default_model = NULL,
              updated_at = now()
        WHERE id = $1
          AND default_model = $2
          AND revoked_at IS NULL`,
      [connectionId, model]
    )
  }
  await rebuildLiveCodexUnionAllowlist(db)
  return listCodexCatalogModels(db, connectionId)
}

export async function listCodexCatalogModels(
  db: DbClient,
  connectionId: string
): Promise<Array<{ model: string; enabled: boolean; stale: boolean }>> {
  const result = await db.query(
    `SELECT model, enabled, stale
       FROM codex_catalog_models
      WHERE connection_id = $1
      ORDER BY model ASC`,
    [connectionId]
  )
  return (result.rows as Array<Record<string, unknown>>).map(row => ({
    model: String(row.model),
    enabled: row.enabled === true,
    stale: row.stale === true,
  }))
}

// Derived cache for the LLM Models table. Runtime eligibility uses
// `codex_catalog_models` per connection, not these global toggles.
export async function rebuildLiveCodexUnionAllowlist(db: DbClient): Promise<void> {
  await db.query(
    `INSERT INTO llm_allowed_models
       (provider, model, enabled, source, stale, display_name, context_window_tokens, vendor, last_seen_at)
     SELECT $1, m.model, true, 'discovery', false,
            MIN(m.display_name), MAX(m.context_window_tokens), 'OpenAI', NOW()
       FROM codex_catalog_models m
       JOIN codex_subscription_connections c ON c.id = m.connection_id
      WHERE c.revoked_at IS NULL
        AND m.enabled
        AND m.stale = false
      GROUP BY m.model
     ON CONFLICT (provider, model) DO UPDATE
        SET enabled = true,
            stale = false,
            display_name = COALESCE(EXCLUDED.display_name, llm_allowed_models.display_name),
            context_window_tokens = COALESCE(
              EXCLUDED.context_window_tokens,
              llm_allowed_models.context_window_tokens
            ),
            last_seen_at = NOW()`,
    [PROVIDER]
  )
  await db.query(
    `UPDATE llm_allowed_models
        SET enabled = false,
            stale = true
      WHERE provider = $1
        AND model NOT IN (
          SELECT DISTINCT m.model
            FROM codex_catalog_models m
            JOIN codex_subscription_connections c ON c.id = m.connection_id
           WHERE c.revoked_at IS NULL
             AND m.enabled
             AND m.stale = false
        )`,
    [PROVIDER]
  )
}

/**
 * Reconcile one connection's catalog. The provider call runs outside any
 * transaction; the fenced readiness/revision write, the model row
 * insert/refresh/stale and the live union rebuild commit together, so a
 * failure in any phase leaves readiness, revision and rows untouched. The
 * fenced UPDATE row-locks the connection first, so concurrent syncs on one
 * revision serialize and exactly one commits an outcome. Callers publish the
 * runtime allowlist only after this resolves (i.e. after commit).
 */
export async function syncCodexSubscriptionCatalog(
  db: DbClient,
  transport: CodexCatalogTransport,
  accessToken: string,
  expected?: { credentialRevision?: number; catalogRevision?: number; connectionKey?: string },
  options: { withTransaction?: CodexTransactionRunner } = {}
): Promise<{
  outcome: CodexCatalogOutcome
  connection: CodexSubscriptionSafeConnection | null
  added: number
  refreshed: number
  staled: number
}> {
  const connectionKey = normalizeCodexConnectionKey(expected?.connectionKey)
  const connection = await getSafeCodexSubscriptionConnection(db, connectionKey)
  if (!connection || connection.status === 'revoked' || connection.status === 'disconnected') {
    throw new Error('codex_subscription_not_connected')
  }
  const expectedCredentialRevision = expected?.credentialRevision ?? connection.credentialRevision
  const expectedCatalogRevision = expected?.catalogRevision ?? connection.catalogRevision
  const result = boundCodexCatalogResult(await transport.listModels({ accessToken }))
  const outcomePlan = planCodexCatalogReconcile([], result)
  const runInTransaction = options.withTransaction ?? codexTransactionRunnerFor(db)
  const committed = await runInTransaction(async tx => {
    const recorded = await recordCodexCatalogOutcome(tx, {
      catalogStatus: outcomePlan.catalogStatus as CodexSubscriptionCatalogStatus,
      connectionStatus: outcomePlan.connectionStatus,
      expectedCredentialRevision,
      expectedCatalogRevision,
      connectionKey,
    })
    if (!recorded || !outcomePlan.mutateRows) {
      return { recorded, added: 0, refreshed: 0, staled: 0 }
    }
    const plan = planCodexCatalogReconcile(await loadCodexRows(tx, connection.id), result)
    const added = await insertDiscovered(tx, connection.id, plan.inserts)
    const refreshed = await refreshDiscovered(tx, connection.id, plan.refresh)
    const staled = await staleMissing(tx, connection.id, plan.stale)
    await rebuildLiveCodexUnionAllowlist(tx)
    return { recorded, added, refreshed, staled }
  })
  const { recorded, added, refreshed, staled } = committed
  if (!recorded) {
    log.warn(
      { event: 'codex_catalog_stale_writer' },
      'catalog outcome lost the connection revision race'
    )
  } else {
    log.info(
      {
        event: 'codex_catalog_reconciled',
        outcome: outcomePlan.catalogStatus,
        added,
        refreshed,
        staled,
      },
      'Codex catalog reconciled'
    )
  }
  return {
    outcome: outcomePlan.catalogStatus,
    connection: recorded,
    added,
    refreshed,
    staled,
  }
}

function boundCodexCatalogResult(result: CodexCatalogTransportResult): CodexCatalogTransportResult {
  if (result.outcome !== 'ready') return result
  const bounded = boundDiscoveredCatalogModels(result.models)
  if (bounded.droppedInvalidId > 0 || bounded.droppedOverCount > 0) {
    log.warn(
      {
        event: 'codex_catalog_discovery_bounded',
        discovered: result.models.length,
        kept: bounded.models.length,
        droppedInvalidId: bounded.droppedInvalidId,
        droppedOverCount: bounded.droppedOverCount,
      },
      'Codex catalog discovery exceeded bounds; extra models were ignored'
    )
  }
  return { outcome: 'ready', models: bounded.models }
}

export function createUnavailableCodexCatalogTransport(): CodexCatalogTransport {
  return {
    async listModels() {
      return { outcome: 'unavailable' }
    },
  }
}

export function signCodexAdminPermit(operation: 'catalog_list' | 'connection_test'): string {
  return jwt.sign(
    { sub: 'control-api', typ: 'codex-admin-permit', operation },
    config.adminJwtPrivateKey,
    {
      algorithm: 'RS256',
      issuer: config.adminJwtIssuer,
      audience: 'codex-llm-proxy-admin',
      expiresIn: 60,
    }
  )
}

export function createCodexProxyCatalogTransport(deps: {
  adminBaseUrl: string
  fetchFn?: typeof fetch
  signPermit?: (operation: 'catalog_list' | 'connection_test') => string
}): CodexCatalogTransport {
  const fetchFn = deps.fetchFn ?? fetch
  const signPermit = deps.signPermit ?? signCodexAdminPermit
  return {
    async listModels(input: { accessToken: string }): Promise<CodexCatalogTransportResult> {
      const base = deps.adminBaseUrl.replace(/\/+$/, '')
      let response: Response
      try {
        response = await fetchFn(`${base}/internal/admin/v1/codex/models`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${signPermit('catalog_list')}`,
          },
          body: JSON.stringify({ accessToken: input.accessToken }),
        })
      } catch (err) {
        log.warn(
          { event: 'codex_catalog_proxy_unreachable', err },
          'Codex catalog proxy unreachable'
        )
        return { outcome: 'unavailable' }
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) return { outcome: 'auth-rejected' }
        return { outcome: 'unavailable' }
      }
      const body = (await response.json()) as {
        outcome?: CodexCatalogOutcome
        models?: CodexDiscoveredModel[]
      }
      if (body.outcome === 'auth-rejected' || body.outcome === 'unavailable') {
        return { outcome: body.outcome }
      }
      return { outcome: 'ready', models: Array.isArray(body.models) ? body.models : [] }
    },
  }
}

export function createCodexCatalogTransportFromEnv(
  env: NodeJS.ProcessEnv = process.env
): CodexCatalogTransport {
  const adminBaseUrl = env.CODEX_LLM_PROXY_ADMIN_URL?.trim() ?? ''
  if (!adminBaseUrl) return createUnavailableCodexCatalogTransport()
  return createCodexProxyCatalogTransport({ adminBaseUrl })
}

async function loadCodexRows(db: DbClient, connectionId: string): Promise<CodexCatalogRow[]> {
  const result = await db.query(
    `SELECT model, source, enabled, stale
       FROM codex_catalog_models
      WHERE connection_id = $1`,
    [connectionId]
  )
  return (result.rows as Array<Record<string, unknown>>).map(row => ({
    model: String(row.model),
    source: row.source === 'manual' ? 'manual' : 'discovery',
    enabled: row.enabled === true,
    stale: row.stale === true,
  }))
}

async function insertDiscovered(
  db: DbClient,
  connectionId: string,
  models: CodexDiscoveredModel[]
): Promise<number> {
  let added = 0
  for (const model of models) {
    const result = await db.query(
      `INSERT INTO codex_catalog_models
         (connection_id, model, enabled, source, discovered_at, last_seen_at, stale, display_name, context_window_tokens)
       VALUES ($1, $2, true, 'discovery', NOW(), NOW(), false, $3, $4)
       ON CONFLICT (connection_id, model) DO NOTHING`,
      [connectionId, model.model, model.displayName ?? null, model.contextWindowTokens ?? null]
    )
    added += result.rowCount ?? 0
  }
  return added
}

// A catalog that omits the window or the name keeps the stored one; it never
// clears it.
async function refreshDiscovered(
  db: DbClient,
  connectionId: string,
  models: CodexDiscoveredModel[]
): Promise<number> {
  if (models.length === 0) return 0
  const result = await db.query(
    `UPDATE codex_catalog_models AS m
        SET last_seen_at = NOW(),
            stale = false,
            updated_at = NOW(),
            display_name = COALESCE(seen.display_name, m.display_name),
            context_window_tokens = COALESCE(seen.context_window_tokens, m.context_window_tokens)
       FROM unnest($2::text[], $3::integer[], $4::text[])
            AS seen(model, context_window_tokens, display_name)
      WHERE m.connection_id = $1
        AND m.source = 'discovery'
        AND m.model = seen.model`,
    [
      connectionId,
      models.map(model => model.model),
      models.map(model => model.contextWindowTokens ?? null),
      models.map(model => model.displayName ?? null),
    ]
  )
  return result.rowCount ?? 0
}

async function staleMissing(db: DbClient, connectionId: string, models: string[]): Promise<number> {
  if (models.length === 0) return 0
  const result = await db.query(
    `UPDATE codex_catalog_models
        SET stale = true,
            updated_at = NOW()
      WHERE connection_id = $1
        AND source = 'discovery'
        AND model = ANY($2::text[])`,
    [connectionId, models]
  )
  return result.rowCount ?? 0
}
