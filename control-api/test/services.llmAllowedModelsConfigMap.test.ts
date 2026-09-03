import { describe, expect, it, vi } from 'vitest'
import type { DbClient } from '../src/db.js'
import type { CodexSubscriptionSafeConnection } from '../src/services/codexSubscriptionConnection.js'
import {
  ALLOWED_MODELS_CONFIGMAP_NAME,
  CATALOG_REVISION_ANNOTATION,
  CODEX_CONNECTIONS_ANNOTATION,
  CODEX_CONNECTION_STATUS_ANNOTATION,
  CODEX_ENABLED_ANNOTATION,
  CONNECTION_REVISION_ANNOTATION,
  CONTENT_HASH_ANNOTATION,
  LlmAllowedModelsConfigMapWriter,
  buildCodexReadinessAnnotations,
  buildConfigMapData,
  mapCodexConnectionStatusForSnapshot,
  publishAllowedModelsConfigMapAfterGrantChange,
} from '../src/services/llmAllowedModelsConfigMap.js'

function fakeDb(
  rows: Record<string, unknown>[],
  connectionRows: Record<string, unknown>[] = []
): DbClient {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (String(sql).includes('codex_subscription_connections')) {
        const liveOnly = String(sql).includes('revoked_at IS NULL')
        const selected = liveOnly
          ? connectionRows.filter(row => row.revoked_at == null)
          : connectionRows
        return Promise.resolve({ rows: selected, rowCount: selected.length })
      }
      return Promise.resolve({ rows, rowCount: rows.length })
    }),
  } as unknown as DbClient
}

function connectedRow(): Record<string, unknown> {
  return {
    connection_key: 'deployment-default',
    status: 'connected',
    credential_revision: 4,
    catalog_revision: 7,
    account_fingerprint: null,
    catalog_status: 'ready',
    catalog_synced_at: new Date('2026-08-20T00:00:00Z'),
    last_refresh_at: null,
    last_auth_at: new Date('2026-08-20T00:00:00Z'),
    refresh_lock_token: null,
    refresh_lock_expires_at: null,
    revoked_at: null,
    created_at: new Date('2026-08-20T00:00:00Z'),
    updated_at: new Date('2026-08-20T00:00:00Z'),
  }
}

describe('buildConfigMapData', () => {
  it('serializes one JSON array per provider and hashes deterministically', () => {
    const a = buildConfigMapData({
      claude: [{ model: 'claude-haiku-4-5', vendor: 'Anthropic' }],
      zai: [{ model: 'glm-4.7', vendor: 'Zhipu' }],
    })
    expect(JSON.parse(a.data.claude)).toEqual([{ model: 'claude-haiku-4-5', vendor: 'Anthropic' }])
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/)

    // Same content in different key order → identical hash (keys are sorted).
    const b = buildConfigMapData({
      zai: [{ model: 'glm-4.7', vendor: 'Zhipu' }],
      claude: [{ model: 'claude-haiku-4-5', vendor: 'Anthropic' }],
    })
    expect(b.contentHash).toBe(a.contentHash)

    // Different content → different hash.
    const c = buildConfigMapData({ claude: [{ model: 'claude-opus-4-8' }] })
    expect(c.contentHash).not.toBe(a.contentHash)
  })

  it('is byte-unchanged by the F1 catalog lifecycle columns (CM contract stable)', async () => {
    // listEnabledGroupedByProvider never selects source/discovered_at/last_seen_at/
    // stale, so even if the query rows carry them the materialized data + hash are
    // identical — mcp-host/WRC see no change from the F1 migration.
    const { listEnabledGroupedByProvider } = await import('../src/services/llmAllowedModels.js')
    const rowsWith = [
      {
        provider: 'zai',
        model: 'glm-4.7',
        vendor: 'Zhipu',
        display_name: null,
        context_window_tokens: null,
        source: 'discovery',
        discovered_at: new Date('2026-07-10T00:00:00Z'),
        last_seen_at: new Date('2026-07-11T00:00:00Z'),
        stale: true,
      },
    ]
    const rowsWithout = [
      {
        provider: 'zai',
        model: 'glm-4.7',
        vendor: 'Zhipu',
        display_name: null,
        context_window_tokens: null,
      },
    ]
    const groupedWith = await listEnabledGroupedByProvider(fakeDb(rowsWith))
    const groupedWithout = await listEnabledGroupedByProvider(fakeDb(rowsWithout))
    const withHash = buildConfigMapData(groupedWith)
    const withoutHash = buildConfigMapData(groupedWithout)
    expect(withHash.data).toEqual(withoutHash.data)
    expect(withHash.contentHash).toBe(withoutHash.contentHash)
    // The lifecycle fields never leak into the serialized entry.
    expect(withHash.data.zai).not.toMatch(/source|discovered_at|last_seen_at|stale/)
  })

  it('keeps the content-hash annotation as the drift authority while excluding stale Codex rows', async () => {
    const source = await import('node:fs').then(fs =>
      fs.readFileSync(new URL('../src/services/llmAllowedModels.ts', import.meta.url), 'utf8')
    )
    expect(source).toContain("NOT (provider = 'codex-subscription' AND stale)")
    expect(CONTENT_HASH_ANNOTATION).toBe('clerum.io/content-hash')
  })
})

describe('LlmAllowedModelsConfigMapWriter', () => {
  const rows = [
    {
      provider: 'zai',
      model: 'glm-4.7',
      vendor: 'Zhipu',
      display_name: null,
      context_window_tokens: null,
    },
  ]

  it('creates the ConfigMap with the content-hash annotation', async () => {
    const coreApi = {
      createNamespacedConfigMap: vi.fn().mockResolvedValue({}),
      readNamespacedConfigMap: vi.fn(),
      replaceNamespacedConfigMap: vi.fn(),
    }
    const writer = new LlmAllowedModelsConfigMapWriter(coreApi, 'mcp-host')
    await writer.materialize(fakeDb(rows))
    expect(coreApi.createNamespacedConfigMap).toHaveBeenCalledTimes(1)
    const arg = coreApi.createNamespacedConfigMap.mock.calls[0][0]
    expect(arg.namespace).toBe('mcp-host')
    expect(arg.body.metadata.name).toBe(ALLOWED_MODELS_CONFIGMAP_NAME)
    expect(arg.body.metadata.annotations[CONTENT_HASH_ANNOTATION]).toMatch(/^[0-9a-f]{64}$/)
    expect(arg.body.metadata.annotations[CODEX_ENABLED_ANNOTATION]).toBe('false')
    expect(arg.body.metadata.annotations[CODEX_CONNECTION_STATUS_ANNOTATION]).toBe('disconnected')
    expect(arg.body.metadata.annotations[CATALOG_REVISION_ANNOTATION]).toBeUndefined()
    expect(arg.body.metadata.annotations[CONNECTION_REVISION_ANNOTATION]).toBeUndefined()
    expect(JSON.parse(arg.body.data.zai)[0].model).toBe('glm-4.7')
  })

  it('adds readiness annotations without changing the data contract', async () => {
    const coreApi = {
      createNamespacedConfigMap: vi.fn().mockResolvedValue({}),
      readNamespacedConfigMap: vi.fn(),
      replaceNamespacedConfigMap: vi.fn(),
    }
    const writer = new LlmAllowedModelsConfigMapWriter(coreApi, 'mcp-host')
    await writer.materialize(fakeDb(rows, [connectedRow()]))
    const arg = coreApi.createNamespacedConfigMap.mock.calls[0][0]
    expect(JSON.parse(arg.body.data.zai)[0]).toEqual({
      model: 'glm-4.7',
      vendor: 'Zhipu',
    })
    expect(arg.body.metadata.annotations[CODEX_CONNECTION_STATUS_ANNOTATION]).toBe('connected')
    expect(arg.body.metadata.annotations[CATALOG_REVISION_ANNOTATION]).toBe('7')
    expect(arg.body.metadata.annotations[CONNECTION_REVISION_ANNOTATION]).toBe('4')
    expect(JSON.stringify(arg.body.data)).not.toMatch(/catalogRevision|credentialRevision|status/)
  })

  it('indexes the live deployment-default row after 0105 reuse, not the tombstone', async () => {
    const coreApi = {
      createNamespacedConfigMap: vi.fn().mockResolvedValue({}),
      readNamespacedConfigMap: vi.fn(),
      replaceNamespacedConfigMap: vi.fn(),
    }
    const tombstone = {
      ...connectedRow(),
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      status: 'revoked',
      credential_revision: 1,
      catalog_revision: 1,
      revoked_at: new Date('2026-08-21T00:00:00Z'),
    }
    const live = {
      ...connectedRow(),
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      credential_revision: 8,
      catalog_revision: 9,
      revoked_at: null,
    }
    const writer = new LlmAllowedModelsConfigMapWriter(coreApi, 'mcp-host')
    const db = fakeDb(rows, [tombstone, live])
    await writer.materialize(db)
    const connectionSql = (db.query as ReturnType<typeof vi.fn>).mock.calls
      .map(call => String(call[0]))
      .find(sql => sql.includes('codex_subscription_connections'))
    expect(connectionSql).toContain('revoked_at IS NULL')
    const arg = coreApi.createNamespacedConfigMap.mock.calls.at(-1)?.[0]
    expect(arg.body.metadata.annotations[CODEX_CONNECTION_STATUS_ANNOTATION]).toBe('connected')
    expect(arg.body.metadata.annotations[CATALOG_REVISION_ANNOTATION]).toBe('9')
    expect(arg.body.metadata.annotations[CONNECTION_REVISION_ANNOTATION]).toBe('8')
    const map = JSON.parse(arg.body.metadata.annotations[CODEX_CONNECTIONS_ANNOTATION] as string)
    expect(Object.keys(map)).toEqual(['deployment-default'])
    expect(map['deployment-default'].catalogRevision).toBe(9)
    expect(map['deployment-default'].connectionRevision).toBe(8)
    expect(map['deployment-default'].status).toBe('connected')
  })

  it('falls back to read + replace on a 409 conflict', async () => {
    const coreApi = {
      createNamespacedConfigMap: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('exists'), { code: 409 })),
      readNamespacedConfigMap: vi.fn().mockResolvedValue({ metadata: { resourceVersion: '42' } }),
      replaceNamespacedConfigMap: vi.fn().mockResolvedValue({}),
    }
    const writer = new LlmAllowedModelsConfigMapWriter(coreApi, 'mcp-host')
    await writer.materialize(fakeDb(rows))
    expect(coreApi.replaceNamespacedConfigMap).toHaveBeenCalledTimes(1)
    const arg = coreApi.replaceNamespacedConfigMap.mock.calls[0][0]
    expect(arg.body.metadata.resourceVersion).toBe('42')
  })

  it('retries a transient write failure and eventually succeeds', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 500 }))
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 500 }))
      .mockResolvedValueOnce({})
    const coreApi = {
      createNamespacedConfigMap: create,
      readNamespacedConfigMap: vi.fn(),
      replaceNamespacedConfigMap: vi.fn(),
    }
    const writer = new LlmAllowedModelsConfigMapWriter(coreApi, 'mcp-host', 3)
    await writer.materialize(fakeDb(rows))
    expect(create).toHaveBeenCalledTimes(3)
  })

  it('throws after exhausting retries', async () => {
    const coreApi = {
      createNamespacedConfigMap: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('down'), { code: 500 })),
      readNamespacedConfigMap: vi.fn(),
      replaceNamespacedConfigMap: vi.fn(),
    }
    const writer = new LlmAllowedModelsConfigMapWriter(coreApi, 'mcp-host', 2)
    await expect(writer.materialize(fakeDb(rows))).rejects.toThrow('down')
    expect(coreApi.createNamespacedConfigMap).toHaveBeenCalledTimes(2)
  })
})

describe('Codex readiness annotations', () => {
  it('maps only connected+ready to the snapshot-facing connected status', () => {
    const base = {
      id: '11111111-1111-1111-1111-111111111111',
      connectionKey: 'deployment-default',
      displayName: 'Default deployment',
      createdBy: null,
      credentialRevision: 1,
      catalogRevision: 2,
      accountFingerprint: null,
      catalogSyncedAt: null,
      lastRefreshAt: null,
      lastAuthAt: null,
      refreshLockHeld: false,
      revokedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as CodexSubscriptionSafeConnection
    expect(
      mapCodexConnectionStatusForSnapshot({
        ...base,
        status: 'connected',
        catalogStatus: 'ready',
      })
    ).toBe('connected')
    expect(
      mapCodexConnectionStatusForSnapshot({
        ...base,
        status: 'reauth_required',
        catalogStatus: 'ready',
      })
    ).toBe('reauth-required')
    expect(
      mapCodexConnectionStatusForSnapshot({
        ...base,
        status: 'connected',
        catalogStatus: 'unavailable',
      })
    ).toBe('unavailable')
    expect(mapCodexConnectionStatusForSnapshot(null)).toBe('disconnected')
  })

  it('maps revoked to a snapshot-facing revoked status and lists every key', () => {
    const base = {
      id: '11111111-1111-1111-1111-111111111111',
      displayName: 'Default deployment',
      createdBy: null,
      credentialRevision: 1,
      catalogRevision: 2,
      accountFingerprint: null,
      catalogSyncedAt: null,
      lastRefreshAt: null,
      lastAuthAt: null,
      refreshLockHeld: false,
      revokedAt: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as Omit<CodexSubscriptionSafeConnection, 'connectionKey' | 'status' | 'catalogStatus'>
    const revoked = {
      ...base,
      connectionKey: 'team-plus',
      status: 'revoked' as const,
      catalogStatus: 'ready' as const,
      revokedAt: new Date(),
    }
    const live = {
      ...base,
      connectionKey: 'personal-pro',
      status: 'connected' as const,
      catalogStatus: 'ready' as const,
    }
    expect(mapCodexConnectionStatusForSnapshot(revoked)).toBe('revoked')
    const annotations = buildCodexReadinessAnnotations(live, [revoked, live], {
      'personal-pro': ['gpt-5.3-codex'],
      'team-plus': ['gpt-5.1'],
    })
    const map = JSON.parse(annotations['clerum.io/codex-connections'] as string) as Record<
      string,
      { status: string; models: string[] }
    >
    expect(map['team-plus'].status).toBe('revoked')
    expect(map['personal-pro'].status).toBe('connected')
    expect(map['personal-pro'].models).toEqual(['gpt-5.3-codex'])
    expect(map['team-plus'].models).toEqual(['gpt-5.1'])
  })

  it('omits revision annotations when the connection row is absent', () => {
    const annotations = buildCodexReadinessAnnotations(null)
    expect(annotations[CODEX_CONNECTION_STATUS_ANNOTATION]).toBe('disconnected')
    expect(annotations[CATALOG_REVISION_ANNOTATION]).toBeUndefined()
    expect(annotations[CONNECTION_REVISION_ANNOTATION]).toBeUndefined()
  })
})

describe('publishAllowedModelsConfigMapAfterGrantChange', () => {
  it('skips when no writer is wired', async () => {
    await expect(publishAllowedModelsConfigMapAfterGrantChange(undefined)).resolves.toBe('skipped')
  })

  it('materializes when a writer is present', async () => {
    const materialize = vi.fn(async () => {})
    await expect(publishAllowedModelsConfigMapAfterGrantChange({ materialize })).resolves.toBe(
      'published'
    )
    expect(materialize).toHaveBeenCalledTimes(1)
  })
})
