import { describe, expect, it, vi } from 'vitest'
import { config } from '../src/config.js'
import type { DbClient } from '../src/db.js'
import type { CodexSubscriptionSafeConnection } from '../src/services/codexSubscriptionConnection.js'
import { listEnabledGroupedByProvider } from '../src/services/llmAllowedModels.js'
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
import { FakeConfigMapApi, poolFromQuery } from './helpers/fakeAllowlistCluster.js'

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

  it('#654 moves the content hash when a capability is published, and only then', async () => {
    const { listEnabledGroupedByProvider } = await import('../src/services/llmAllowedModels.js')
    const curated = {
      state: 'supported',
      evidence: {
        source: 'curated',
        reference: 'https://docs.z.ai/guides/vlm/glm-5.3-flash',
        checkedAt: '2026-09-16T00:00:00.000Z',
      },
    }
    const row = (image_input: unknown) => [
      {
        provider: 'zai',
        model: 'glm-5.3-flash',
        vendor: 'Zhipu',
        display_name: null,
        context_window_tokens: null,
        image_input,
      },
    ]

    const without = buildConfigMapData(await listEnabledGroupedByProvider(fakeDb(row(null))))
    const absent = buildConfigMapData(
      await listEnabledGroupedByProvider(fakeDb([{ ...row(null)[0], image_input: undefined }]))
    )
    const withCapability = buildConfigMapData(
      await listEnabledGroupedByProvider(fakeDb(row(curated)))
    )

    // NULL and absent project identically: an uncurated allowlist keeps the
    // pre-#654 bytes, so the host is not woken by a migration.
    expect(absent.contentHash).toBe(without.contentHash)
    expect(absent.data.zai).not.toMatch(/imageInput/)
    // A published capability DOES change the materialized data + hash: the host
    // must observe a capability change through the ConfigMap.
    expect(withCapability.contentHash).not.toBe(without.contentHash)
    expect(JSON.parse(withCapability.data.zai)[0].imageInput).toEqual(curated)
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

  function writerOver(
    cluster: FakeConfigMapApi,
    db: DbClient,
    maxAttempts = 3
  ): LlmAllowedModelsConfigMapWriter {
    return new LlmAllowedModelsConfigMapWriter(
      cluster,
      'mcp-host',
      maxAttempts,
      poolFromQuery(db.query)
    )
  }

  function enabledReads(db: DbClient): number {
    return (db.query as ReturnType<typeof vi.fn>).mock.calls.filter(call =>
      /FROM llm_allowed_models\s+WHERE enabled/.test(String(call[0]))
    ).length
  }

  it('creates the ConfigMap with the content-hash annotation', async () => {
    const cluster = new FakeConfigMapApi()
    await writerOver(cluster, fakeDb(rows)).materialize()
    expect(cluster.writes).toBe(1)
    const cm = cluster.current!
    expect(cm.metadata!.name).toBe(ALLOWED_MODELS_CONFIGMAP_NAME)
    expect(cm.metadata!.namespace).toBe('mcp-host')
    expect(cm.metadata!.annotations![CONTENT_HASH_ANNOTATION]).toMatch(/^[0-9a-f]{64}$/)
    // The Codex subscription is on by default (CONTROL_API_CODEX_SUBSCRIPTION_ENABLED unset).
    expect(cm.metadata!.annotations![CODEX_ENABLED_ANNOTATION]).toBe('true')
    expect(cm.metadata!.annotations![CODEX_CONNECTION_STATUS_ANNOTATION]).toBe('disconnected')
    expect(cm.metadata!.annotations![CATALOG_REVISION_ANNOTATION]).toBeUndefined()
    expect(cm.metadata!.annotations![CONNECTION_REVISION_ANNOTATION]).toBeUndefined()
    expect(JSON.parse(cm.data!.zai)[0].model).toBe('glm-4.7')
  })

  it('publishes codex-enabled "false" when the Codex subscription is turned off', async () => {
    const previous = config.codexSubscriptionEnabled
    config.codexSubscriptionEnabled = false
    try {
      const cluster = new FakeConfigMapApi()
      await writerOver(cluster, fakeDb(rows)).materialize()
      expect(cluster.writes).toBe(1)
      expect(cluster.current!.metadata!.annotations![CODEX_ENABLED_ANNOTATION]).toBe('false')
    } finally {
      config.codexSubscriptionEnabled = previous
    }
  })

  it('reads the database on the lock connection, inside one bounded transaction', async () => {
    const cluster = new FakeConfigMapApi()
    const db = fakeDb(rows)
    await writerOver(cluster, db).materialize()
    const sql = (db.query as ReturnType<typeof vi.fn>).mock.calls.map(call => String(call[0]))
    const begin = sql.indexOf('BEGIN')
    const bound = sql.findIndex(q => q.includes('idle_in_transaction_session_timeout'))
    const lock = sql.findIndex(q => q.includes('pg_advisory_xact_lock'))
    const read = sql.findIndex(q => /FROM llm_allowed_models\s+WHERE enabled/.test(q))
    const commit = sql.indexOf('COMMIT')
    expect(begin).toBeGreaterThanOrEqual(0)
    expect(begin).toBeLessThan(bound)
    expect(bound).toBeLessThan(lock)
    expect(lock).toBeLessThan(read)
    expect(read).toBeLessThan(commit)
    const lockCall = (db.query as ReturnType<typeof vi.fn>).mock.calls[lock]
    expect(lockCall[1]).toEqual(['llm-allowlist-cm-v1'])
  })

  it('adds readiness annotations without changing the data contract', async () => {
    const cluster = new FakeConfigMapApi()
    await writerOver(cluster, fakeDb(rows, [connectedRow()])).materialize()
    const cm = cluster.current!
    expect(JSON.parse(cm.data!.zai)[0]).toEqual({
      model: 'glm-4.7',
      vendor: 'Zhipu',
    })
    expect(cm.metadata!.annotations![CODEX_CONNECTION_STATUS_ANNOTATION]).toBe('connected')
    expect(cm.metadata!.annotations![CATALOG_REVISION_ANNOTATION]).toBe('7')
    expect(cm.metadata!.annotations![CONNECTION_REVISION_ANNOTATION]).toBe('4')
    expect(JSON.stringify(cm.data)).not.toMatch(/catalogRevision|credentialRevision|status/)
  })

  it('indexes the live deployment-default row after 0105 reuse, not the tombstone', async () => {
    const cluster = new FakeConfigMapApi()
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
    const db = fakeDb(rows, [tombstone, live])
    await writerOver(cluster, db).materialize()
    const connectionSql = (db.query as ReturnType<typeof vi.fn>).mock.calls
      .map(call => String(call[0]))
      .find(sql => sql.includes('codex_subscription_connections'))
    expect(connectionSql).toContain('revoked_at IS NULL')
    const annotations = cluster.annotations!
    expect(annotations[CODEX_CONNECTION_STATUS_ANNOTATION]).toBe('connected')
    expect(annotations[CATALOG_REVISION_ANNOTATION]).toBe('9')
    expect(annotations[CONNECTION_REVISION_ANNOTATION]).toBe('8')
    const map = JSON.parse(annotations[CODEX_CONNECTIONS_ANNOTATION] as string)
    expect(Object.keys(map)).toEqual(['deployment-default'])
    expect(map['deployment-default'].catalogRevision).toBe(9)
    expect(map['deployment-default'].connectionRevision).toBe(8)
    expect(map['deployment-default'].status).toBe('connected')
  })

  it('replaces an existing ConfigMap with the resourceVersion it read', async () => {
    const cluster = new FakeConfigMapApi()
    await writerOver(cluster, fakeDb([])).materialize()
    const before = cluster.resourceVersion
    await writerOver(cluster, fakeDb(rows)).materialize()
    expect(cluster.writes).toBe(2)
    expect(cluster.conflicts).toBe(0)
    expect(cluster.resourceVersion).not.toBe(before)
    expect(JSON.parse(cluster.data!.zai)[0].model).toBe('glm-4.7')
  })

  it('retries a transient write failure, re-reading the database on every attempt', async () => {
    const cluster = new FakeConfigMapApi()
    cluster.failNextWrites(2)
    const db = fakeDb(rows)
    await writerOver(cluster, db, 3).materialize()
    expect(cluster.writes).toBe(1)
    // A retry never reuses data read in an earlier attempt.
    expect(enabledReads(db)).toBe(3)
  })

  it('throws after exhausting retries', async () => {
    const cluster = new FakeConfigMapApi()
    cluster.failNextWrites(5, Object.assign(new Error('down'), { code: 500 }))
    await expect(writerOver(cluster, fakeDb(rows), 2).materialize()).rejects.toThrow('down')
    expect(cluster.writes).toBe(0)
  })

  it('aborts without writing when the lock session can no longer read the database', async () => {
    const cluster = new FakeConfigMapApi()
    const db = fakeDb(rows)
    const base = (db.query as ReturnType<typeof vi.fn>).getMockImplementation()!
    ;(db.query as ReturnType<typeof vi.fn>).mockImplementation(
      (sql: string, params?: unknown[]) => {
        if (/FROM llm_allowed_models\s+WHERE enabled/.test(String(sql))) {
          return Promise.reject(
            Object.assign(new Error('terminating connection due to idle-in-transaction timeout'), {
              code: '25P03',
            })
          )
        }
        return base(sql, params)
      }
    )
    await expect(writerOver(cluster, db).materialize()).rejects.toThrow(/idle-in-transaction/)
    expect(cluster.writes).toBe(0)
    // No retry with a dead session: one read attempt, then abort.
    expect(enabledReads(db)).toBe(1)
  })

  it('refuses to replace without a resourceVersion (the write would lose its CAS)', async () => {
    const cluster = new FakeConfigMapApi()
    await writerOver(cluster, fakeDb([])).materialize()
    cluster.omitResourceVersionOnRead = true
    await expect(writerOver(cluster, fakeDb(rows), 2).materialize()).rejects.toThrow(
      /no resourceVersion/
    )
    expect(cluster.writes).toBe(1)
    expect(cluster.data).toEqual({})
  })

  it('a K8s call that never answers is a failed attempt, bounded per call', async () => {
    const cluster = new FakeConfigMapApi()
    cluster.hooks.before = () => new Promise<void>(() => undefined)
    const writer = new LlmAllowedModelsConfigMapWriter(
      cluster,
      'mcp-host',
      2,
      poolFromQuery(fakeDb(rows).query),
      50
    )
    const started = Date.now()
    await expect(writer.materialize()).rejects.toThrow(/read timed out after 50 ms/)
    // Two bounded GETs plus one 100 ms backoff, never the hang.
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(cluster.writes).toBe(0)
  })

  it.each(['create', 'replace'] as const)(
    'a %s that never answers after the GET is bounded, and the publication releases',
    async phase => {
      const cluster = new FakeConfigMapApi()
      if (phase === 'replace') await writerOver(cluster, fakeDb([])).materialize()
      cluster.hooks.before = p => (p === phase ? new Promise<void>(() => undefined) : undefined)
      const db = fakeDb(rows)
      const writer = new LlmAllowedModelsConfigMapWriter(
        cluster,
        'mcp-host',
        2,
        poolFromQuery(db.query),
        50
      )
      const started = Date.now()
      await expect(writer.materialize()).rejects.toThrow(
        new RegExp(`${phase} timed out after 50 ms`)
      )
      expect(Date.now() - started).toBeLessThan(1_000)
      const statements = vi.mocked(db.query).mock.calls.map(([sql]) => String(sql).trim())
      expect(statements.at(-1)).toBe('ROLLBACK')
    }
  )

  it('materializeIfChanged skips the write when the CM hash already matches the database', async () => {
    const cluster = new FakeConfigMapApi()
    const writer = writerOver(cluster, fakeDb(rows))
    expect(await writer.materializeIfChanged()).toBe('written')
    expect(await writer.materializeIfChanged()).toBe('unchanged')
    expect(cluster.writes).toBe(1)
    expect(cluster.annotations![CONTENT_HASH_ANNOTATION]).toBe(
      buildConfigMapData(await listEnabledGroupedByProvider(fakeDb(rows))).contentHash
    )
  })

  it('materialize writes even when the data hash already matches (readiness-only change)', async () => {
    const cluster = new FakeConfigMapApi()
    await writerOver(cluster, fakeDb(rows)).materialize()
    const hashBefore = cluster.annotations![CONTENT_HASH_ANNOTATION]
    // Same enabled rows, a connected Codex grant: only readiness annotations move.
    const writer = writerOver(cluster, fakeDb(rows, [connectedRow()]))
    await writer.materialize()
    expect(cluster.writes).toBe(2)
    expect(cluster.annotations![CONTENT_HASH_ANNOTATION]).toBe(hashBefore)
    expect(cluster.annotations![CODEX_CONNECTION_STATUS_ANNOTATION]).toBe('connected')
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
