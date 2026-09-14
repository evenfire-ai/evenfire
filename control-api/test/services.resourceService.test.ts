import { describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import {
  K8sConflictError,
  K8sNotFoundError,
  ResourceService,
  setAdministrativeOperationService,
} from '../src/services/resourceService.js'
import { runWithAdministrativeRequestContext } from '../src/services/tracing/adminOperationContext.js'

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

describe('ResourceService bounded operational reads', () => {
  it('passes a bounded keyset page request and preserves continuation metadata', async () => {
    const listNamespacedCustomObject = vi.fn().mockResolvedValue({
      items: [{ metadata: { name: 'host-a' } }],
      metadata: { continue: 'next-page', resourceVersion: '42' },
    })
    const service = new ResourceService({ listNamespacedCustomObject } as never, 'control-plane', {
      hosts: 'mcp-host',
    })
    const controller = new AbortController()

    await expect(
      service.listResourcePage('hosts', 'mcp-host', {
        limit: 100,
        continueToken: 'prior-page',
        timeoutSeconds: 5,
        signal: controller.signal,
      })
    ).resolves.toEqual({
      items: [{ metadata: { name: 'host-a' } }],
      continueToken: 'next-page',
      resourceVersion: '42',
    })
    expect(listNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'mcp-host',
        plural: 'hosts',
        limit: 100,
        _continue: 'prior-page',
        timeoutSeconds: 5,
      }),
      expect.objectContaining({ middlewareMergeStrategy: 'append' })
    )
  })

  it('rejects invalid limits before calling Kubernetes', async () => {
    const listNamespacedCustomObject = vi.fn()
    const service = new ResourceService({ listNamespacedCustomObject } as never, 'control-plane', {
      hosts: 'mcp-host',
    })

    await expect(
      service.listResourcePage('hosts', 'mcp-host', {
        limit: 101,
        timeoutSeconds: 5,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow('between 1 and 100')
    expect(listNamespacedCustomObject).not.toHaveBeenCalled()
  })

  it('propagates cancellation into the Kubernetes transport and waits for it to stop', async () => {
    let transportSignal: AbortSignal | undefined
    let transportStopped = false
    const listNamespacedCustomObject = vi.fn(
      async (_request: unknown, options: { middleware: k8s.ObservableMiddleware[] }) => {
        const context = {
          setSignal: (signal: AbortSignal) => {
            transportSignal = signal
          },
        }
        await options.middleware[0]!.pre(context as never).toPromise()
        return new Promise((_resolve, reject) => {
          const stop = () => {
            transportStopped = true
            reject(new Error('transport aborted'))
          }
          if (transportSignal!.aborted) stop()
          else transportSignal!.addEventListener('abort', stop, { once: true })
        })
      }
    )
    const service = new ResourceService({ listNamespacedCustomObject } as never, 'control-plane', {
      hosts: 'mcp-host',
    })
    const controller = new AbortController()
    const pending = service.listResourcePage('hosts', 'mcp-host', {
      limit: 1,
      timeoutSeconds: 5,
      signal: controller.signal,
    })

    controller.abort('test-cancel')
    await expect(pending).rejects.toThrow('transport aborted')
    expect(transportSignal).toBe(controller.signal)
    expect(transportStopped).toBe(true)
  })

  it('uses exact namespace/name lookup and maps a Kubernetes 404', async () => {
    const getNamespacedCustomObject = vi.fn().mockRejectedValue(makeNotFoundError())
    const service = new ResourceService({ getNamespacedCustomObject } as never, 'control-plane', {
      hosts: 'mcp-host',
    })

    await expect(
      service.getResourceExact('hosts', 'host-a', 'mcp-host', {
        timeoutSeconds: 2,
        signal: new AbortController().signal,
      })
    ).rejects.toBeInstanceOf(K8sNotFoundError)
    expect(getNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'mcp-host', plural: 'hosts', name: 'host-a' }),
      expect.objectContaining({ middlewareMergeStrategy: 'append' })
    )
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

describe('ResourceService.updateResource — AP-6 reader-version precondition', () => {
  function makeCustomApi(
    overrides: {
      currentAnnotations?: Record<string, string>
      replace?: ReturnType<typeof vi.fn>
    } = {}
  ) {
    return {
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: {
          name: 'host-a',
          namespace: 'mcp-host',
          resourceVersion: '11',
          ...(overrides.currentAnnotations && { annotations: overrides.currentAnnotations }),
        },
        spec: { contextRef: 'live' },
      }),
      replaceNamespacedCustomObject:
        overrides.replace ??
        vi.fn().mockResolvedValue({
          metadata: { name: 'host-a', namespace: 'mcp-host', resourceVersion: '12' },
        }),
      listNamespacedCustomObject: vi.fn(),
    }
  }

  it('uses the caller-provided resourceVersion as the replace precondition (not the server current one)', async () => {
    const customApi = makeCustomApi()
    const service = new ResourceService(customApi as never, 'control-plane', { hosts: 'mcp-host' })

    await service.updateResource(
      'hosts',
      'host-a',
      { metadata: { resourceVersion: '10' }, spec: { contextRef: 'edited' } },
      'mcp-host'
    )

    expect(customApi.replaceNamespacedCustomObject).toHaveBeenCalledTimes(1)
    const replaceArgs = customApi.replaceNamespacedCustomObject.mock.calls[0][0]
    // The precondition is the READER's version ('10'), not the fresher
    // server version ('11') harvested by the internal read.
    expect(replaceArgs.body.metadata.resourceVersion).toBe('10')
  })

  it('surfaces a 409 as K8sConflictError WITHOUT retrying when the reader version is stale', async () => {
    const replace = vi.fn().mockRejectedValue(makeConflictError())
    const customApi = makeCustomApi({ replace })
    const service = new ResourceService(customApi as never, 'control-plane', { hosts: 'mcp-host' })

    await expect(
      service.updateResource(
        'hosts',
        'host-a',
        { metadata: { resourceVersion: '10' }, spec: { contextRef: 'stale-edit' } },
        'mcp-host'
      )
    ).rejects.toBeInstanceOf(K8sConflictError)

    // No retry loop: exactly one read + one replace attempt. Retrying would
    // re-apply the same stale payload over the concurrent write.
    expect(customApi.getNamespacedCustomObject).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledTimes(1)
  })

  it('AP-6 + concurrent wake bump: a stale reader version is rejected 409 while the newer clerum.io/wake-requested on the server is left untouched (no retry re-applies the stale spec)', async () => {
    const WAKE = 'clerum.io/wake-requested'
    // The server object moved on AFTER the admin read it: resourceVersion is now
    // '12' (reader saw '10') AND a concurrent hostWakeService projection bumped
    // clerum.io/wake-requested to '8'. mergeAnnotationsForReplace reads CURRENT
    // annotations at commit, so it WOULD carry the bump forward — but the stale
    // reader-version precondition makes K8s reject the whole replace first.
    const getNamespacedCustomObject = vi.fn().mockResolvedValue({
      metadata: {
        name: 'host-a',
        namespace: 'mcp-host',
        resourceVersion: '12',
        annotations: { [WAKE]: '8', team: 'blue' },
      },
      spec: { contextRef: 'live-with-wake-8' },
    })
    // K8s enforces optimistic concurrency: the replace carrying the reader's
    // stale precondition ('10') is rejected 409 and never mutates the object.
    const replaceNamespacedCustomObject = vi.fn().mockRejectedValue(makeConflictError())
    const customApi = {
      getNamespacedCustomObject,
      replaceNamespacedCustomObject,
      listNamespacedCustomObject: vi.fn(),
    }
    const service = new ResourceService(customApi as never, 'control-plane', { hosts: 'mcp-host' })

    // Property 1: the 409 is surfaced as K8sConflictError (not retried away).
    await expect(
      service.updateResource(
        'hosts',
        'host-a',
        {
          metadata: { resourceVersion: '10', annotations: { notes: 'stale-admin-edit' } },
          spec: { contextRef: 'stale-admin-spec' },
        },
        'mcp-host'
      )
    ).rejects.toBeInstanceOf(K8sConflictError)

    // No retry: exactly one read + one replace attempt. Re-reading only to
    // re-apply the same stale payload is the lost-update bug AP-6 prevents.
    expect(getNamespacedCustomObject).toHaveBeenCalledTimes(1)
    expect(replaceNamespacedCustomObject).toHaveBeenCalledTimes(1)

    // Property 2: the wake annotation on the server is UNTOUCHED. The single
    // replace attempt that fired carried the bumped clerum.io/wake-requested='8'
    // (mergeAnnotationsForReplace re-added it from the fresh read), so even the
    // rejected write would not have erased it — and since the write was rejected,
    // the server object keeps its concurrently-bumped wake generation intact.
    const attemptedAnnotations = replaceNamespacedCustomObject.mock.calls[0][0].body.metadata
      .annotations as Record<string, string>
    expect(attemptedAnnotations[WAKE]).toBe('8')
    // The stale caller's own key is present per replace semantics, but it never
    // reached the server because the precondition check rejected the write.
    expect(attemptedAnnotations.notes).toBe('stale-admin-edit')
  })

  it('pins the legacy path when no reader version is provided: server-version precondition + up to 3 attempts', async () => {
    const customApi = {
      getNamespacedCustomObject: vi
        .fn()
        .mockResolvedValueOnce({ metadata: { resourceVersion: '1' }, spec: {} })
        .mockResolvedValueOnce({ metadata: { resourceVersion: '2' }, spec: {} })
        .mockResolvedValueOnce({ metadata: { resourceVersion: '3' }, spec: {} }),
      replaceNamespacedCustomObject: vi
        .fn()
        .mockRejectedValueOnce(makeConflictError())
        .mockRejectedValueOnce(makeConflictError())
        .mockResolvedValueOnce({ metadata: { resourceVersion: '4' } }),
      listNamespacedCustomObject: vi.fn(),
    }
    const service = new ResourceService(customApi as never, 'control-plane', { hosts: 'mcp-host' })

    await service.updateResource('hosts', 'host-a', { spec: { contextRef: 'x' } }, 'mcp-host')

    // Each retry re-reads and uses the FRESH server version — the legacy
    // last-write-wins compat contract for RV-absent callers.
    expect(customApi.replaceNamespacedCustomObject).toHaveBeenCalledTimes(3)
    const attempts = customApi.replaceNamespacedCustomObject.mock.calls.map(
      call => call[0].body.metadata.resourceVersion
    )
    expect(attempts).toEqual(['1', '2', '3'])
  })
})

describe('ResourceService annotation merge — platform keys survive admin writes', () => {
  const WAKE = 'clerum.io/wake-requested'

  function makeCustomApi(currentAnnotations: Record<string, string>) {
    return {
      getNamespacedCustomObject: vi.fn().mockResolvedValue({
        metadata: {
          name: 'host-a',
          namespace: 'mcp-host',
          resourceVersion: '5',
          annotations: currentAnnotations,
        },
        spec: { contextRef: 'live' },
      }),
      replaceNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      listNamespacedCustomObject: vi.fn(),
    }
  }

  function replacedAnnotations(customApi: {
    replaceNamespacedCustomObject: ReturnType<typeof vi.fn>
  }): Record<string, string> | undefined {
    return customApi.replaceNamespacedCustomObject.mock.calls[0][0].body.metadata.annotations
  }

  it('updateResource: an unrelated annotations map does NOT erase clerum.io/wake-requested', async () => {
    const customApi = makeCustomApi({ [WAKE]: '7', team: 'blue' })
    const service = new ResourceService(customApi as never, 'control-plane', { hosts: 'mcp-host' })

    await service.updateResource(
      'hosts',
      'host-a',
      { metadata: { annotations: { notes: 'hello' } }, spec: {} },
      'mcp-host'
    )

    // The platform projection survives; caller-owned keys keep replace
    // semantics (omitting `team` clears it).
    expect(replacedAnnotations(customApi)).toEqual({ notes: 'hello', [WAKE]: '7' })
  })

  it('updateResource: explicitly setting the exact platform key lets the caller win', async () => {
    const customApi = makeCustomApi({ [WAKE]: '7' })
    const service = new ResourceService(customApi as never, 'control-plane', { hosts: 'mcp-host' })

    await service.updateResource(
      'hosts',
      'host-a',
      { metadata: { annotations: { [WAKE]: '9' } }, spec: {} },
      'mcp-host'
    )

    expect(replacedAnnotations(customApi)).toEqual({ [WAKE]: '9' })
  })

  it('updateResource: explicitly clearing an own key still works (map replaced per caller intent)', async () => {
    const customApi = makeCustomApi({ [WAKE]: '7', team: 'blue', notes: 'old' })
    const service = new ResourceService(customApi as never, 'control-plane', { hosts: 'mcp-host' })

    await service.updateResource(
      'hosts',
      'host-a',
      { metadata: { annotations: { notes: 'new' } }, spec: {} },
      'mcp-host'
    )

    expect(replacedAnnotations(customApi)).toEqual({ notes: 'new', [WAKE]: '7' })
  })

  it('updateResource: a body without annotations preserves the whole current map (legacy)', async () => {
    const customApi = makeCustomApi({ [WAKE]: '7', team: 'blue' })
    const service = new ResourceService(customApi as never, 'control-plane', { hosts: 'mcp-host' })

    await service.updateResource('hosts', 'host-a', { spec: {} }, 'mcp-host')

    expect(replacedAnnotations(customApi)).toEqual({ [WAKE]: '7', team: 'blue' })
  })

  it('mutateResource: a mutation carrying an unrelated annotations map does NOT erase platform keys', async () => {
    const customApi = makeCustomApi({ [WAKE]: '7' })
    const service = new ResourceService(customApi as never, 'control-plane', { hosts: 'mcp-host' })

    await service.mutateResource(
      'hosts',
      'host-a',
      () => ({ metadata: { annotations: { notes: 'x' } }, spec: {} }),
      'mcp-host'
    )

    expect(replacedAnnotations(customApi)).toEqual({ notes: 'x', [WAKE]: '7' })
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

describe('ResourceService.patchAnnotationMonotonic', () => {
  const NS = 'mcp-host'
  const KEY = 'clerum.io/wake-requested'

  function makeService(overrides: {
    get: (args: { name: string }) => unknown
    patch?: (...args: unknown[]) => unknown
  }) {
    const patch = overrides.patch ?? vi.fn(async () => ({ metadata: { resourceVersion: '2' } }))
    const customApi = {
      getNamespacedCustomObject: vi.fn(async ({ name }: { name: string }) =>
        overrides.get({ name })
      ),
      patchNamespacedCustomObject: patch,
      listNamespacedCustomObject: vi.fn(async () => ({ items: [] })),
    }
    const service = new ResourceService(customApi as never, NS, { hosts: NS })
    return { service, customApi, patch }
  }

  it('does NOT regress the projection when the incoming generation is lower than the projected one', async () => {
    // The Host already projects generation 6. A slower generation-5 wake must
    // NOT overwrite it (that is exactly the M1 ordering regression). The read
    // happens, but no patch is issued.
    const { service, customApi } = makeService({
      get: () => ({
        metadata: { resourceVersion: '10', annotations: { [KEY]: '6' } },
      }),
    })

    await service.patchAnnotationMonotonic('hosts', 'chatllm', KEY, 5, NS)

    expect(customApi.getNamespacedCustomObject).toHaveBeenCalledTimes(1)
    expect(customApi.patchNamespacedCustomObject).not.toHaveBeenCalled()
  })

  it('does NOT patch when the incoming generation equals the projected one', async () => {
    const { service, customApi } = makeService({
      get: () => ({
        metadata: { resourceVersion: '10', annotations: { [KEY]: '6' } },
      }),
    })

    await service.patchAnnotationMonotonic('hosts', 'chatllm', KEY, 6, NS)

    expect(customApi.patchNamespacedCustomObject).not.toHaveBeenCalled()
  })

  it('projects a strictly higher generation with a resourceVersion precondition', async () => {
    const { service, customApi } = makeService({
      get: () => ({
        metadata: { resourceVersion: '10', annotations: { [KEY]: '6' } },
      }),
    })

    await service.patchAnnotationMonotonic('hosts', 'chatllm', KEY, 7, NS)

    expect(customApi.patchNamespacedCustomObject).toHaveBeenCalledTimes(1)
    const patchArgs = customApi.patchNamespacedCustomObject.mock.calls[0][0] as {
      body: { metadata: { resourceVersion?: string; annotations: Record<string, string> } }
    }
    expect(patchArgs.body.metadata.resourceVersion).toBe('10')
    expect(patchArgs.body.metadata.annotations[KEY]).toBe('7')
  })

  it('projects when no annotation exists yet (null projected value)', async () => {
    const { service, customApi } = makeService({
      get: () => ({ metadata: { resourceVersion: '3' } }),
    })

    await service.patchAnnotationMonotonic('hosts', 'chatllm', KEY, 1, NS)

    expect(customApi.patchNamespacedCustomObject).toHaveBeenCalledTimes(1)
  })

  it('retries on 409 by re-reading, and then respects max-semantics (no regression on the winning value)', async () => {
    // First read shows generation 6 (rv=10); our patch conflicts (409) because
    // a concurrent higher-generation writer landed generation 8 (rv=11). On
    // re-read we observe 8 >= our 7, so we STOP without regressing.
    let reads = 0
    const patch = vi.fn(async () => {
      const err = new Error('conflict') as Error & { statusCode: number }
      err.statusCode = 409
      throw err
    })
    const { service, customApi } = makeService({
      get: () => {
        reads += 1
        return reads === 1
          ? { metadata: { resourceVersion: '10', annotations: { [KEY]: '6' } } }
          : { metadata: { resourceVersion: '11', annotations: { [KEY]: '8' } } }
      },
      patch,
    })

    await service.patchAnnotationMonotonic('hosts', 'chatllm', KEY, 7, NS)

    expect(customApi.getNamespacedCustomObject).toHaveBeenCalledTimes(2)
    // One patch attempt (the 409), then re-read shows a higher value so no
    // further patch is attempted — the projection is never regressed.
    expect(patch).toHaveBeenCalledTimes(1)
  })

  it('treats a non-numeric existing annotation as no-known-value and self-heals to the DB generation', async () => {
    const { service, customApi } = makeService({
      get: () => ({
        metadata: { resourceVersion: '4', annotations: { [KEY]: 'garbage' } },
      }),
    })

    await service.patchAnnotationMonotonic('hosts', 'chatllm', KEY, 2, NS)

    expect(customApi.patchNamespacedCustomObject).toHaveBeenCalledTimes(1)
    const patchArgs = customApi.patchNamespacedCustomObject.mock.calls[0][0] as {
      body: { metadata: { annotations: Record<string, string> } }
    }
    expect(patchArgs.body.metadata.annotations[KEY]).toBe('2')
  })

  it('fails loud when the resource has no resourceVersion (cannot enforce the precondition)', async () => {
    const { service } = makeService({
      get: () => ({ metadata: { annotations: {} } }),
    })

    await expect(service.patchAnnotationMonotonic('hosts', 'chatllm', KEY, 1, NS)).rejects.toThrow(
      /resourceVersion/
    )
  })

  it('maps a 404 on patch to K8sNotFoundError', async () => {
    const patch = vi.fn(async () => {
      const err = new Error('not found') as Error & { statusCode: number }
      err.statusCode = 404
      throw err
    })
    const { service } = makeService({
      get: () => ({ metadata: { resourceVersion: '1' } }),
      patch,
    })

    await expect(
      service.patchAnnotationMonotonic('hosts', 'chatllm', KEY, 1, NS)
    ).rejects.toBeInstanceOf(K8sNotFoundError)
  })

  it('rejects a non-integer generation loudly', async () => {
    const { service } = makeService({ get: () => ({ metadata: { resourceVersion: '1' } }) })

    await expect(
      service.patchAnnotationMonotonic('hosts', 'chatllm', KEY, 1.5, NS)
    ).rejects.toThrow(/non-negative integer/)
  })
})

describe('ResourceService Host administrative intent', () => {
  it('strips caller authority and projects the control-api operation id before create', async () => {
    const persistHostIntent = vi.fn().mockResolvedValue({
      operationId: '11111111-1111-4111-8111-111111111111',
      action: 'create',
      namespace: 'mcp-host',
      targetRef: 'mcp-host/host-a',
      operatorSub: 'admin-1',
      requestId: 'request-1',
    })
    const persistHostOutcome = vi.fn()
    setAdministrativeOperationService({ persistHostIntent, persistHostOutcome } as never)
    const customApi = { createNamespacedCustomObject: vi.fn().mockResolvedValue({}) }
    const service = new ResourceService(customApi as never, 'control-plane', { hosts: 'mcp-host' })

    try {
      await runWithAdministrativeRequestContext(
        { operatorSub: 'admin-1', requestId: 'request-1' },
        () =>
          service.createResource(
            'hosts',
            {
              metadata: {
                name: 'host-a',
                annotations: {
                  'clerum.io/administrative-intent-id': 'caller-value',
                  'clerum.io/administrative-intent-generation': '999',
                  keep: 'yes',
                },
              },
              spec: {},
            },
            'mcp-host'
          )
      )
    } finally {
      setAdministrativeOperationService(null)
    }

    expect(persistHostIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorSub: 'admin-1',
        requestId: 'request-1',
        name: 'host-a',
      })
    )
    expect(customApi.createNamespacedCustomObject).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          metadata: expect.objectContaining({
            annotations: {
              keep: 'yes',
              'clerum.io/administrative-intent-id': '11111111-1111-4111-8111-111111111111',
              'clerum.io/administrative-intent-generation': '1',
            },
          }),
        }),
      })
    )
  })

  it('does not create an operator-bound intent outside an authenticated admin context', async () => {
    const persistHostIntent = vi.fn()
    setAdministrativeOperationService({ persistHostIntent } as never)
    const customApi = { createNamespacedCustomObject: vi.fn().mockResolvedValue({}) }
    try {
      await new ResourceService(customApi as never, 'control-plane', {
        hosts: 'mcp-host',
      }).createResource('hosts', { metadata: { name: 'host-a' }, spec: {} }, 'mcp-host')
    } finally {
      setAdministrativeOperationService(null)
    }
    expect(persistHostIntent).not.toHaveBeenCalled()
  })
})
