/**
 * The strict catalog fake DB's own contract: it refuses statements it does not
 * model, and its transactions, waits and locks behave as Postgres' do for the
 * statements the catalog code issues. The table semantics are checked against
 * real Postgres in the differential suite; the waits below are not, because
 * that suite runs one session at a time.
 */
import { describe, expect, it } from 'vitest'
import { withTransaction } from '../src/db.js'
import {
  createAllowedModel,
  deleteAllowedModel,
  updateAllowedModel,
} from '../src/services/llmAllowedModels.js'
import { createLlmPrice } from '../src/services/llmPrices.js'
import { setProviderAutoEnable } from '../src/services/llmProviderCatalogSettings.js'
import { makeFakeDb } from './helpers/llmCatalogSyncFakeDb.js'

const SYNC_LOCK = 'SELECT pg_advisory_xact_lock(hashtext($1))'
const SYNC_SELECT = 'SELECT id, model, source FROM llm_allowed_models WHERE provider = $1'
const DISMISS =
  'INSERT INTO llm_catalog_dismissed (provider, model) VALUES ($1, $2) ON CONFLICT (provider, model) DO NOTHING'

const flush = () => new Promise(resolve => setImmediate(resolve))

describe('llmCatalogSyncFakeDb · strict recognition', () => {
  it('throws on a statement it does not model instead of answering empty', async () => {
    const db = makeFakeDb()
    await expect(db.pool('t').query('SELECT 1')).rejects.toThrow(/unrecognized SQL/)
  })

  it('throws on a known statement with one extra condition', async () => {
    const db = makeFakeDb([{ provider: 'claude', model: 'a' }])
    await expect(db.pool('t').query(`${SYNC_SELECT} AND enabled`, ['claude'])).rejects.toThrow(
      /unrecognized SQL/
    )
    // The exact statement is recognized; whitespace differences are not significant.
    const ok = await db.pool('t').query(SYNC_SELECT.replace(/ /g, '\n  '), ['claude'])
    expect(ok.rows).toHaveLength(1)
  })

  it('throws on an admin UPDATE that sets a column it does not model', async () => {
    const db = makeFakeDb([{ provider: 'claude', model: 'a' }])
    const id = db.rows[0].id
    await expect(
      db
        .pool('t')
        .query(
          `UPDATE llm_allowed_models SET source = $1 WHERE id = $2 RETURNING id, provider, model, vendor, display_name, context_window_tokens, enabled, source, discovered_at, last_seen_at, stale, image_input, created_at, updated_at`,
          ['manual', id]
        )
    ).rejects.toThrow(/unrecognized SET item/)
  })
})

describe('llmCatalogSyncFakeDb · transactions', () => {
  it('hides a write from other sessions until COMMIT', async () => {
    const db = makeFakeDb()
    const a = await db.pool('a').connect()
    await a.query('BEGIN')
    await a.query(DISMISS, ['claude', 'x'])
    expect(db.dismissed.has('claude/x')).toBe(false)
    await a.query('COMMIT')
    expect(db.dismissed.has('claude/x')).toBe(true)
  })

  it('drops the writes of a rolled-back transaction', async () => {
    const db = makeFakeDb([{ provider: 'claude', model: 'a', enabled: true }])
    const id = db.rows[0].id
    await expect(
      withTransaction(async tx => {
        await deleteAllowedModel(id, 'admin', tx)
        throw new Error('abort')
      }, db.pool('admin'))
    ).rejects.toThrow('abort')
    expect(db.get('claude', 'a')).toBeDefined()
    expect(db.dismissed.size).toBe(0)
  })

  it('aborts the transaction after a failed statement until ROLLBACK', async () => {
    const db = makeFakeDb([{ provider: 'claude', model: 'a' }])
    const c = await db.pool('a').connect()
    await c.query('BEGIN')
    await expect(c.query('SELECT 1')).rejects.toThrow()
    await expect(c.query(SYNC_SELECT, ['claude'])).rejects.toMatchObject({ code: '25P02' })
    await c.query('ROLLBACK')
    await expect(c.query(SYNC_SELECT, ['claude'])).resolves.toMatchObject({ rowCount: 1 })
  })

  it('reports a duplicate pair as a unique violation the service maps to a conflict', async () => {
    const db = makeFakeDb([{ provider: 'claude', model: 'a' }])
    await expect(
      createAllowedModel(
        { provider: 'claude', model: 'a', enabled: true } as never,
        'admin',
        db.pool('admin')
      )
    ).rejects.toThrow(/already exists|conflict/i)
    expect(db.rows).toHaveLength(1)
    expect(db.audit).toHaveLength(0)
  })
})

describe('llmCatalogSyncFakeDb · waits and locks', () => {
  it('serializes transaction advisory locks: the second holder waits for the first COMMIT', async () => {
    const db = makeFakeDb()
    const a = await db.pool('a').connect()
    await a.query('BEGIN')
    await a.query(SYNC_LOCK, ['llm-catalog-sync-v1'])
    let toggled = false
    const toggle = setProviderAutoEnable('claude', false, 'admin', db.pool('toggle')).then(() => {
      toggled = true
    })
    await flush()
    expect(toggled).toBe(false)
    await a.query('COMMIT')
    await toggle
    expect(db.settings).toMatchObject([{ provider: 'claude', auto_enable: false }])
    expect(db.locks.map(l => l.actor)).toEqual(['a', 'toggle'])
  })

  it('makes a writer of a pair another open transaction wrote wait, then re-check', async () => {
    const db = makeFakeDb()
    const a = await db.pool('a').connect()
    await a.query('BEGIN')
    await a.query(DISMISS, ['claude', 'x'])
    let second: number | null = null
    const b = db
      .pool('b')
      .query(DISMISS, ['claude', 'x'])
      .then(r => {
        second = r.rowCount
      })
    await flush()
    expect(second).toBeNull()
    await a.query('COMMIT')
    await b
    // The waiter saw the committed row and did nothing.
    expect(second).toBe(0)
    expect(db.dismissed.size).toBe(1)
  })

  it('lets the waiter insert when the transaction it waited for rolls back', async () => {
    const db = makeFakeDb()
    const a = await db.pool('a').connect()
    await a.query('BEGIN')
    await createAllowedModel(
      { provider: 'claude', model: 'x', enabled: true } as never,
      'a',
      a as never
    )
    const b = createLlmPrice(
      {
        provider: 'claude',
        model: 'x',
        input_token_price: 1,
        output_token_price: 1,
        cache_read_token_price: 0,
        cache_write_token_price: 0,
        currency: 'USD',
        enabled: true,
      } as never,
      db.pool('b')
    )
    const c = createAllowedModel(
      { provider: 'claude', model: 'x', enabled: false } as never,
      'c',
      db.pool('c')
    )
    await flush()
    await a.query('ROLLBACK')
    await Promise.all([b, c])
    expect(db.get('claude', 'x')).toMatchObject({ enabled: false, source: 'manual' })
  })

  it('fails the waiter that closes a lock cycle with a deadlock error', async () => {
    const db = makeFakeDb()
    const a = await db.pool('a').connect()
    const b = await db.pool('b').connect()
    await a.query('BEGIN')
    await b.query('BEGIN')
    await a.query(SYNC_LOCK, ['k1'])
    await b.query(SYNC_LOCK, ['k2'])
    const aWaits = a.query(SYNC_LOCK, ['k2'])
    await flush()
    await expect(b.query(SYNC_LOCK, ['k1'])).rejects.toMatchObject({ code: '40P01' })
    await b.query('ROLLBACK')
    await aWaits
    await a.query('COMMIT')
  })

  it('frees a session advisory lock on unlock or a destroyed connection, not on a plain release', async () => {
    const TRY = "SELECT pg_try_advisory_lock(hashtext('llm-catalog-sync-cron-v1')) AS acquired"
    const UNLOCK = "SELECT pg_advisory_unlock(hashtext('llm-catalog-sync-cron-v1'))"
    const db = makeFakeDb()
    const attempt = async () => (await (await db.pool('x').connect()).query(TRY)).rows[0]

    const unlocked = await db.pool('a').connect()
    expect((await unlocked.query(TRY)).rows[0]).toEqual({ acquired: true })
    expect(await attempt()).toEqual({ acquired: false })
    await unlocked.query(UNLOCK)
    unlocked.release()

    const destroyed = await db.pool('b').connect()
    expect((await destroyed.query(TRY)).rows[0]).toEqual({ acquired: true })
    destroyed.release(new Error('unlock failed'))

    const leaked = await db.pool('c').connect()
    expect((await leaked.query(TRY)).rows[0]).toEqual({ acquired: true })
    leaked.release()
    expect(await attempt()).toEqual({ acquired: false })
  })

  it('stale marking takes its targets from the statement snapshot, then holds each newest version', async () => {
    const STALE =
      "UPDATE llm_allowed_models SET stale = true WHERE provider = $1 AND source = 'discovery' AND stale = false AND model <> ALL($2::text[])"
    const db = makeFakeDb([
      { provider: 'claude', model: 'first' },
      { provider: 'claude', model: 'second' },
    ])
    const [first, second] = db.rows.map(r => r.id)
    const holder = await db.pool('holder').connect()
    await holder.query('BEGIN')
    await updateAllowedModel(first, { enabled: true } as never, 'admin', holder as never)
    const sync = await db.pool('sync').connect()
    await sync.query('BEGIN')
    const marking = sync.query(STALE, ['claude', []])
    await flush()
    // While the statement waits on `first`, `second` moves to another provider.
    await withTransaction(
      tx => updateAllowedModel(second, { provider: 'groq' } as never, 'admin', tx),
      db.pool('mover')
    )
    await holder.query('COMMIT')
    expect((await marking).rowCount).toBe(1)
    // `second` was a target in the snapshot: its newest version no longer
    // matches, so it is not marked, but it is held until the statement's
    // transaction ends.
    let blocked = true
    const late = withTransaction(
      tx => updateAllowedModel(second, { enabled: true } as never, 'admin', tx),
      db.pool('late')
    ).then(() => {
      blocked = false
    })
    for (let i = 0; i < 20; i++) await flush()
    expect(blocked).toBe(true)
    await sync.query('COMMIT')
    await late
    expect(db.get('groq', 'second')).toMatchObject({ stale: false, enabled: true })
  })
})
