/**
 * An in-memory model of the catalog tables, for the exact statements the code
 * under test issues: the catalog sync (`syncDiscoveredModels`), the admin
 * allowlist services (create / update / delete), the price create, the
 * provider policy toggle, the run status read and the ConfigMap materializer.
 * It APPLIES the statements, so tests assert table state (T4) rather than SQL
 * strings.
 *
 * STRICT: a statement is recognized only when its whitespace-normalized text
 * equals one the fake models (the dynamic admin UPDATE is parsed column by
 * column). Anything else throws. A loose match would keep modelling the old
 * semantics after the production statement changed; an exact one fails the
 * suite instead.
 *
 * What it models:
 *   - transactions with READ COMMITTED visibility: a statement sees committed
 *     rows plus its own transaction's writes; COMMIT publishes, ROLLBACK drops;
 *     a failed statement aborts the transaction until ROLLBACK;
 *   - the unique keys that make writers wait in Postgres: `llm_allowed_models
 *     (provider, model)`, the partial `llm_model_prices (provider, model) WHERE
 *     enabled`, and the primary keys of `llm_catalog_dismissed` and
 *     `llm_provider_catalog_settings`. A writer of a key another open
 *     transaction wrote waits for it to end and re-checks; it holds the key
 *     only if it then writes under it;
 *   - row locks of UPDATE / DELETE / FOR UPDATE: skipped without waiting when
 *     the snapshot row fails the WHERE, otherwise the newest version is
 *     re-read after the wait and held even if the WHERE now fails;
 *   - transaction and session advisory locks as FIFO mutexes, with deadlock
 *     detection (40P01) across all of the above.
 *
 * What is checked against real Postgres:
 *   - table semantics, one session at a time, over a scripted sequence of
 *     syncs, admin writes, toggles and prices
 *     (`services.llmCatalogSyncFakeDb.differential.realPostgres.integration.test.ts`);
 *   - waits, on a fixed set of two-session interleavings: sync INSERT against
 *     an in-flight rename (committed or rolled back), create or operator price;
 *     stale marking against an in-flight update, including a row moved to
 *     another provider; the refresh UPDATE against an in-flight rename; a
 *     toggle against the sync lock; the cron's session lock
 *     (`services.llmCatalogSyncFakeDb.concurrency.realPostgres.integration.test.ts`).
 * Not checked: any other interleaving (the model-based test reaches many),
 * deadlock detection, and waits of more than two sessions at once. In
 * particular, stale marking taking its targets from the statement's snapshot
 * while a third session commits a later target during an earlier wait is
 * modelled (the snapshot row decides, the newest version is re-checked and
 * held) but not compared: the outcome depends on Postgres' heap scan order.
 *
 * What it does not model: `idle_in_transaction_session_timeout` (ignored), the
 * subscription tables (the materializer's readiness reads return no grants),
 * text collation (rows come back in `localeCompare` order, which is not
 * Postgres' `en_US.utf8`), and the statement snapshot of `prev` in the sync's
 * UPDATE … FROM (the target row is read once, after its lock).
 */
import { type Mock, type MockInstance, vi } from 'vitest'
import type { Pool } from 'pg'
import type { ImageInputCapability } from '@clerum/llm-providers'
import { listEnabledGroupedByProvider } from '../../src/services/llmAllowedModels.js'
import {
  LlmAllowedModelsConfigMapWriter,
  buildConfigMapData,
} from '../../src/services/llmAllowedModelsConfigMap.js'
import { FakeConfigMapApi } from './fakeAllowlistCluster.js'

type QueryResult = { rows: unknown[]; rowCount: number | null }
type FakeQuery = Mock<(sql: string, params?: unknown[]) => Promise<QueryResult>>

export interface FakeRow {
  id: string
  provider: string
  model: string
  enabled: boolean
  source: string
  stale: boolean
  context_window_tokens: number | null
  display_name: string | null
  vendor: string | null
  image_input: ImageInputCapability | null
  catalog_status: string | null
  discovered_at: string | null
  last_seen_at: string | null
  created_at: string
  updated_at: string
}

/** A `llm_model_prices` row. */
export interface FakePriceRow {
  provider: string
  model: string
  input_token_price: number
  output_token_price: number
  cache_read_token_price: number
  cache_write_token_price: number
  enabled: boolean
  currency?: string
}

interface StoredPriceRow extends Required<FakePriceRow> {
  id: string
  effective_from: string
  created_at: string
  updated_at: string
}

export interface FakeSettingsRow {
  provider: string
  auto_enable: boolean
  updated_by: string | null
  updated_at: string
}

export interface FakeRunRow {
  id: string
  source: string
  added: number
  updated: number
  staled: number
  provider_counts: unknown
  ran_at: string
}

export interface SeedRow {
  provider: string
  model: string
  enabled?: boolean
  source?: string
  stale?: boolean
  context_window_tokens?: number | null
  display_name?: string | null
  vendor?: string | null
  image_input?: ImageInputCapability | null
  catalog_status?: string | null
}

export interface FakeDbSeed {
  /** `llm_catalog_dismissed` pairs, as `provider/model`. */
  dismissed?: string[]
  prices?: FakePriceRow[]
  /** `llm_provider_catalog_settings` overrides. */
  settings?: Record<string, boolean>
}

/** Where a statement was issued from, for interleaving and for the history. */
export interface StatementInfo {
  actor: string
  sql: string
}

export interface FakeDbOptions {
  /**
   * Awaited before each statement runs. A model-based test routes it through
   * `fc.scheduler()` so the interleaving of concurrent transactions is chosen
   * by the scheduler.
   */
  gate?: (info: StatementInfo) => Promise<void>
}

/** One committed change to one row, as the transaction left it. */
export interface HistoryEvent {
  /** Commit order. */
  seq: number
  actor: string
  table:
    | 'llm_allowed_models'
    | 'llm_model_prices'
    | 'llm_catalog_dismissed'
    | 'llm_provider_catalog_settings'
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}

export interface LockEvent {
  /** Acquisition order, on the same clock as `HistoryEvent.seq`. */
  seq: number
  actor: string
  key: string
}

export interface FakeDb {
  /** The sync's connector (actor `sync`). */
  connector: { connect: Mock<() => Promise<FakeConnection>> }
  /** A `pg.Pool` stand-in whose connections and autocommit queries carry `actor`. */
  pool: (actor?: string) => Pool
  /** Committed `llm_allowed_models` rows. */
  rows: FakeRow[]
  /** Committed `llm_catalog_dismissed`, as `provider/model`. */
  dismissed: Set<string>
  /** Committed `llm_model_prices`. */
  prices: FakePriceRow[]
  /** Committed `llm_provider_catalog_settings`. */
  settings: FakeSettingsRow[]
  /** Committed `llm_catalog_sync_runs`, in insertion order. */
  runs: FakeRunRow[]
  /** Committed `llm_allowed_models_audit` rows. */
  audit: Array<Record<string, unknown>>
  /** Row lookup by (provider, model), for terse assertions. */
  get: (provider: string, model: string) => FakeRow | undefined
  /**
   * The REAL ConfigMap writer, reading this fake through its own pool (actor
   * `publisher`) and writing to `cluster`. Its entry points are spied so "did
   * the run publish?" stays a one-line assertion; what was published is read
   * from `cluster`.
   */
  materializer: LlmAllowedModelsConfigMapWriter & {
    materialize: MockInstance<LlmAllowedModelsConfigMapWriter['materialize']>
    materializeIfChanged: MockInstance<LlmAllowedModelsConfigMapWriter['materializeIfChanged']>
  }
  cluster: FakeConfigMapApi
  /** `build(DB)` from the real producers, read as actor `oracle`. */
  expectedConfigMap: () => Promise<ReturnType<typeof buildConfigMapData>>
  /** Every statement, in issue order. */
  calls: Array<{ sql: string; params: unknown[]; actor: string }>
  /** Every committed row change. */
  history: HistoryEvent[]
  /** Every advisory-lock acquisition. */
  locks: LockEvent[]
}

interface FakeConnection {
  query: FakeQuery
  release: (destroy?: Error | boolean) => void
  on: () => void
  removeListener: () => void
  end: () => Promise<void>
  connection: { stream: { destroy: () => void } }
}

function sqlError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim()

const MODEL_COLUMNS =
  'id, provider, model, vendor, display_name, context_window_tokens, enabled, source, discovered_at, last_seen_at, stale, image_input, created_at, updated_at'
const PRICE_COLUMNS =
  'id, provider, model, input_token_price, output_token_price, cache_read_token_price, cache_write_token_price, currency, effective_from, enabled, created_at, updated_at'
const SETTINGS_COLUMNS = 'provider, auto_enable, updated_at, updated_by'
const SAFE_CONNECTION_COLUMNS =
  'id, connection_key, display_name, default_model, created_by, status, credential_revision, catalog_revision, account_fingerprint, catalog_status, catalog_synced_at, last_refresh_at, last_auth_at, refresh_lock_token, refresh_lock_expires_at, revoked_at, created_at, updated_at'
const IMAGE_INPUT_GUARD =
  "CASE WHEN t.image_input IS NULL THEN $X::jsonb WHEN t.image_input->'evidence'->>'source' = 'discovery' AND (t.image_input->'evidence'->>'checkedAt')::timestamptz <= $Y::timestamptz THEN $X::jsonb ELSE t.image_input END"
const guard = (x: number, y: number) =>
  IMAGE_INPUT_GUARD.replaceAll('$X', `$${x}`).replaceAll('$Y', `$${y}`)

const SQL = {
  begin: 'BEGIN',
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
  xactLock: 'SELECT pg_advisory_xact_lock(hashtext($1))',
  xactLockBigint: 'SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',
  idleTimeout: "SELECT set_config('idle_in_transaction_session_timeout', $1, true)",
  syncSelect: 'SELECT id, model, source FROM llm_allowed_models WHERE provider = $1',
  materializerRead:
    "SELECT provider, model, vendor, display_name, context_window_tokens, image_input FROM llm_allowed_models WHERE enabled AND NOT (provider = 'codex-subscription' AND stale) ORDER BY provider ASC, model ASC",
  syncInsert:
    "INSERT INTO llm_allowed_models (provider, model, enabled, source, discovered_at, last_seen_at, stale, context_window_tokens, display_name, image_input, catalog_status) VALUES ($1, $2, $6::boolean AND NOT EXISTS ( SELECT 1 FROM llm_catalog_dismissed d WHERE d.provider = $1 AND d.model = $2 ), 'discovery', NOW(), NOW(), false, $3, $4, $5::jsonb, $7) ON CONFLICT (provider, model) DO NOTHING RETURNING enabled, EXISTS ( SELECT 1 FROM llm_catalog_dismissed d WHERE d.provider = $1 AND d.model = $2 ) AS dismissed",
  syncManualUpdate: `UPDATE llm_allowed_models AS t SET image_input = ${guard(2, 3)} FROM llm_allowed_models AS prev WHERE t.id = $1 AND prev.id = t.id AND t.source = 'manual' AND t.provider = $4 AND t.model = $5 RETURNING t.enabled, (t.image_input IS DISTINCT FROM prev.image_input) AS image_input_changed`,
  syncDiscoveryUpdate: `UPDATE llm_allowed_models AS t SET last_seen_at = NOW(), stale = false, context_window_tokens = CASE WHEN t.enabled THEN t.context_window_tokens ELSE COALESCE(t.context_window_tokens, $2) END, display_name = CASE WHEN t.enabled THEN t.display_name ELSE COALESCE(t.display_name, $3) END, image_input = ${guard(4, 5)}, catalog_status = CASE WHEN $6::boolean THEN $7::text ELSE t.catalog_status END FROM llm_allowed_models AS prev WHERE t.id = $1 AND prev.id = t.id AND t.source = 'discovery' AND t.provider = $8 AND t.model = $9 RETURNING t.enabled, (t.image_input IS DISTINCT FROM prev.image_input) AS image_input_changed`,
  syncStale:
    "UPDATE llm_allowed_models SET stale = true WHERE provider = $1 AND source = 'discovery' AND stale = false AND model <> ALL($2::text[])",
  syncPrice:
    'INSERT INTO llm_model_prices (provider, model, input_token_price, output_token_price, cache_read_token_price, cache_write_token_price) SELECT $1::text, $2::text, $3::numeric, $4::numeric, $5::numeric, $6::numeric WHERE NOT EXISTS ( SELECT 1 FROM llm_model_prices p WHERE p.provider = $1::text AND p.model = $2::text ) ON CONFLICT (provider, model) WHERE enabled DO NOTHING',
  runInsert:
    'INSERT INTO llm_catalog_sync_runs (source, added, updated, staled, provider_counts) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING ran_at',
  runLast:
    'SELECT id, ran_at, source, added, updated, staled, provider_counts FROM llm_catalog_sync_runs ORDER BY ran_at DESC LIMIT 1',
  adminCreate: `INSERT INTO llm_allowed_models (provider, model, vendor, display_name, context_window_tokens, image_input, enabled) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING ${MODEL_COLUMNS}`,
  adminSelectForUpdate: `SELECT ${MODEL_COLUMNS} FROM llm_allowed_models WHERE id = $1 FOR UPDATE`,
  adminGet: `SELECT ${MODEL_COLUMNS} FROM llm_allowed_models WHERE id = $1 LIMIT 1`,
  adminDelete: 'DELETE FROM llm_allowed_models WHERE id = $1 RETURNING provider, model',
  audit:
    'INSERT INTO llm_allowed_models_audit (actor, action, provider, model, detail) VALUES ($1, $2, $3, $4, $5)',
  dismiss:
    'INSERT INTO llm_catalog_dismissed (provider, model) VALUES ($1, $2) ON CONFLICT (provider, model) DO NOTHING',
  priceCreate: `INSERT INTO llm_model_prices (provider, model, input_token_price, output_token_price, cache_read_token_price, cache_write_token_price, currency, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${PRICE_COLUMNS}`,
  settingsAll: `SELECT ${SETTINGS_COLUMNS} FROM llm_provider_catalog_settings`,
  settingsOne: `SELECT ${SETTINGS_COLUMNS} FROM llm_provider_catalog_settings WHERE provider = $1`,
  settingsUpsert: `INSERT INTO llm_provider_catalog_settings (provider, auto_enable, updated_at, updated_by) VALUES ($1, $2, NOW(), $3) ON CONFLICT (provider) DO UPDATE SET auto_enable = EXCLUDED.auto_enable, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by RETURNING ${SETTINGS_COLUMNS}`,
  codexConnections: `SELECT ${SAFE_CONNECTION_COLUMNS} FROM codex_subscription_connections WHERE revoked_at IS NULL ORDER BY created_at ASC, connection_key ASC`,
  codexModels:
    'SELECT c.connection_key AS connection_key, m.model FROM codex_catalog_models m JOIN codex_subscription_connections c ON c.id = m.connection_id WHERE c.revoked_at IS NULL AND m.enabled AND m.stale = false ORDER BY c.connection_key ASC, m.model ASC',
  grokConnections: `SELECT ${SAFE_CONNECTION_COLUMNS} FROM grok_subscription_connections WHERE revoked_at IS NULL ORDER BY created_at ASC, connection_key ASC`,
  grokModels:
    'SELECT c.connection_key AS connection_key, m.model FROM grok_catalog_models m JOIN grok_subscription_connections c ON c.id = m.connection_id WHERE c.revoked_at IS NULL AND m.enabled AND m.stale = false ORDER BY c.connection_key ASC, m.model ASC',
} as const

const SESSION_LOCK = /^SELECT pg_try_advisory_lock\(hashtext\('([a-z0-9-]+)'\)\) AS acquired$/
const SESSION_UNLOCK = /^SELECT pg_advisory_unlock\(hashtext\('([a-z0-9-]+)'\)\)$/
const ADMIN_UPDATE = new RegExp(
  `^UPDATE llm_allowed_models SET (.+) WHERE id = \\$(\\d+) RETURNING ${MODEL_COLUMNS.replace(/[()]/g, '\\$&')}$`
)
const ADMIN_UPDATE_COLUMNS = new Set([
  'provider',
  'model',
  'vendor',
  'display_name',
  'context_window_tokens',
  'image_input',
  'enabled',
])

/**
 * Two kinds of waits, as in Postgres:
 *   - `acquire`: a real mutex (advisory locks). Ownership passes FIFO to the
 *     next waiter and is held until the transaction ends.
 *   - `waitFree` + `claim`: an index entry or a row version written by an
 *     in-flight transaction. A writer of the same key waits for that
 *     transaction to END and then re-checks; it holds the key only if it then
 *     writes a tuple under it (`claim`). A conflict found against a committed
 *     tuple leaves nothing held, as `ON CONFLICT DO NOTHING` does.
 * A wait-for graph fails the waiter that closes a cycle (40P01).
 */
class LockTable {
  private held = new Map<
    string,
    {
      owner: number
      waiters: Array<{ owner: number; mode: 'acquire' | 'watch'; wake: () => void }>
    }
  >()
  private waitingOn = new Map<number, string>()

  isHeldBy(key: string, owner: number): boolean {
    return this.held.get(key)?.owner === owner
  }

  tryAcquire(key: string, owner: number): boolean {
    const entry = this.held.get(key)
    if (!entry) {
      this.held.set(key, { owner, waiters: [] })
      return true
    }
    return entry.owner === owner
  }

  async acquire(key: string, owner: number): Promise<void> {
    if (this.tryAcquire(key, owner)) return
    await this.park(key, owner, 'acquire')
  }

  /**
   * Wait until no OTHER transaction holds `key`, then run `decide` in the same
   * tick: it re-checks the newest committed state, and returns whether this
   * transaction writes under `key` (and so holds it until it ends).
   */
  async whenFree<T>(
    key: string,
    owner: number,
    decide: () => { hold: boolean; value: T }
  ): Promise<T> {
    for (;;) {
      const entry = this.held.get(key)
      if (!entry || entry.owner === owner) {
        const { hold, value } = decide()
        if (hold) this.tryAcquire(key, owner)
        return value
      }
      await this.park(key, owner, 'watch')
    }
  }

  private park(key: string, owner: number, mode: 'acquire' | 'watch'): Promise<void> {
    const entry = this.held.get(key)!
    this.assertNoCycle(owner, key)
    return new Promise<void>(wake => {
      entry.waiters.push({ owner, mode, wake })
      this.waitingOn.set(owner, key)
    })
  }

  release(key: string, owner: number): void {
    const entry = this.held.get(key)
    if (!entry || entry.owner !== owner) return
    const watchers = entry.waiters.filter(w => w.mode === 'watch')
    const next = entry.waiters.find(w => w.mode === 'acquire')
    if (next) {
      entry.owner = next.owner
      entry.waiters = entry.waiters.filter(w => w.mode === 'acquire' && w !== next)
      this.waitingOn.delete(next.owner)
      next.wake()
    } else {
      this.held.delete(key)
    }
    for (const w of watchers) {
      this.waitingOn.delete(w.owner)
      w.wake()
    }
  }

  releaseAll(owner: number, prefix = ''): void {
    for (const [key, entry] of [...this.held]) {
      if (entry.owner === owner && key.startsWith(prefix)) this.release(key, owner)
    }
  }

  private assertNoCycle(owner: number, key: string): void {
    let current: string | undefined = key
    const seen = new Set<number>()
    while (current !== undefined) {
      const holder = this.held.get(current)?.owner
      if (holder === undefined) return
      if (holder === owner) throw sqlError('40P01', 'deadlock detected')
      if (seen.has(holder)) return
      seen.add(holder)
      current = this.waitingOn.get(holder)
    }
  }
}

type TableName = HistoryEvent['table'] | 'llm_catalog_sync_runs' | 'llm_allowed_models_audit'

class Tx {
  readonly overlays = new Map<TableName, Map<string, Record<string, unknown> | null>>()
  aborted = false
  constructor(
    readonly id: number,
    readonly actor: string,
    readonly explicit: boolean
  ) {}

  overlay(table: TableName): Map<string, Record<string, unknown> | null> {
    let o = this.overlays.get(table)
    if (!o) {
      o = new Map()
      this.overlays.set(table, o)
    }
    return o
  }
}

let idSeq = 0
const BASE_TIME = Date.parse('2026-08-12T00:00:00.000Z')

export function makeFakeDb(
  seed: SeedRow[] = [],
  extra: FakeDbSeed = {},
  options: FakeDbOptions = {}
): FakeDb {
  let clock = 0
  let ownerSeq = 0
  const now = () => new Date(BASE_TIME + clock * 1000).toISOString()
  const tick = () => (clock += 1)
  const nextId = (prefix: string) => `${prefix}-${(idSeq += 1)}`

  const tables = new Map<TableName, Map<string, Record<string, unknown>>>(
    (
      [
        'llm_allowed_models',
        'llm_model_prices',
        'llm_catalog_dismissed',
        'llm_provider_catalog_settings',
        'llm_catalog_sync_runs',
        'llm_allowed_models_audit',
      ] as const
    ).map(t => [t, new Map()])
  )
  const locks = new LockTable()
  const history: HistoryEvent[] = []
  const lockLog: LockEvent[] = []
  const calls: FakeDb['calls'] = []
  const pairKey = (provider: unknown, model: unknown) => `${String(provider)}/${String(model)}`

  for (const s of seed) {
    const id = nextId('seed')
    tables.get('llm_allowed_models')!.set(id, {
      id,
      provider: s.provider,
      model: s.model,
      enabled: s.enabled ?? false,
      source: s.source ?? 'discovery',
      stale: s.stale ?? false,
      context_window_tokens: s.context_window_tokens ?? null,
      display_name: s.display_name ?? null,
      vendor: s.vendor ?? null,
      image_input: s.image_input ?? null,
      catalog_status: s.catalog_status ?? null,
      discovered_at: null,
      last_seen_at: null,
      created_at: now(),
      updated_at: now(),
    })
  }
  for (const pair of extra.dismissed ?? []) {
    const slash = pair.indexOf('/')
    tables.get('llm_catalog_dismissed')!.set(pair, {
      provider: pair.slice(0, slash),
      model: pair.slice(slash + 1),
    })
  }
  for (const p of extra.prices ?? []) {
    const id = nextId('price')
    tables.get('llm_model_prices')!.set(id, {
      id,
      currency: 'USD',
      effective_from: now(),
      created_at: now(),
      updated_at: now(),
      ...p,
    })
  }
  for (const [provider, autoEnable] of Object.entries(extra.settings ?? {})) {
    tables.get('llm_provider_catalog_settings')!.set(provider, {
      provider,
      auto_enable: autoEnable,
      updated_by: null,
      updated_at: now(),
    })
  }

  // ---- visibility ---------------------------------------------------------

  const visible = (tx: Tx, table: TableName): Array<Record<string, unknown>> => {
    const out = new Map(tables.get(table)!)
    for (const [key, row] of tx.overlays.get(table) ?? []) {
      if (row === null) out.delete(key)
      else out.set(key, row)
    }
    return [...out.values()]
  }
  const visibleByKey = (tx: Tx, table: TableName, key: string) => {
    const o = tx.overlays.get(table)
    if (o?.has(key)) return o.get(key) ?? undefined
    return tables.get(table)!.get(key)
  }
  const write = (tx: Tx, table: TableName, key: string, row: Record<string, unknown> | null) => {
    tx.overlay(table).set(key, row)
  }

  // A key another open transaction wrote makes a writer of the same key wait
  // for it to end; the waiter holds the key only once it writes under it.
  const whenFree = <T>(tx: Tx, key: string, decide: () => { hold: boolean; value: T }) =>
    locks.whenFree(`key:${key}`, tx.id, decide)

  const finish = (tx: Tx, commit: boolean) => {
    if (commit && !tx.aborted) {
      tick()
      const seq = clock
      for (const [table, overlay] of tx.overlays) {
        const store = tables.get(table)!
        for (const [key, row] of overlay) {
          const before = store.get(key) ?? null
          if (row === null) store.delete(key)
          else store.set(key, row)
          if (
            table === 'llm_allowed_models' ||
            table === 'llm_model_prices' ||
            table === 'llm_catalog_dismissed' ||
            table === 'llm_provider_catalog_settings'
          ) {
            history.push({ seq, actor: tx.actor, table, before, after: row })
          }
        }
      }
    }
    locks.releaseAll(tx.id)
  }

  // ---- statements -----------------------------------------------------------

  const modelRow = (r: Record<string, unknown>) =>
    Object.fromEntries(MODEL_COLUMNS.split(', ').map(c => [c, r[c]]))
  const parseJsonb = (value: unknown) =>
    value === null || value === undefined ? null : JSON.parse(String(value))
  const replaceableEvidence = (row: Record<string, unknown>, capturedAt: string): boolean => {
    const current = row.image_input as ImageInputCapability | null
    if (current === null) return true
    const evidence = current.evidence
    return (
      evidence?.source === 'discovery' &&
      Date.parse(String(evidence.checkedAt)) <= Date.parse(capturedAt)
    )
  }
  const numeric = (value: unknown): number => {
    const n = Number(value)
    if (!Number.isFinite(n) || Math.abs(n) >= 1e12) {
      throw sqlError('22003', 'numeric field overflow')
    }
    if (n < 0) throw sqlError('23514', 'violates check constraint')
    return Number(n.toFixed(8))
  }

  /**
   * The row an UPDATE/DELETE/FOR UPDATE by `id` acts on. A row whose snapshot
   * version fails `matches` is skipped without waiting. Otherwise the statement
   * waits for an in-flight writer of the row and re-reads the newest committed
   * version. It holds that version even when `matches` now fails: Postgres
   * locks the newest version before re-checking the WHERE on it, and keeps the
   * lock when the re-check skips the row. Only a row deleted meanwhile leaves
   * nothing held.
   */
  const lockedModel = async (
    tx: Tx,
    id: string,
    matches: (row: Record<string, unknown>) => boolean = () => true,
    // A multi-row statement passes the row as its snapshot saw it at the
    // start: by the time it reaches a later row, earlier waits may have let
    // other commits through, and those must not decide whether it is a target.
    snapshot = visibleByKey(tx, 'llm_allowed_models', id)
  ) => {
    if (!snapshot || !matches(snapshot)) return undefined
    return whenFree(tx, `row:llm_allowed_models:${id}`, () => {
      const latest = visibleByKey(tx, 'llm_allowed_models', id)
      if (!latest) return { hold: false, value: undefined }
      return { hold: true, value: matches(latest) ? latest : undefined }
    })
  }

  const findPair = (tx: Tx, provider: unknown, model: unknown) =>
    visible(tx, 'llm_allowed_models').find(r => r.provider === provider && r.model === model)

  const execute = async (
    tx: Tx,
    conn: { owner: number },
    sql: string,
    p: unknown[]
  ): Promise<QueryResult> => {
    switch (sql) {
      case SQL.xactLock:
      case SQL.xactLockBigint: {
        const key = `xact:${String(p[0])}`
        await locks.acquire(key, tx.id)
        tick()
        lockLog.push({ seq: clock, actor: tx.actor, key: String(p[0]) })
        return { rows: [{ pg_advisory_xact_lock: '' }], rowCount: 1 }
      }
      case SQL.idleTimeout:
        return { rows: [{ set_config: String(p[0]) }], rowCount: 1 }

      case SQL.syncSelect: {
        const out = visible(tx, 'llm_allowed_models')
          .filter(r => r.provider === p[0])
          .map(r => ({ id: r.id, model: r.model, source: r.source }))
        return { rows: out, rowCount: out.length }
      }
      case SQL.materializerRead: {
        const out = visible(tx, 'llm_allowed_models')
          .filter(
            r => r.enabled === true && !(r.provider === 'codex-subscription' && r.stale === true)
          )
          .sort(
            (a, b) =>
              String(a.provider).localeCompare(String(b.provider)) ||
              String(a.model).localeCompare(String(b.model))
          )
          .map(r => ({
            provider: r.provider,
            model: r.model,
            vendor: r.vendor,
            display_name: r.display_name,
            context_window_tokens: r.context_window_tokens,
            image_input: r.image_input,
          }))
        return { rows: out, rowCount: out.length }
      }

      case SQL.syncInsert: {
        const [provider, model, ctx, display, imageInput, enable, status] = p
        // Both EXISTS read the statement snapshot, taken before any wait.
        const dismissed =
          visibleByKey(tx, 'llm_catalog_dismissed', pairKey(provider, model)) !== undefined
        const enabled = enable === true && !dismissed
        const free = await whenFree(tx, `llm_allowed_models:${pairKey(provider, model)}`, () => {
          const taken = findPair(tx, provider, model) !== undefined
          return { hold: !taken, value: !taken }
        })
        if (!free) return { rows: [], rowCount: 0 }
        const id = nextId('ins')
        write(tx, 'llm_allowed_models', id, {
          id,
          provider,
          model,
          enabled,
          source: 'discovery',
          stale: false,
          context_window_tokens: ctx ?? null,
          display_name: display ?? null,
          vendor: null,
          image_input: parseJsonb(imageInput),
          catalog_status: status ?? null,
          discovered_at: now(),
          last_seen_at: now(),
          created_at: now(),
          updated_at: now(),
        })
        return { rows: [{ enabled, dismissed }], rowCount: 1 }
      }
      case SQL.syncManualUpdate: {
        const [id, imageInput, capturedAt, provider, model] = p
        const row = await lockedModel(
          tx,
          String(id),
          r => r.source === 'manual' && r.provider === provider && r.model === model
        )
        if (!row) return { rows: [], rowCount: 0 }
        const next = { ...row }
        if (replaceableEvidence(row, String(capturedAt))) next.image_input = parseJsonb(imageInput)
        write(tx, 'llm_allowed_models', String(id), next)
        const changed = JSON.stringify(row.image_input) !== JSON.stringify(next.image_input)
        return { rows: [{ enabled: row.enabled, image_input_changed: changed }], rowCount: 1 }
      }
      case SQL.syncDiscoveryUpdate: {
        const [id, ctx, display, imageInput, capturedAt, live, status, provider, model] = p
        const row = await lockedModel(
          tx,
          String(id),
          r => r.source === 'discovery' && r.provider === provider && r.model === model
        )
        if (!row) return { rows: [], rowCount: 0 }
        const next: Record<string, unknown> = { ...row, last_seen_at: now(), stale: false }
        if (row.enabled !== true) {
          next.context_window_tokens = row.context_window_tokens ?? ctx ?? null
          next.display_name = row.display_name ?? display ?? null
        }
        if (replaceableEvidence(row, String(capturedAt))) next.image_input = parseJsonb(imageInput)
        if (live === true) next.catalog_status = status ?? null
        write(tx, 'llm_allowed_models', String(id), next)
        const changed = JSON.stringify(row.image_input) !== JSON.stringify(next.image_input)
        return { rows: [{ enabled: row.enabled, image_input_changed: changed }], rowCount: 1 }
      }
      case SQL.syncStale: {
        const provider = p[0]
        const present = new Set((p[1] as string[]) ?? [])
        const matches = (r: Record<string, unknown> | undefined) =>
          r !== undefined &&
          r.provider === provider &&
          r.source === 'discovery' &&
          r.stale === false &&
          !present.has(String(r.model))
        let n = 0
        for (const candidate of visible(tx, 'llm_allowed_models').filter(matches)) {
          const row = await lockedModel(tx, String(candidate.id), matches, candidate)
          if (!row) continue
          write(tx, 'llm_allowed_models', String(candidate.id), { ...row, stale: true })
          n += 1
        }
        return { rows: [], rowCount: n }
      }
      case SQL.syncPrice: {
        const [provider, model, input, output, cacheRead, cacheWrite] = p
        const anyRow = visible(tx, 'llm_model_prices').some(
          r => r.provider === provider && r.model === model
        )
        if (anyRow) return { rows: [], rowCount: 0 }
        const free = await whenFree(tx, `llm_model_prices:${pairKey(provider, model)}`, () => {
          const active = visible(tx, 'llm_model_prices').some(
            r => r.provider === provider && r.model === model && r.enabled === true
          )
          return { hold: !active, value: !active }
        })
        if (!free) return { rows: [], rowCount: 0 }
        insertPrice(tx, {
          provider: String(provider),
          model: String(model),
          input_token_price: numeric(input),
          output_token_price: numeric(output),
          cache_read_token_price: numeric(cacheRead),
          cache_write_token_price: numeric(cacheWrite),
          enabled: true,
          currency: 'USD',
        })
        return { rows: [], rowCount: 1 }
      }
      case SQL.runInsert: {
        const id = nextId('run')
        tick()
        const row = {
          id,
          source: String(p[0]),
          added: Number(p[1]),
          updated: Number(p[2]),
          staled: Number(p[3]),
          provider_counts: p[4] === null || p[4] === undefined ? null : JSON.parse(String(p[4])),
          ran_at: now(),
        }
        write(tx, 'llm_catalog_sync_runs', id, row)
        return { rows: [{ ran_at: new Date(row.ran_at) }], rowCount: 1 }
      }
      case SQL.runLast: {
        const all = visible(tx, 'llm_catalog_sync_runs')
        const last = all.reduce<Record<string, unknown> | undefined>(
          (best, r) => (!best || String(r.ran_at) >= String(best.ran_at) ? r : best),
          undefined
        )
        return last
          ? { rows: [{ ...last, ran_at: new Date(String(last.ran_at)) }], rowCount: 1 }
          : { rows: [], rowCount: 0 }
      }

      case SQL.adminCreate: {
        const [provider, model, vendor, display, ctx, imageInput, enabled] = p
        const free = await whenFree(tx, `llm_allowed_models:${pairKey(provider, model)}`, () => {
          const taken = findPair(tx, provider, model) !== undefined
          return { hold: !taken, value: !taken }
        })
        if (!free) {
          throw sqlError(
            '23505',
            'duplicate key value violates unique constraint "idx_llm_allowed_models_pm"'
          )
        }
        const id = nextId('adm')
        const row = {
          id,
          provider,
          model,
          vendor: vendor ?? null,
          display_name: display ?? null,
          context_window_tokens: ctx ?? null,
          image_input: parseJsonb(imageInput),
          enabled: enabled === true,
          source: 'manual',
          stale: false,
          catalog_status: null,
          discovered_at: null,
          last_seen_at: null,
          created_at: now(),
          updated_at: now(),
        }
        write(tx, 'llm_allowed_models', id, row)
        return { rows: [modelRow(row)], rowCount: 1 }
      }
      case SQL.adminSelectForUpdate: {
        const row = await lockedModel(tx, String(p[0]))
        return row ? { rows: [modelRow(row)], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      case SQL.adminGet: {
        const row = visibleByKey(tx, 'llm_allowed_models', String(p[0]))
        return row ? { rows: [modelRow(row)], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      case SQL.adminDelete: {
        const row = await lockedModel(tx, String(p[0]))
        if (!row) return { rows: [], rowCount: 0 }
        await whenFree(tx, `llm_allowed_models:${pairKey(row.provider, row.model)}`, () => ({
          hold: true,
          value: undefined,
        }))
        write(tx, 'llm_allowed_models', String(p[0]), null)
        return { rows: [{ provider: row.provider, model: row.model }], rowCount: 1 }
      }
      case SQL.audit: {
        const id = nextId('audit')
        write(tx, 'llm_allowed_models_audit', id, {
          actor: p[0],
          action: p[1],
          provider: p[2],
          model: p[3],
          detail: p[4],
        })
        return { rows: [], rowCount: 1 }
      }
      case SQL.dismiss: {
        const key = pairKey(p[0], p[1])
        const free = await whenFree(tx, `llm_catalog_dismissed:${key}`, () => {
          const taken = visibleByKey(tx, 'llm_catalog_dismissed', key) !== undefined
          return { hold: !taken, value: !taken }
        })
        if (!free) return { rows: [], rowCount: 0 }
        write(tx, 'llm_catalog_dismissed', key, { provider: p[0], model: p[1] })
        return { rows: [], rowCount: 1 }
      }
      case SQL.priceCreate: {
        const [provider, model, input, output, cacheRead, cacheWrite, currency, enabled] = p
        const row = {
          provider: String(provider),
          model: String(model),
          input_token_price: numeric(input),
          output_token_price: numeric(output),
          cache_read_token_price: numeric(cacheRead ?? 0),
          cache_write_token_price: numeric(cacheWrite ?? 0),
          currency: String(currency ?? 'USD'),
          enabled: enabled !== false,
        }
        if (row.enabled) {
          const free = await whenFree(tx, `llm_model_prices:${pairKey(provider, model)}`, () => {
            const active = visible(tx, 'llm_model_prices').some(
              r => r.provider === provider && r.model === model && r.enabled === true
            )
            return { hold: !active, value: !active }
          })
          if (!free) {
            throw sqlError(
              '23505',
              'duplicate key value violates unique constraint "idx_llm_model_prices_active"'
            )
          }
        }
        const stored = insertPrice(tx, row)
        return {
          rows: [
            Object.fromEntries(
              PRICE_COLUMNS.split(', ').map(c => [c, stored[c as keyof StoredPriceRow]])
            ),
          ],
          rowCount: 1,
        }
      }

      case SQL.settingsAll: {
        const out = visible(tx, 'llm_provider_catalog_settings').map(settingsOut)
        return { rows: out, rowCount: out.length }
      }
      case SQL.settingsOne: {
        const row = visibleByKey(tx, 'llm_provider_catalog_settings', String(p[0]))
        return row ? { rows: [settingsOut(row)], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      case SQL.settingsUpsert: {
        const provider = String(p[0])
        await whenFree(tx, `llm_provider_catalog_settings:${provider}`, () => ({
          hold: true,
          value: undefined,
        }))
        const row = {
          provider,
          auto_enable: p[1] === true,
          updated_at: now(),
          updated_by: p[2] ?? null,
        }
        write(tx, 'llm_provider_catalog_settings', provider, row)
        return { rows: [settingsOut(row)], rowCount: 1 }
      }

      case SQL.codexConnections:
      case SQL.codexModels:
      case SQL.grokConnections:
      case SQL.grokModels:
        return { rows: [], rowCount: 0 }
    }

    const sessionLock = SESSION_LOCK.exec(sql)
    if (sessionLock) {
      const acquired = locks.tryAcquire(`session:${sessionLock[1]}`, conn.owner)
      if (acquired) {
        tick()
        lockLog.push({ seq: clock, actor: tx.actor, key: sessionLock[1] })
      }
      return { rows: [{ acquired }], rowCount: 1 }
    }
    const sessionUnlock = SESSION_UNLOCK.exec(sql)
    if (sessionUnlock) {
      const key = `session:${sessionUnlock[1]}`
      const held = locks.isHeldBy(key, conn.owner)
      if (held) locks.release(key, conn.owner)
      return { rows: [{ pg_advisory_unlock: held }], rowCount: 1 }
    }
    const adminUpdate = ADMIN_UPDATE.exec(sql)
    if (adminUpdate) return applyAdminUpdate(tx, adminUpdate[1], Number(adminUpdate[2]), p)

    throw new Error(`llmCatalogSyncFakeDb: unrecognized SQL: ${sql}`)
  }

  const settingsOut = (r: Record<string, unknown>) => ({
    provider: r.provider,
    auto_enable: r.auto_enable,
    updated_at: new Date(String(r.updated_at)),
    updated_by: r.updated_by,
  })

  const insertPrice = (tx: Tx, row: Required<FakePriceRow>): StoredPriceRow => {
    const id = nextId('price')
    const stored = { id, ...row, effective_from: now(), created_at: now(), updated_at: now() }
    write(tx, 'llm_model_prices', id, stored)
    return stored
  }

  const applyAdminUpdate = async (
    tx: Tx,
    setList: string,
    idParam: number,
    p: unknown[]
  ): Promise<QueryResult> => {
    const id = String(p[idParam - 1])
    const row = await lockedModel(tx, id)
    if (!row) return { rows: [], rowCount: 0 }
    const next: Record<string, unknown> = { ...row }
    for (const item of setList.split(', ')) {
      const param = /^(\w+) = \$(\d+)(::jsonb)?$/.exec(item)
      if (param && ADMIN_UPDATE_COLUMNS.has(param[1])) {
        const value = p[Number(param[2]) - 1]
        if (param[1] === 'image_input') {
          if (param[3] !== '::jsonb')
            throw new Error(`llmCatalogSyncFakeDb: image_input without ::jsonb: ${item}`)
          next.image_input = parseJsonb(value)
        } else {
          next[param[1]] = value
        }
        continue
      }
      if (item === 'image_input = NULL') next.image_input = null
      else if (item === 'catalog_status = NULL') next.catalog_status = null
      else if (item === 'updated_at = NOW()') next.updated_at = now()
      else throw new Error(`llmCatalogSyncFakeDb: unrecognized SET item in admin UPDATE: ${item}`)
    }
    if (next.provider !== row.provider || next.model !== row.model) {
      const oldKey = `llm_allowed_models:${pairKey(row.provider, row.model)}`
      const newKey = `llm_allowed_models:${pairKey(next.provider, next.model)}`
      await whenFree(tx, oldKey, () => ({ hold: true, value: undefined }))
      const free = await whenFree(tx, newKey, () => {
        const clash = findPair(tx, next.provider, next.model)
        const taken = clash !== undefined && clash.id !== id
        return { hold: !taken, value: !taken }
      })
      if (!free) {
        throw sqlError(
          '23505',
          'duplicate key value violates unique constraint "idx_llm_allowed_models_pm"'
        )
      }
    }
    write(tx, 'llm_allowed_models', id, next)
    return { rows: [modelRow(next)], rowCount: 1 }
  }

  // ---- connections ------------------------------------------------------------

  const makeConnection = (actor: string): FakeConnection => {
    const conn = { owner: (ownerSeq += 1) }
    let tx: Tx | null = null
    const query: FakeQuery = vi.fn(async (rawSql: string, params: unknown[] = []) => {
      const sql = norm(rawSql)
      calls.push({ sql, params, actor })
      await options.gate?.({ actor, sql })
      if (sql === SQL.begin) {
        if (tx) throw sqlError('25001', 'there is already a transaction in progress')
        tx = new Tx((ownerSeq += 1), actor, true)
        return { rows: [], rowCount: null }
      }
      if (sql === SQL.commit || sql === SQL.rollback) {
        const current = tx
        tx = null
        if (current) finish(current, sql === SQL.commit)
        return { rows: [], rowCount: null }
      }
      if (tx?.aborted) {
        throw sqlError(
          '25P02',
          'current transaction is aborted, commands ignored until end of transaction block'
        )
      }
      const statementTx = tx ?? new Tx((ownerSeq += 1), actor, false)
      try {
        const result = await execute(statementTx, conn, sql, params)
        if (!statementTx.explicit) finish(statementTx, true)
        return result
      } catch (err) {
        if (statementTx.explicit) statementTx.aborted = true
        else finish(statementTx, false)
        throw err
      }
    })
    return {
      query,
      release: (destroy?: Error | boolean) => {
        if (tx) {
          finish(tx, false)
          tx = null
        }
        // A destroyed connection ends its session, which frees its session locks;
        // one returned to the pool keeps them, exactly the leak Postgres has.
        if (destroy) locks.releaseAll(conn.owner, 'session:')
      },
      on: () => undefined,
      removeListener: () => undefined,
      end: async () => undefined,
      connection: { stream: { destroy: () => undefined } },
    }
  }

  const pool = (actor = 'default'): Pool =>
    ({
      connect: async () => makeConnection(actor),
      query: (sql: string, params?: unknown[]) => makeConnection(actor).query(sql, params),
    }) as unknown as Pool

  const committed = (table: TableName) => [...tables.get(table)!.values()]

  const connector = { connect: vi.fn(async () => makeConnection('sync')) }
  const cluster = new FakeConfigMapApi()
  const writer = new LlmAllowedModelsConfigMapWriter(cluster, 'mcp-host', 3, pool('publisher'))
  vi.spyOn(writer, 'materialize')
  vi.spyOn(writer, 'materializeIfChanged')

  return {
    connector,
    pool,
    get rows() {
      return committed('llm_allowed_models') as unknown as FakeRow[]
    },
    get dismissed() {
      return new Set(committed('llm_catalog_dismissed').map(r => pairKey(r.provider, r.model)))
    },
    get prices() {
      return committed('llm_model_prices') as unknown as FakePriceRow[]
    },
    get settings() {
      return committed('llm_provider_catalog_settings') as unknown as FakeSettingsRow[]
    },
    get runs() {
      return committed('llm_catalog_sync_runs') as unknown as FakeRunRow[]
    },
    get audit() {
      return committed('llm_allowed_models_audit')
    },
    get: (provider, model) =>
      committed('llm_allowed_models').find(r => r.provider === provider && r.model === model) as
        | FakeRow
        | undefined,
    materializer: writer as FakeDb['materializer'],
    cluster,
    expectedConfigMap: async () =>
      buildConfigMapData(await listEnabledGroupedByProvider(pool('oracle'))),
    calls,
    history,
    locks: lockLog,
  }
}
