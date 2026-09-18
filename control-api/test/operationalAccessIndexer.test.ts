import { describe, expect, it, vi } from 'vitest'
import type { OperationalAccessIndex } from '../src/services/access/operationalAccessIndex.js'
import { OperationalAccessIndexer } from '../src/services/access/operationalAccessIndexer.js'

function hostObject(name: string, resourceVersion: string) {
  return {
    metadata: {
      name,
      namespace: 'mcp-host',
      uid: `uid-${name}`,
      resourceVersion,
    },
    spec: { host: name, contextRef: 'ctx-a', secretRef: 'secret-a' },
  }
}

function fakeIndex() {
  return {
    beginRelist: vi.fn().mockResolvedValue(2),
    stageRelistPage: vi.fn().mockResolvedValue(undefined),
    promoteRelist: vi.fn().mockResolvedValue(undefined),
    applyWatchProjection: vi.fn().mockResolvedValue(3),
    recordWatchBookmark: vi.fn().mockResolvedValue(undefined),
    markSourceState: vi.fn().mockResolvedValue(undefined),
  }
}

describe('operational access indexer', () => {
  it('reconciles bounded Kubernetes pages into one atomic source generation', async () => {
    const index = fakeIndex()
    const listResourcePage = vi
      .fn()
      .mockResolvedValueOnce({
        items: [hostObject('host-a', '10')],
        continueToken: 'next',
        resourceVersion: '10',
      })
      .mockResolvedValueOnce({
        items: [hostObject('host-b', '10')],
        continueToken: null,
        resourceVersion: '10',
      })
    const indexer = new OperationalAccessIndexer(
      {
        listResourcePage,
        watchResource: vi.fn(),
        getResourceExact: vi.fn(),
      },
      index as unknown as OperationalAccessIndex,
      { environmentId: 'test:cluster', behaviorFingerprintKey: 'test-key' }
    )

    await expect(
      indexer.reconcileSource({ family: 'host', plural: 'hosts', namespace: 'mcp-host' })
    ).resolves.toBe('10')

    expect(listResourcePage).toHaveBeenCalledTimes(2)
    expect(listResourcePage.mock.calls[0]?.[2]).toMatchObject({ limit: 100 })
    expect(listResourcePage.mock.calls[1]?.[2]).toMatchObject({
      limit: 100,
      continueToken: 'next',
    })
    expect(index.stageRelistPage).toHaveBeenCalledTimes(2)
    expect(index.promoteRelist).toHaveBeenCalledOnce()
  })

  it('does not promote pages from inconsistent snapshot resource versions', async () => {
    const index = fakeIndex()
    const indexer = new OperationalAccessIndexer(
      {
        listResourcePage: vi
          .fn()
          .mockResolvedValueOnce({ items: [], continueToken: 'next', resourceVersion: '10' })
          .mockResolvedValueOnce({ items: [], continueToken: null, resourceVersion: '11' }),
        watchResource: vi.fn(),
        getResourceExact: vi.fn(),
      },
      index as unknown as OperationalAccessIndex,
      { environmentId: 'test:cluster', behaviorFingerprintKey: 'test-key' }
    )

    await expect(
      indexer.reconcileSource({ family: 'host', plural: 'hosts', namespace: 'mcp-host' })
    ).rejects.toThrow('operational_relist_snapshot_changed')
    expect(index.promoteRelist).not.toHaveBeenCalled()
  })

  it('applies watch deletion and rejects expired watches for relist', async () => {
    const index = fakeIndex()
    const indexer = new OperationalAccessIndexer(
      {
        listResourcePage: vi.fn(),
        watchResource: vi.fn(),
        getResourceExact: vi.fn(),
      },
      index as unknown as OperationalAccessIndex,
      { environmentId: 'test:cluster', behaviorFingerprintKey: 'test-key' }
    )
    const source = { family: 'host', plural: 'hosts', namespace: 'mcp-host' } as const

    await indexer.applyWatchEvent(source, 'DELETED', hostObject('host-a', '12'))
    expect(index.applyWatchProjection).toHaveBeenCalledWith(
      expect.objectContaining({ deleted: true, resourceVersion: '12' })
    )
    await expect(indexer.applyWatchEvent(source, 'ERROR', { code: 410 })).rejects.toThrow(
      'watch expired'
    )
  })

  it('records bookmarks without rewriting resource projections', async () => {
    const index = fakeIndex()
    const indexer = new OperationalAccessIndexer(
      {
        listResourcePage: vi.fn(),
        watchResource: vi.fn(),
        getResourceExact: vi.fn(),
      },
      index as unknown as OperationalAccessIndex,
      { environmentId: 'test:cluster', behaviorFingerprintKey: 'test-key' }
    )

    await indexer.applyWatchEvent(
      { family: 'host', plural: 'hosts', namespace: 'mcp-host' },
      'BOOKMARK',
      { metadata: { resourceVersion: '15' } }
    )
    expect(index.recordWatchBookmark).toHaveBeenCalledWith(
      expect.objectContaining({ resourceVersion: '15' })
    )
    expect(index.applyWatchProjection).not.toHaveBeenCalled()
  })
})
