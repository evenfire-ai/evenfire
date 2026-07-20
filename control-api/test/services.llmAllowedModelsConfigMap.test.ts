import { describe, expect, it, vi } from 'vitest'
import type { DbClient } from '../src/db.js'
import {
  ALLOWED_MODELS_CONFIGMAP_NAME,
  CONTENT_HASH_ANNOTATION,
  LlmAllowedModelsConfigMapWriter,
  buildConfigMapData,
} from '../src/services/llmAllowedModelsConfigMap.js'

function fakeDb(rows: Record<string, unknown>[]): DbClient {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
  } as unknown as DbClient
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
    expect(JSON.parse(arg.body.data.zai)[0].model).toBe('glm-4.7')
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
