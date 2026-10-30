/**
 * Per-provider catalog auto-enable policy: whether models newly discovered in
 * the public catalog start enabled. The code default lives in
 * `@clerum/llm-providers`; an operator override is a row in
 * `llm_provider_catalog_settings`. Without a row, the code default applies.
 *
 * Only providers with a public-catalog mapping (`PROVIDER_KEY_MAP`) have a
 * policy; the subscription providers keep their own dynamic catalogs.
 */
import type { Pool } from 'pg'
import { PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT } from '@clerum/llm-providers'
import { type DbClient, pool, withTransaction } from '../db.js'
import { acquireCatalogSyncLock } from './llmCatalogSyncLock.js'
import { type ModelsDevMappedProviderId, PROVIDER_KEY_MAP } from './modelsDevClient.js'

export type CatalogPolicyProviderId = ModelsDevMappedProviderId

export interface ProviderCatalogPolicy {
  provider: CatalogPolicyProviderId
  /** Effective value: the override if present, else the code default. */
  auto_enable: boolean
  default: boolean
  overridden: boolean
  updated_at: string | null
  updated_by: string | null
}

/**
 * The toggle could not take the catalog-sync lock before the statement
 * timeout: a sync run is holding it. Nothing was written; retrying is safe.
 */
export class CatalogPolicyLockTimeoutError extends Error {
  constructor() {
    super('catalog_sync_lock_timeout')
    this.name = 'CatalogPolicyLockTimeoutError'
  }
}

const CATALOG_POLICY_PROVIDERS = Object.keys(PROVIDER_KEY_MAP) as CatalogPolicyProviderId[]

// Own-property check: `provider` comes from the URL, and `in` would accept
// prototype keys such as `constructor`.
export function isCatalogPolicyProvider(value: unknown): value is CatalogPolicyProviderId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROVIDER_KEY_MAP, value)
}

interface SettingsRow {
  provider: string
  auto_enable: boolean
  updated_at: Date | string
  updated_by: string | null
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

function toPolicy(provider: CatalogPolicyProviderId, row: SettingsRow | undefined) {
  const codeDefault = PROVIDER_CATALOG_AUTO_ENABLE_DEFAULT[provider]
  return {
    provider,
    auto_enable: row ? row.auto_enable : codeDefault,
    default: codeDefault,
    overridden: row !== undefined,
    updated_at: row ? toIso(row.updated_at) : null,
    updated_by: row ? row.updated_by : null,
  } satisfies ProviderCatalogPolicy
}

async function readOverrides(db: DbClient): Promise<Map<string, SettingsRow>> {
  const result = await db.query(
    `SELECT provider, auto_enable, updated_at, updated_by
       FROM llm_provider_catalog_settings`
  )
  return new Map((result.rows as SettingsRow[]).map(row => [row.provider, row]))
}

/** Every catalog-mapped provider with its effective, default and override state. */
export async function listProviderCatalogPolicy(
  db: DbClient = pool
): Promise<ProviderCatalogPolicy[]> {
  const overrides = await readOverrides(db)
  return CATALOG_POLICY_PROVIDERS.map(provider => toPolicy(provider, overrides.get(provider)))
}

/**
 * The effective auto-enable policy for every catalog-mapped provider. A sync
 * run must call this once, on its own transaction client, AFTER taking the
 * catalog-sync lock: the toggle writes under the same lock, so the run then
 * sees either the whole toggle or none of it.
 */
export async function readEffectiveAutoEnablePolicy(
  client: DbClient
): Promise<Record<CatalogPolicyProviderId, boolean>> {
  const overrides = await readOverrides(client)
  return Object.fromEntries(
    CATALOG_POLICY_PROVIDERS.map(provider => [
      provider,
      toPolicy(provider, overrides.get(provider)).auto_enable,
    ])
  ) as Record<CatalogPolicyProviderId, boolean>
}

function isLockWaitTimeout(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  // 57014: statement_timeout cancelled the wait; 55P03: lock_timeout.
  return code === '57014' || code === '55P03'
}

// Only a timeout while WAITING for the sync lock means "a sync is running,
// retry". The same codes from the read or the upsert are an unrelated failure
// and must surface as one.
async function acquireCatalogSyncLockOrTimeout(db: DbClient): Promise<void> {
  try {
    await acquireCatalogSyncLock(db)
  } catch (error) {
    if (isLockWaitTimeout(error)) throw new CatalogPolicyLockTimeoutError()
    throw error
  }
}

/**
 * Persist the operator's override for one provider and return the new entry
 * plus the effective value it replaced. The upsert runs after the catalog-sync
 * lock in the same transaction, so it commits either before a sync run reads
 * the policy or after that run has committed.
 */
export async function setProviderAutoEnable(
  provider: CatalogPolicyProviderId,
  autoEnable: boolean,
  actor: string,
  txPool: Pool = pool
): Promise<{ policy: ProviderCatalogPolicy; previousAutoEnable: boolean }> {
  return withTransaction(async db => {
    await acquireCatalogSyncLockOrTimeout(db)
    const before = await db.query(
      `SELECT provider, auto_enable, updated_at, updated_by
           FROM llm_provider_catalog_settings
          WHERE provider = $1`,
      [provider]
    )
    const previousAutoEnable = toPolicy(
      provider,
      before.rows[0] as SettingsRow | undefined
    ).auto_enable
    const result = await db.query(
      `INSERT INTO llm_provider_catalog_settings (provider, auto_enable, updated_at, updated_by)
         VALUES ($1, $2, NOW(), $3)
         ON CONFLICT (provider) DO UPDATE
           SET auto_enable = EXCLUDED.auto_enable,
               updated_at = EXCLUDED.updated_at,
               updated_by = EXCLUDED.updated_by
         RETURNING provider, auto_enable, updated_at, updated_by`,
      [provider, autoEnable, actor]
    )
    return {
      policy: toPolicy(provider, result.rows[0] as SettingsRow),
      previousAutoEnable,
    }
  }, txPool)
}
