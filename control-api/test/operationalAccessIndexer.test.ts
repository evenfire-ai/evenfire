import { describe, expect, it, vi } from 'vitest'
import { K8sGateway } from '../src/k8s.js'
import {
  type AccessExecutionBudget,
  type AccessExecutionLimits,
} from '../src/services/access/accessExecutionBudget.js'
import type { OperationalAccessIndex } from '../src/services/access/operationalAccessIndex.js'
import { OperationalAccessIndexer } from '../src/services/access/operationalAccessIndexer.js'
import { TemporaryKubernetesApi } from './helpers/temporaryKubernetesApi.js'

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

function meteredIndex() {
  const observed: {
    limits?: AccessExecutionLimits
    beforePromotion?: { producerCalls: number; databaseStatements: number }
    afterPromotion?: { producerCalls: number; databaseStatements: number }
  } = {}
  const charge = (
    budget: AccessExecutionBudget,
    producerCalls: number,
    databaseStatements: number
  ) => {
    budget.charge({ kind: 'producerCalls', amount: producerCalls })
    budget.charge({ kind: 'databaseStatements', amount: databaseStatements })
  }
  const index = {
    beginRelist: vi.fn(async ({ budget }: { budget: AccessExecutionBudget }) => {
      observed.limits = budget.limits
      charge(budget, 2, 4)
      return 2
    }),
    stageRelistPage: vi.fn(async ({ budget }: { budget: AccessExecutionBudget }) =>
      charge(budget, 2, 4)
    ),
    promoteRelist: vi.fn(async ({ budget }: { budget: AccessExecutionBudget }) => {
      observed.beforePromotion = {
        producerCalls: budget.remaining('producerCalls'),
        databaseStatements: budget.remaining('databaseStatements'),
      }
      charge(budget, 9, 11)
      observed.afterPromotion = {
        producerCalls: budget.remaining('producerCalls'),
        databaseStatements: budget.remaining('databaseStatements'),
      }
    }),
    applyWatchProjection: vi.fn().mockResolvedValue(3),
    recordWatchBookmark: vi.fn().mockResolvedValue(undefined),
    markSourceState: vi.fn().mockResolvedValue(undefined),
  }
  return { index, observed }
}

async function temporaryHostGateway(objectCount: number) {
  const api = new TemporaryKubernetesApi()
  await api.start()
  const previousKubeconfig = process.env.KUBECONFIG
  process.env.KUBECONFIG = api.kubeconfig()
  const gateway = new K8sGateway()
  for (let index = 0; index < objectCount; index += 1) {
    api.put('hosts', 'mcp-host', hostObject(`host-${index}`, '10'))
  }
  return {
    api,
    gateway,
    async close() {
      if (previousKubeconfig === undefined) delete process.env.KUBECONFIG
      else process.env.KUBECONFIG = previousKubeconfig
      await api.close()
    },
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

  it.each([
    [700, 7],
    [701, 8],
    [1_000, 10],
  ])(
    'reconstructs %i objects across %i pages before one atomic promotion',
    async (count, pages) => {
      const { index, observed } = meteredIndex()
      const producer = await temporaryHostGateway(count)
      try {
        const indexer = new OperationalAccessIndexer(
          producer.gateway,
          index as unknown as OperationalAccessIndex,
          { environmentId: 'test:cluster', behaviorFingerprintKey: 'test-key' }
        )

        await expect(
          indexer.reconcileSource({ family: 'host', plural: 'hosts', namespace: 'mcp-host' })
        ).resolves.toBe('10')

        const pageRequests = producer.api.requests.filter(
          value => value.plural === 'hosts' && !value.watch
        )
        expect(pageRequests).toHaveLength(pages)
        expect(pageRequests.every(value => value.limit === '100')).toBe(true)
        expect(index.stageRelistPage).toHaveBeenCalledTimes(pages)
        expect(index.stageRelistPage.mock.calls.map(([input]) => input.stagingGeneration)).toEqual(
          Array(pages).fill(2)
        )
        expect(index.promoteRelist).toHaveBeenCalledOnce()
        expect(index.promoteRelist).toHaveBeenCalledWith(
          expect.objectContaining({ stagingGeneration: 2, resourceVersion: '10' })
        )
        if (count === 1_000) {
          expect(observed.limits).toMatchObject({ producerCalls: 41, databaseStatements: 55 })
          expect(observed.beforePromotion).toEqual({ producerCalls: 9, databaseStatements: 11 })
          expect(observed.afterPromotion).toEqual({ producerCalls: 0, databaseStatements: 0 })
        }
      } finally {
        await producer.close()
      }
    }
  )

  it('does not promote an over-capacity or cancelled source reconstruction', async () => {
    const overCapacity = meteredIndex()
    const overCapacityProducer = await temporaryHostGateway(1_001)
    try {
      const overCapacityIndexer = new OperationalAccessIndexer(
        overCapacityProducer.gateway,
        overCapacity.index as unknown as OperationalAccessIndex,
        { environmentId: 'test:cluster', behaviorFingerprintKey: 'test-key' }
      )
      await expect(
        overCapacityIndexer.reconcileSource({
          family: 'host',
          plural: 'hosts',
          namespace: 'mcp-host',
        })
      ).rejects.toMatchObject({ name: 'AccessBudgetExceededError', limit: 'objects' })
      expect(overCapacity.index.promoteRelist).not.toHaveBeenCalled()
    } finally {
      await overCapacityProducer.close()
    }

    const controller = new AbortController()
    const cancelled = meteredIndex()
    const cancelledProducer = await temporaryHostGateway(100)
    try {
      const cancelledGateway = {
        listResourcePage: async (...args: Parameters<K8sGateway['listResourcePage']>) => {
          const page = await cancelledProducer.gateway.listResourcePage(...args)
          controller.abort()
          return page
        },
        watchResource: cancelledProducer.gateway.watchResource.bind(cancelledProducer.gateway),
        getResourceExact: cancelledProducer.gateway.getResourceExact.bind(
          cancelledProducer.gateway
        ),
      }
      const cancelledIndexer = new OperationalAccessIndexer(
        cancelledGateway,
        cancelled.index as unknown as OperationalAccessIndex,
        { environmentId: 'test:cluster', behaviorFingerprintKey: 'test-key' }
      )

      await expect(
        cancelledIndexer.reconcileSource(
          { family: 'host', plural: 'hosts', namespace: 'mcp-host' },
          controller.signal
        )
      ).rejects.toMatchObject({ name: 'AccessExecutionCancelledError' })
      expect(cancelled.index.stageRelistPage).not.toHaveBeenCalled()
      expect(cancelled.index.promoteRelist).not.toHaveBeenCalled()
    } finally {
      await cancelledProducer.close()
    }
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
