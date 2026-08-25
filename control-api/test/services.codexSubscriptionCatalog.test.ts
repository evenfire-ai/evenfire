import { describe, expect, it, vi } from 'vitest'
import {
  createCodexCatalogTransportFromEnv,
  createCodexProxyCatalogTransport,
  pickCodexGrantModel,
  planCodexCatalogReconcile,
  syncCodexSubscriptionCatalog,
} from '../src/services/codexSubscriptionCatalog.js'
import { listEnabledGroupedByProvider } from '../src/services/llmAllowedModels.js'
import { buildConfigMapData } from '../src/services/llmAllowedModelsConfigMap.js'
import { makeFakeDb } from './helpers/llmCatalogSyncFakeDb.js'

describe('pickCodexGrantModel', () => {
  it('keeps the current name when the grant already offers it', () => {
    expect(pickCodexGrantModel('gpt-5.1', ['gpt-5.1', 'gpt-5.2'])).toBe('gpt-5.1')
  })

  it('seeds the first offered model when the current name is empty or not offered', () => {
    expect(pickCodexGrantModel('', ['gpt-5.1', 'gpt-5.2'])).toBe('gpt-5.1')
    expect(pickCodexGrantModel('gpt-5.4-mini', ['gpt-5.6-luna'])).toBe('gpt-5.6-luna')
  })

  it('does not invent a model when the grant list is empty', () => {
    expect(pickCodexGrantModel('gpt-5.4-mini', [])).toBe('')
    expect(pickCodexGrantModel('', [])).toBe('')
  })

  it('prefers the grant default when the current name is not offered', () => {
    expect(pickCodexGrantModel('', ['gpt-5.1', 'gpt-5.6-luna'], 'gpt-5.6-luna')).toBe(
      'gpt-5.6-luna'
    )
    expect(pickCodexGrantModel('gpt-5.1', ['gpt-5.1', 'gpt-5.6-luna'], 'gpt-5.6-luna')).toBe(
      'gpt-5.1'
    )
    expect(pickCodexGrantModel('', ['gpt-5.1'], 'missing')).toBe('gpt-5.1')
    expect(pickCodexGrantModel('', [], 'gpt-5.6-luna')).toBe('')
  })
})

describe('planCodexCatalogReconcile', () => {
  it('ready upserts discovered rows, inserts disabled, and stales missing discovery models', () => {
    const plan = planCodexCatalogReconcile(
      [
        { model: 'gpt-5', source: 'discovery', enabled: true, stale: false },
        { model: 'legacy-codex', source: 'discovery', enabled: true, stale: false },
        { model: 'manual-keep', source: 'manual', enabled: true, stale: false },
      ],
      {
        outcome: 'ready',
        models: [
          { model: 'gpt-5', displayName: 'GPT-5' },
          { model: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex' },
        ],
      }
    )
    expect(plan.mutateRows).toBe(true)
    expect(plan.inserts.map(model => model.model)).toEqual(['gpt-5.3-codex'])
    expect(plan.refresh).toEqual(['gpt-5'])
    expect(plan.stale).toEqual(['legacy-codex'])
    expect(plan.catalogStatus).toBe('ready')
    expect(plan.connectionStatus).toBeUndefined()
  })

  it('auth-rejected preserves rows and enablement and does not stale', () => {
    const plan = planCodexCatalogReconcile(
      [{ model: 'gpt-5', source: 'discovery', enabled: true, stale: false }],
      { outcome: 'auth-rejected' }
    )
    expect(plan.mutateRows).toBe(false)
    expect(plan.stale).toEqual([])
    expect(plan.inserts).toEqual([])
    expect(plan.catalogStatus).toBe('auth-rejected')
    expect(plan.connectionStatus).toBe('reauth_required')
  })

  it('unavailable preserves rows and never substitutes a model', () => {
    const plan = planCodexCatalogReconcile(
      [{ model: 'gpt-5', source: 'discovery', enabled: true, stale: false }],
      { outcome: 'unavailable' }
    )
    expect(plan.mutateRows).toBe(false)
    expect(plan.stale).toEqual([])
    expect(plan.catalogStatus).toBe('unavailable')
    expect(plan.connectionStatus).toBeUndefined()
  })
})

describe('Codex catalog materialization', () => {
  it('keeps a stale Codex target visible in the DB but not executable in the ConfigMap', async () => {
    const db = makeFakeDb([
      {
        provider: 'codex-subscription',
        model: 'gpt-5',
        source: 'discovery',
        enabled: true,
        stale: true,
      },
      {
        provider: 'claude',
        model: 'claude-opus-4-5',
        source: 'discovery',
        enabled: true,
        stale: true,
      },
    ])
    const client = await db.connector.connect()
    const grouped = await listEnabledGroupedByProvider({ query: client.query })
    const { data, contentHash } = buildConfigMapData(grouped)
    expect(data.claude).toContain('claude-opus-4-5')
    expect(data['codex-subscription']).toBeUndefined()
    expect(db.get('codex-subscription', 'gpt-5')?.enabled).toBe(true)
    expect(contentHash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('syncCodexSubscriptionCatalog fencing', () => {
  it('does not apply a stale writer after a newer catalog revision', async () => {
    const query = vi.fn(async (sql: string) => {
      if (/FROM codex_subscription_connections/.test(sql) && /SELECT/.test(sql)) {
        return {
          rows: [
            {
              connection_key: 'deployment-default',
              status: 'connected',
              credential_revision: 2,
              catalog_revision: 4,
              account_fingerprint: 'fp',
              catalog_status: 'ready',
              catalog_synced_at: new Date(),
              last_refresh_at: null,
              last_auth_at: null,
              refresh_lock_token: null,
              refresh_lock_expires_at: null,
              revoked_at: null,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
          rowCount: 1,
        }
      }
      if (/FROM llm_allowed_models/.test(sql)) {
        return {
          rows: [{ model: 'gpt-5', source: 'discovery', enabled: true, stale: false }],
          rowCount: 1,
        }
      }
      if (/UPDATE llm_allowed_models[\s\S]*stale = true/.test(sql)) {
        throw new Error('stale writer must not mark missing models')
      }
      if (/UPDATE codex_subscription_connections/.test(sql)) {
        return { rows: [], rowCount: 0 }
      }
      return { rows: [], rowCount: 0 }
    })
    const result = await syncCodexSubscriptionCatalog(
      { query },
      {
        async listModels() {
          return { outcome: 'unavailable' }
        },
      },
      'access-token',
      { credentialRevision: 1, catalogRevision: 1 }
    )
    expect(result.outcome).toBe('unavailable')
    expect(result.connection).toBeNull()
    expect(result.staled).toBe(0)
  })
})

describe('Codex proxy catalog transport', () => {
  it('stays unavailable when the proxy admin URL is unset', () => {
    const transport = createCodexCatalogTransportFromEnv({})
    return expect(transport.listModels({ accessToken: 'tok' })).resolves.toEqual({
      outcome: 'unavailable',
    })
  })

  it('posts a JIT access token to the proxy admin models route and returns normalized models', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(
        'http://codex-llm-proxy.control-plane.svc:8081/internal/admin/v1/codex/models'
      )
      expect(
        String(init?.headers && (init.headers as Record<string, string>).authorization)
      ).toContain('Bearer ')
      expect(JSON.parse(String(init?.body))).toEqual({ accessToken: 'tok-live' })
      return new Response(JSON.stringify({ outcome: 'ready', models: [{ model: 'gpt-5.1' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const transport = createCodexProxyCatalogTransport({
      adminBaseUrl: 'http://codex-llm-proxy.control-plane.svc:8081',
      fetchFn,
      signPermit: () => 'permit',
    })
    await expect(transport.listModels({ accessToken: 'tok-live' })).resolves.toEqual({
      outcome: 'ready',
      models: [{ model: 'gpt-5.1' }],
    })
    expect(fetchFn).toHaveBeenCalledOnce()
  })

  it('maps a proxy transport failure to unavailable without throwing', async () => {
    const transport = createCodexProxyCatalogTransport({
      adminBaseUrl: 'http://codex-llm-proxy.control-plane.svc:8081',
      fetchFn: async () => {
        throw new TypeError('fetch failed')
      },
      signPermit: () => 'permit',
    })
    await expect(transport.listModels({ accessToken: 'tok-live' })).resolves.toEqual({
      outcome: 'unavailable',
    })
  })
})
