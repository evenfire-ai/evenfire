import jwt from 'jsonwebtoken'
import { CATALOG_ORIGIN } from '@clerum/grok-provider-attempt-contract'
import { config } from '../config.js'
import { type DbClient, withTransaction } from '../db.js'
import { rootLogger } from '../observability/logger.js'
import {
  type GrokSubscriptionCatalogStatus,
  type GrokSubscriptionConnectionStatus,
  type GrokSubscriptionSafeConnection,
  getSafeGrokSubscriptionConnection,
  isGrokUnassignedConnectionKey,
  readHostGrokConnectionRef,
  recordGrokCatalogOutcome,
} from './grokSubscriptionConnection.js'
import { boundDiscoveredCatalogModels } from './subscriptionCatalogBounds.js'

const log = rootLogger.child({ module: 'grok-subscription-catalog' })
const PROVIDER = 'grok-subscription'

export const GROK_CATALOG_ORIGIN = CATALOG_ORIGIN

export type GrokCatalogOutcome = 'ready' | 'auth-rejected' | 'unavailable'

/**
 * Runs `work` inside one database transaction and commits only when it
 * resolves. Production uses the Control API pool (`withTransaction` in db.ts),
 * which is the same pool behind the admin routes' DbClient; tests inject a
 * runner bound to their own pool.
 */
export type GrokTransactionRunner = <T>(work: (tx: DbClient) => Promise<T>) => Promise<T>

export const defaultGrokTransactionRunner: GrokTransactionRunner = work => withTransaction(work)

export type GrokDiscoveredModel = {
  model: string
  displayName?: string
  contextWindowTokens?: number
}

export type GrokCatalogTransportResult =
  | { outcome: 'ready'; models: GrokDiscoveredModel[] }
  | { outcome: 'auth-rejected' }
  | { outcome: 'unavailable' }

export type GrokCatalogTransport = {
  listModels(input: { accessToken: string }): Promise<GrokCatalogTransportResult>
}

export type GrokCatalogRow = {
  model: string
  source: 'manual' | 'discovery'
  enabled: boolean
  stale: boolean
}

export type GrokCatalogPlan = {
  inserts: GrokDiscoveredModel[]
  refresh: string[]
  stale: string[]
  catalogStatus: GrokCatalogOutcome
  connectionStatus?: Extract<GrokSubscriptionConnectionStatus, 'reauth_required'>
  mutateRows: boolean
}

export function planGrokCatalogReconcile(
  existing: GrokCatalogRow[],
  result: GrokCatalogTransportResult
): GrokCatalogPlan {
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
  const inserts: GrokDiscoveredModel[] = []
  const refresh: string[] = []
  const stale: string[] = []
  for (const model of discovered.values()) {
    const row = existing.find(candidate => candidate.model === model.model)
    if (!row) {
      inserts.push(model)
      continue
    }
    if (row.source === 'manual') continue
    refresh.push(row.model)
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

export async function getGrokCatalogModelState(
  db: DbClient,
  connectionId: string,
  model: string
): Promise<{ enabled: boolean; stale: boolean } | null> {
  const result = await db.query(
    `SELECT enabled, stale
       FROM grok_catalog_models
      WHERE connection_id = $1
        AND model = $2
      LIMIT 1`,
    [connectionId, model]
  )
  const row = result.rows[0] as { enabled?: boolean; stale?: boolean } | undefined
  if (!row) return null
  return { enabled: row.enabled === true, stale: row.stale === true }
}

export async function isGrokAssignmentAllowed(
  db: DbClient,
  connectionRef: string,
  model: string
): Promise<boolean> {
  const key = readHostGrokConnectionRef(connectionRef)
  if (isGrokUnassignedConnectionKey(key)) return false
  const connection = await getSafeGrokSubscriptionConnection(db, key)
  if (
    !connection ||
    connection.status !== 'connected' ||
    connection.revokedAt ||
    connection.catalogStatus !== 'ready'
  ) {
    return false
  }
  const state = await getGrokCatalogModelState(db, connection.id, model)
  return Boolean(state?.enabled && !state.stale)
}

export function pickGrokGrantModel(
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

export async function listOfferedGrokModelsForAssignment(
  db: DbClient,
  connectionKey: string
): Promise<string[]> {
  const result = await db.query(
    `SELECT m.model
       FROM grok_catalog_models m
       JOIN grok_subscription_connections c ON c.id = m.connection_id
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

export async function listEnabledGrokModelsGroupedByConnection(
  db: DbClient
): Promise<Record<string, string[]>> {
  const result = await db.query(
    `SELECT c.connection_key AS connection_key, m.model
       FROM grok_catalog_models m
       JOIN grok_subscription_connections c ON c.id = m.connection_id
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

export async function listGrokCatalogModels(
  db: DbClient,
  connectionId: string
): Promise<Array<{ model: string; enabled: boolean; stale: boolean }>> {
  const result = await db.query(
    `SELECT model, enabled, stale
       FROM grok_catalog_models
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

export async function setGrokCatalogModelEnabled(
  db: DbClient,
  connectionId: string,
  model: string,
  enabled: boolean
): Promise<Array<{ model: string; enabled: boolean; stale: boolean }> | null> {
  const updated = await db.query(
    `UPDATE grok_catalog_models
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
      `UPDATE grok_subscription_connections
          SET default_model = NULL,
              updated_at = now()
        WHERE id = $1
          AND default_model = $2
          AND revoked_at IS NULL`,
      [connectionId, model]
    )
  }
  await rebuildLiveGrokUnionAllowlist(db)
  return listGrokCatalogModels(db, connectionId)
}

export async function rebuildLiveGrokUnionAllowlist(db: DbClient): Promise<void> {
  await db.query(
    `INSERT INTO llm_allowed_models
       (provider, model, enabled, source, stale, display_name, context_window_tokens, vendor, last_seen_at)
     SELECT $1, m.model, true, 'discovery', false,
            MIN(m.display_name), MAX(m.context_window_tokens), 'xAI', NOW()
       FROM grok_catalog_models m
       JOIN grok_subscription_connections c ON c.id = m.connection_id
      WHERE c.revoked_at IS NULL
        AND m.enabled
        AND m.stale = false
      GROUP BY m.model
     ON CONFLICT (provider, model) DO UPDATE
        SET enabled = true,
            stale = false,
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
            FROM grok_catalog_models m
            JOIN grok_subscription_connections c ON c.id = m.connection_id
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
export async function syncGrokSubscriptionCatalog(
  db: DbClient,
  transport: GrokCatalogTransport,
  accessToken: string,
  expected: { credentialRevision?: number; catalogRevision?: number; connectionKey: string },
  options: { withTransaction?: GrokTransactionRunner } = {}
): Promise<{
  outcome: GrokCatalogOutcome
  connection: GrokSubscriptionSafeConnection | null
  added: number
  refreshed: number
  staled: number
}> {
  const connection = await getSafeGrokSubscriptionConnection(db, expected.connectionKey)
  if (!connection || connection.status === 'revoked' || connection.status === 'disconnected') {
    throw new Error('grok_subscription_not_connected')
  }
  const expectedCredentialRevision = expected.credentialRevision ?? connection.credentialRevision
  const expectedCatalogRevision = expected.catalogRevision ?? connection.catalogRevision
  const result = boundGrokCatalogResult(await transport.listModels({ accessToken }))
  const outcomePlan = planGrokCatalogReconcile([], result)
  const runInTransaction = options.withTransaction ?? defaultGrokTransactionRunner
  const committed = await runInTransaction(async tx => {
    const recorded = await recordGrokCatalogOutcome(tx, {
      catalogStatus: outcomePlan.catalogStatus as GrokSubscriptionCatalogStatus,
      connectionStatus: outcomePlan.connectionStatus,
      expectedCredentialRevision,
      expectedCatalogRevision,
      connectionKey: expected.connectionKey,
    })
    if (!recorded || !outcomePlan.mutateRows) {
      return { recorded, added: 0, refreshed: 0, staled: 0 }
    }
    const plan = planGrokCatalogReconcile(await loadGrokRows(tx, connection.id), result)
    const added = await insertDiscovered(tx, connection.id, plan.inserts)
    const refreshed = await refreshDiscovered(tx, connection.id, plan.refresh)
    const staled = await staleMissing(tx, connection.id, plan.stale)
    await rebuildLiveGrokUnionAllowlist(tx)
    return { recorded, added, refreshed, staled }
  })
  const { recorded, added, refreshed, staled } = committed
  if (!recorded) {
    log.warn(
      { event: 'grok_catalog_stale_writer' },
      'catalog outcome lost the connection revision race'
    )
  } else {
    log.info(
      {
        event: 'grok_catalog_reconciled',
        outcome: outcomePlan.catalogStatus,
        added,
        refreshed,
        staled,
      },
      'Grok catalog reconciled'
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

function boundGrokCatalogResult(result: GrokCatalogTransportResult): GrokCatalogTransportResult {
  if (result.outcome !== 'ready') return result
  const bounded = boundDiscoveredCatalogModels(result.models)
  if (bounded.droppedInvalidId > 0 || bounded.droppedOverCount > 0) {
    log.warn(
      {
        event: 'grok_catalog_discovery_bounded',
        discovered: result.models.length,
        kept: bounded.models.length,
        droppedInvalidId: bounded.droppedInvalidId,
        droppedOverCount: bounded.droppedOverCount,
      },
      'Grok catalog discovery exceeded bounds; extra models were ignored'
    )
  }
  return { outcome: 'ready', models: bounded.models }
}

export function createUnavailableGrokCatalogTransport(): GrokCatalogTransport {
  return {
    async listModels() {
      return { outcome: 'unavailable' }
    },
  }
}

export function signGrokAdminPermit(operation: 'catalog_list' | 'connection_test'): string {
  return jwt.sign(
    { sub: 'control-api', typ: 'grok-admin-permit', operation },
    config.adminJwtPrivateKey,
    {
      algorithm: 'RS256',
      issuer: config.adminJwtIssuer,
      audience: 'grok-llm-proxy-admin',
      expiresIn: 60,
    }
  )
}

export function createGrokProxyCatalogTransport(deps: {
  adminBaseUrl: string
  fetchFn?: typeof fetch
  signPermit?: (operation: 'catalog_list' | 'connection_test') => string
}): GrokCatalogTransport {
  const fetchFn = deps.fetchFn ?? fetch
  const signPermit = deps.signPermit ?? signGrokAdminPermit
  return {
    async listModels(input: { accessToken: string }): Promise<GrokCatalogTransportResult> {
      const base = deps.adminBaseUrl.replace(/\/+$/, '')
      let response: Response
      try {
        response = await fetchFn(`${base}/internal/admin/v1/grok/models`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${signPermit('catalog_list')}`,
          },
          body: JSON.stringify({ accessToken: input.accessToken }),
        })
      } catch (err) {
        log.warn({ event: 'grok_catalog_proxy_unreachable', err }, 'Grok catalog proxy unreachable')
        return { outcome: 'unavailable' }
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) return { outcome: 'auth-rejected' }
        return { outcome: 'unavailable' }
      }
      const body = (await response.json()) as {
        outcome?: GrokCatalogOutcome
        models?: GrokDiscoveredModel[]
      }
      if (body.outcome === 'auth-rejected' || body.outcome === 'unavailable') {
        return { outcome: body.outcome }
      }
      return { outcome: 'ready', models: Array.isArray(body.models) ? body.models : [] }
    },
  }
}

export function createGrokCatalogTransportFromEnv(
  env: NodeJS.ProcessEnv = process.env
): GrokCatalogTransport {
  const adminBaseUrl = env.GROK_LLM_PROXY_ADMIN_URL?.trim() ?? ''
  if (!adminBaseUrl) return createUnavailableGrokCatalogTransport()
  return createGrokProxyCatalogTransport({ adminBaseUrl })
}

async function loadGrokRows(db: DbClient, connectionId: string): Promise<GrokCatalogRow[]> {
  const result = await db.query(
    `SELECT model, source, enabled, stale
       FROM grok_catalog_models
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
  models: GrokDiscoveredModel[]
): Promise<number> {
  let added = 0
  for (const model of models) {
    const result = await db.query(
      `INSERT INTO grok_catalog_models
         (connection_id, model, enabled, source, discovered_at, last_seen_at, stale, display_name, context_window_tokens)
       VALUES ($1, $2, true, 'discovery', NOW(), NOW(), false, $3, $4)
       ON CONFLICT (connection_id, model) DO NOTHING`,
      [connectionId, model.model, model.displayName ?? null, model.contextWindowTokens ?? null]
    )
    added += result.rowCount ?? 0
  }
  return added
}

async function refreshDiscovered(
  db: DbClient,
  connectionId: string,
  models: string[]
): Promise<number> {
  if (models.length === 0) return 0
  const result = await db.query(
    `UPDATE grok_catalog_models
        SET last_seen_at = NOW(),
            stale = false,
            updated_at = NOW()
      WHERE connection_id = $1
        AND source = 'discovery'
        AND model = ANY($2::text[])`,
    [connectionId, models]
  )
  return result.rowCount ?? 0
}

async function staleMissing(db: DbClient, connectionId: string, models: string[]): Promise<number> {
  if (models.length === 0) return 0
  const result = await db.query(
    `UPDATE grok_catalog_models
        SET stale = true,
            updated_at = NOW()
      WHERE connection_id = $1
        AND source = 'discovery'
        AND model = ANY($2::text[])`,
    [connectionId, models]
  )
  return result.rowCount ?? 0
}
