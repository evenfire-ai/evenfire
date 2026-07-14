import { describe, expect, it, vi } from 'vitest'
import { K8sNotFoundError, ResourceService } from '../src/services/resourceService.js'

function makeNotFoundError(): Error & { statusCode: number } {
  const err = new Error('not found') as Error & { statusCode: number }
  err.statusCode = 404
  return err
}

function makeConflictError(): Error & { statusCode: number } {
  const err = new Error('object has been modified') as Error & { statusCode: number }
  err.statusCode = 409
  return err
}

describe('ResourceService.getResource', () => {
  it('does not fall back cluster-wide when an explicit namespace probe misses', async () => {
    const customApi = {
      getNamespacedCustomObject: vi.fn(async ({ namespace }: { namespace: string }) => {
        if (namespace === 'mcp-server') throw makeNotFoundError()
        return { metadata: { name: 'sandbox-only', namespace } }
      }),
      listNamespacedCustomObject: vi.fn(async ({ namespace }: { namespace: string }) => {
        if (namespace === 'sandbox-recipes') {
          return { items: [{ metadata: { name: 'sandbox-only', namespace } }] }
        }
        return { items: [] }
      }),
    }

    const service = new ResourceService(customApi as never, 'control-plane', {
      workflowrecipes: ['mcp-server', 'sandbox-recipes'],
    })

    await expect(
      service.getResource('workflowrecipes', 'sandbox-only', 'mcp-server')
    ).rejects.toBeInstanceOf(K8sNotFoundError)
    expect(customApi.listNamespacedCustomObject).not.toHaveBeenCalled()
  })

  it('still falls back cluster-wide for implicit primary-namespace lookups', async () => {
    const customApi = {
      getNamespacedCustomObject: vi.fn(async () => {
        throw makeNotFoundError()
      }),
      listNamespacedCustomObject: vi.fn(async ({ namespace }: { namespace: string }) => {
        if (namespace === 'sandbox-recipes') {
          return { items: [{ metadata: { name: 'sandbox-only', namespace } }] }
        }
        return { items: [] }
      }),
    }

    const service = new ResourceService(customApi as never, 'control-plane', {
      workflowrecipes: ['mcp-server', 'sandbox-recipes'],
    })

    const found = (await service.getResource('workflowrecipes', 'sandbox-only')) as {
      metadata?: { namespace?: string }
    }
    expect(found.metadata?.namespace).toBe('sandbox-recipes')
    expect(customApi.listNamespacedCustomObject).toHaveBeenCalled()
  })

  it('propagates non-404 errors for explicit namespace probes', async () => {
    const customApi = {
      getNamespacedCustomObject: vi.fn(async () => {
        const err = new Error('forbidden') as Error & { statusCode: number }
        err.statusCode = 403
        throw err
      }),
      listNamespacedCustomObject: vi.fn(),
    }

    const service = new ResourceService(customApi as never, 'control-plane', {
      workflowrecipes: ['mcp-server', 'sandbox-recipes'],
    })

    await expect(
      service.getResource('workflowrecipes', 'sandbox-only', 'mcp-server')
    ).rejects.toMatchObject({ statusCode: 403 })
    expect(customApi.listNamespacedCustomObject).not.toHaveBeenCalled()
  })
})

describe('ResourceService.updateResource', () => {
  it('refetches and retries once when Kubernetes reports a resourceVersion conflict', async () => {
    const customApi = {
      getNamespacedCustomObject: vi
        .fn()
        .mockResolvedValueOnce({
          metadata: { name: 'mcp-a', namespace: 'mcp-server', resourceVersion: '10' },
          spec: { enabled: true },
        })
        .mockResolvedValueOnce({
          metadata: { name: 'mcp-a', namespace: 'mcp-server', resourceVersion: '11' },
          spec: { enabled: true },
        }),
      replaceNamespacedCustomObject: vi
        .fn()
        .mockRejectedValueOnce(makeConflictError())
        .mockResolvedValueOnce({
          metadata: { name: 'mcp-a', namespace: 'mcp-server', resourceVersion: '12' },
          spec: { enabled: true, egressBindings: [{ egressClass: 'public-web' }] },
        }),
      listNamespacedCustomObject: vi.fn(),
    }

    const service = new ResourceService(customApi as never, 'control-plane', {
      mcpservers: 'mcp-server',
    })

    const updated = (await service.updateResource(
      'mcpservers',
      'mcp-a',
      { spec: { enabled: true, egressBindings: [{ egressClass: 'public-web' }] } },
      'mcp-server'
    )) as { metadata?: { resourceVersion?: string } }

    expect(updated.metadata?.resourceVersion).toBe('12')
    expect(customApi.getNamespacedCustomObject).toHaveBeenCalledTimes(2)
    expect(customApi.replaceNamespacedCustomObject).toHaveBeenCalledTimes(2)
    const firstReplace = customApi.replaceNamespacedCustomObject.mock.calls[0][0]
    const secondReplace = customApi.replaceNamespacedCustomObject.mock.calls[1][0]
    expect(firstReplace.body.metadata.resourceVersion).toBe('10')
    expect(secondReplace.body.metadata.resourceVersion).toBe('11')
  })
})

describe('ResourceService.mutateResource', () => {
  it('recomputes the replacement body from the refetched resource after a conflict', async () => {
    const customApi = {
      getNamespacedCustomObject: vi
        .fn()
        .mockResolvedValueOnce({
          metadata: { name: 'cc-a', namespace: 'channels', resourceVersion: '10' },
          spec: { telegram: [{ channelId: 'seed-chat', chatType: 'private' }] },
        })
        .mockResolvedValueOnce({
          metadata: { name: 'cc-a', namespace: 'channels', resourceVersion: '11' },
          spec: {
            telegram: [
              { channelId: 'seed-chat', chatType: 'private' },
              { channelId: 'concurrent-group', chatType: 'group' },
            ],
          },
        }),
      replaceNamespacedCustomObject: vi
        .fn()
        .mockRejectedValueOnce(makeConflictError())
        .mockResolvedValueOnce({
          metadata: { name: 'cc-a', namespace: 'channels', resourceVersion: '12' },
        }),
      listNamespacedCustomObject: vi.fn(),
    }
    const service = new ResourceService(customApi as never, 'control-plane', {
      communicationchannels: 'channels',
    })

    await service.mutateResource(
      'communicationchannels',
      'cc-a',
      current => {
        const telegram = Array.isArray(current.spec?.telegram) ? current.spec.telegram : []
        return {
          spec: {
            ...current.spec,
            telegram: [...telegram, { channelId: '777', chatType: 'private' }],
          },
        }
      },
      'channels'
    )

    const secondReplace = customApi.replaceNamespacedCustomObject.mock.calls[1][0]
    expect(secondReplace.body.metadata.resourceVersion).toBe('11')
    expect(secondReplace.body.spec.telegram).toEqual([
      { channelId: 'seed-chat', chatType: 'private' },
      { channelId: 'concurrent-group', chatType: 'group' },
      { channelId: '777', chatType: 'private' },
    ])
  })
})
