import type { DbClient } from '../db.js'
import { rootLogger } from '../observability/logger.js'
import {
  type CodexSubscriptionCatalogStatus,
  type CodexSubscriptionConnectionStatus,
  type CodexSubscriptionSafeConnection,
  getSafeCodexSubscriptionConnection,
  recordCodexCatalogOutcome,
} from './codexSubscriptionConnection.js'

const log = rootLogger.child({ module: 'codex-subscription-catalog' })
const PROVIDER = 'codex-subscription'

export type CodexCatalogOutcome = 'ready' | 'auth-rejected' | 'unavailable'

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
  refresh: string[]
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

export async function syncCodexSubscriptionCatalog(
  db: DbClient,
  transport: CodexCatalogTransport,
  accessToken: string,
  expected?: { credentialRevision: number; catalogRevision: number }
): Promise<{
  outcome: CodexCatalogOutcome
  connection: CodexSubscriptionSafeConnection | null
  added: number
  refreshed: number
  staled: number
}> {
  const connection = await getSafeCodexSubscriptionConnection(db)
  if (!connection || connection.status === 'revoked' || connection.status === 'disconnected') {
    throw new Error('codex_subscription_not_connected')
  }
  const expectedCredentialRevision = expected?.credentialRevision ?? connection.credentialRevision
  const expectedCatalogRevision = expected?.catalogRevision ?? connection.catalogRevision
  const result = await transport.listModels({ accessToken })
  const existing = await loadCodexRows(db)
  const plan = planCodexCatalogReconcile(existing, result)
  const recorded = await recordCodexCatalogOutcome(db, {
    catalogStatus: plan.catalogStatus as CodexSubscriptionCatalogStatus,
    connectionStatus: plan.connectionStatus,
    expectedCredentialRevision,
    expectedCatalogRevision,
  })
  let added = 0
  let refreshed = 0
  let staled = 0
  if (recorded && plan.mutateRows) {
    added = await insertDiscovered(db, plan.inserts)
    refreshed = await refreshDiscovered(db, plan.refresh)
    staled = await staleMissing(db, plan.stale)
  }
  if (!recorded) {
    log.warn(
      { event: 'codex_catalog_stale_writer' },
      'catalog outcome lost the connection revision race'
    )
  } else {
    log.info(
      {
        event: 'codex_catalog_reconciled',
        outcome: plan.catalogStatus,
        added,
        refreshed,
        staled,
      },
      'Codex catalog reconciled'
    )
  }
  return {
    outcome: plan.catalogStatus,
    connection: recorded,
    added,
    refreshed,
    staled,
  }
}

export function createUnavailableCodexCatalogTransport(): CodexCatalogTransport {
  return {
    async listModels() {
      return { outcome: 'unavailable' }
    },
  }
}

async function loadCodexRows(db: DbClient): Promise<CodexCatalogRow[]> {
  const result = await db.query(
    `SELECT model, source, enabled, stale
       FROM llm_allowed_models
      WHERE provider = $1`,
    [PROVIDER]
  )
  return (result.rows as Array<Record<string, unknown>>).map(row => ({
    model: String(row.model),
    source: row.source === 'manual' ? 'manual' : 'discovery',
    enabled: row.enabled === true,
    stale: row.stale === true,
  }))
}

async function insertDiscovered(db: DbClient, models: CodexDiscoveredModel[]): Promise<number> {
  let added = 0
  for (const model of models) {
    const result = await db.query(
      `INSERT INTO llm_allowed_models
         (provider, model, enabled, source, discovered_at, last_seen_at, stale, display_name, context_window_tokens, vendor)
       VALUES ($1, $2, false, 'discovery', NOW(), NOW(), false, $3, $4, 'OpenAI')
       ON CONFLICT (provider, model) DO NOTHING`,
      [PROVIDER, model.model, model.displayName ?? null, model.contextWindowTokens ?? null]
    )
    added += result.rowCount ?? 0
  }
  return added
}

async function refreshDiscovered(db: DbClient, models: string[]): Promise<number> {
  if (models.length === 0) return 0
  const result = await db.query(
    `UPDATE llm_allowed_models
        SET last_seen_at = NOW(),
            stale = false
      WHERE provider = $1
        AND source = 'discovery'
        AND model = ANY($2::text[])`,
    [PROVIDER, models]
  )
  return result.rowCount ?? 0
}

async function staleMissing(db: DbClient, models: string[]): Promise<number> {
  if (models.length === 0) return 0
  const result = await db.query(
    `UPDATE llm_allowed_models
        SET stale = true
      WHERE provider = $1
        AND source = 'discovery'
        AND model = ANY($2::text[])`,
    [PROVIDER, models]
  )
  return result.rowCount ?? 0
}
