import { describe, expect, it, vi } from 'vitest'
import { CATALOG_ORIGIN } from '@clerum/grok-provider-attempt-contract'
import {
  GROK_CATALOG_ORIGIN,
  pickGrokGrantModel,
  planGrokCatalogReconcile,
  syncGrokSubscriptionCatalog,
} from '../src/services/grokSubscriptionCatalog.js'
import {
  isGrokUnassignedConnectionKey,
  readHostGrokConnectionRef,
} from '../src/services/grokSubscriptionConnection.js'

describe('grok subscription catalog', () => {
  it('uses the frozen catalog origin from the Grok attempt contract', () => {
    expect(GROK_CATALOG_ORIGIN).toBe(CATALOG_ORIGIN)
    expect(GROK_CATALOG_ORIGIN).toBe('https://cli-chat-proxy.grok.com/v1/models')
    expect(GROK_CATALOG_ORIGIN).not.toContain('api.x.ai')
  })

  it('auto-enables new discovery rows and never invents a static default model', () => {
    const plan = planGrokCatalogReconcile([], {
      outcome: 'ready',
      models: [{ model: 'grok-4.6' }, { model: 'grok-4.5' }],
    })
    expect(plan.catalogStatus).toBe('ready')
    expect(plan.inserts.map(row => row.model)).toEqual(['grok-4.6', 'grok-4.5'])
    expect(pickGrokGrantModel('', ['grok-4.6', 'grok-4.5'], 'grok-4.6')).toBe('grok-4.6')
    expect(pickGrokGrantModel('missing', ['grok-4.6'], null)).toBe('grok-4.6')
  })

  it('rejects unassigned Host refs for assignment', () => {
    expect(isGrokUnassignedConnectionKey(readHostGrokConnectionRef(''))).toBe(true)
    expect(isGrokUnassignedConnectionKey(readHostGrokConnectionRef('team-grok'))).toBe(false)
  })

  describe('syncGrokSubscriptionCatalog atomicity', () => {
    const CONNECTION_ROW = {
      id: '11111111-1111-4111-8111-111111111111',
      connection_key: 'team-grok',
      display_name: 'team-grok',
      default_model: null,
      created_by: null,
      status: 'connected',
      credential_revision: 2,
      catalog_revision: 0,
      account_fingerprint: 'fp',
      catalog_status: 'never_synced',
      catalog_synced_at: null,
      last_refresh_at: null,
      last_auth_at: null,
      refresh_lock_token: null,
      refresh_lock_expires_at: null,
      revoked_at: null,
      created_at: new Date(),
      updated_at: new Date(),
    }

    function harness(opts: { failOn?: RegExp } = {}) {
      let inTransaction = false
      const writesOutside: string[] = []
      const txLog: string[] = []
      const outside = {
        query: vi.fn(async (sql: string) => {
          if (/^\s*(INSERT|UPDATE)/i.test(sql)) writesOutside.push(sql)
          if (sql.includes('FROM grok_subscription_connections')) {
            return { rows: [CONNECTION_ROW], rowCount: 1 }
          }
          return { rows: [], rowCount: 0 }
        }),
      }
      const tx = {
        query: vi.fn(async (sql: string) => {
          if (!inTransaction) writesOutside.push(sql)
          txLog.push(sql)
          if (opts.failOn?.test(sql)) throw new Error('injected failure')
          if (sql.includes('UPDATE grok_subscription_connections')) {
            return { rows: [{ ...CONNECTION_ROW, catalog_status: 'ready' }], rowCount: 1 }
          }
          if (sql.includes('INSERT INTO grok_catalog_models')) return { rows: [], rowCount: 1 }
          return { rows: [], rowCount: 0 }
        }),
      }
      const withTransaction = vi.fn(async <T>(work: (db: typeof tx) => Promise<T>) => {
        inTransaction = true
        try {
          return await work(tx)
        } finally {
          inTransaction = false
        }
      })
      return { outside, tx, txLog, writesOutside, withTransaction }
    }

    it('records readiness, reconciles rows and rebuilds the union inside one transaction', async () => {
      const h = harness()
      const listModels = vi.fn(async () => {
        expect(h.withTransaction).not.toHaveBeenCalled()
        return { outcome: 'ready' as const, models: [{ model: 'grok-4.6' }] }
      })
      const synced = await syncGrokSubscriptionCatalog(
        h.outside,
        { listModels },
        'access-token',
        { connectionKey: 'team-grok' },
        { withTransaction: h.withTransaction as never }
      )
      expect(synced.outcome).toBe('ready')
      expect(synced.added).toBe(1)
      expect(h.withTransaction).toHaveBeenCalledTimes(1)
      expect(h.writesOutside).toEqual([])
      expect(h.txLog.some(sql => sql.includes('UPDATE grok_subscription_connections'))).toBe(true)
      expect(h.txLog.some(sql => sql.includes('INSERT INTO grok_catalog_models'))).toBe(true)
      expect(h.txLog.some(sql => sql.includes('INSERT INTO llm_allowed_models'))).toBe(true)
    })

    it('propagates a mid-reconcile failure out of the transaction instead of reporting ready', async () => {
      const h = harness({ failOn: /INSERT INTO grok_catalog_models/ })
      await expect(
        syncGrokSubscriptionCatalog(
          h.outside,
          { listModels: async () => ({ outcome: 'ready', models: [{ model: 'grok-4.6' }] }) },
          'access-token',
          { connectionKey: 'team-grok' },
          { withTransaction: h.withTransaction as never }
        )
      ).rejects.toThrow('injected failure')
      expect(h.writesOutside).toEqual([])
      expect(h.txLog.some(sql => sql.includes('INSERT INTO llm_allowed_models'))).toBe(false)
    })
  })
})
