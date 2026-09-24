import { describe, expect, it, vi } from 'vitest'
import { governedTraceAdministrativeIntentReconcileFailedTotal } from '../src/observability/metrics.js'
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

/**
 * #329 — the annotation must name the generation the apiserver PERSISTED, not
 * the one control-api predicted before the write. The Host CRD declares a
 * status subresource, so `metadata.generation` advances only on spec changes:
 * a replace whose spec is unchanged leaves the object at N while the
 * prediction writes N+1, and nothing ever retires that annotation, so the Host
 * stops binding outcomes permanently.
 */
describe('ResourceService administrative intent generation reconciliation (#329)', () => {
  const GENERATION = 'clerum.io/administrative-intent-generation'
  const INTENT_ID = 'clerum.io/administrative-intent-id'
  const OPERATION_ID = '11111111-1111-4111-8111-111111111111'
  const OTHER_OPERATION_ID = '33333333-3333-4333-8333-333333333333'

  function withIntent() {
    setAdministrativeOperationService({
      persistHostIntent: vi.fn().mockResolvedValue({
        operationId: OPERATION_ID,
        action: 'update',
        namespace: 'mcp-host',
        targetRef: 'mcp-host/host-a',
        operatorSub: 'admin-1',
        requestId: 'request-1',
      }),
      persistHostOutcome: vi.fn(),
    } as never)
  }

  /**
   * What the apiserver answers a replace with: the object AS PERSISTED, which
   * therefore echoes back the annotation pair the replace just wrote.
   *
   * Carrying the annotations is not decoration. The correction checks ownership
   * on this object before patching, so a fixture that omitted them would drive
   * a branch the real apiserver can never produce, and every assertion built on
   * it would be measuring the fixture.
   */
  function writtenObject(
    generation: number | undefined,
    resourceVersion: string,
    operationId: string | null = OPERATION_ID
  ) {
    const annotations: Record<string, string> = { [GENERATION]: '5' }
    if (operationId) annotations[INTENT_ID] = operationId
    return {
      metadata: {
        name: 'host-a',
        namespace: 'mcp-host',
        resourceVersion,
        ...(generation === undefined ? {} : { generation }),
        annotations,
      },
      spec: { contextRef: 'next' },
    }
  }

  /** The object as it stands before the write: live generation 4, no intent. */
  function liveObject() {
    return {
      metadata: {
        name: 'host-a',
        namespace: 'mcp-host',
        resourceVersion: '5',
        generation: 4,
        annotations: {},
      },
      spec: { contextRef: 'live' },
    }
  }

  function api(replaced: Record<string, unknown>, patch = vi.fn().mockResolvedValue({})) {
    return {
      getNamespacedCustomObject: vi.fn().mockResolvedValue(liveObject()),
      replaceNamespacedCustomObject: vi.fn().mockResolvedValue(replaced),
      patchNamespacedCustomObject: patch,
      createNamespacedCustomObject: vi.fn().mockResolvedValue(replaced),
      listNamespacedCustomObject: vi.fn(),
    }
  }

  function service(customApi: ReturnType<typeof api>) {
    return new ResourceService(customApi as never, 'control-plane', { hosts: 'mcp-host' })
  }

  async function asOperator<T>(run: () => Promise<T>): Promise<T> {
    withIntent()
    try {
      return await runWithAdministrativeRequestContext(
        { operatorSub: 'admin-1', requestId: 'request-1' },
        run
      )
    } finally {
      setAdministrativeOperationService(null)
    }
  }

  async function update(customApi: ReturnType<typeof api>) {
    return asOperator(() =>
      service(customApi).updateResource(
        'hosts',
        'host-a',
        { spec: { contextRef: 'next' } },
        'mcp-host'
      )
    )
  }

  /**
   * Reads the reconcile-failure counter for one reason. Used as a liveness
   * witness that needs no mock: only the branch under test increments its own
   * reason, so a delta of 1 proves that exact branch ran. Counters are
   * process-global and other tests share them, hence the before/after delta
   * rather than an absolute value.
   */
  async function failureCount(reason: string): Promise<number> {
    const { values } = await governedTraceAdministrativeIntentReconcileFailedTotal.get()
    return values
      .filter(value => value.labels.reason === reason)
      .reduce((sum, value) => sum + value.value, 0)
  }

  it('lowers the annotation to the persisted generation when the replace did not bump it', async () => {
    const patch = vi.fn().mockResolvedValue({})
    const customApi = api(writtenObject(4, '6'), patch)

    await update(customApi)

    // Liveness: the replace itself carried the PREDICTED value, so the patch
    // below is a correction of a real mismatch and not a no-op.
    const replaceBody = customApi.replaceNamespacedCustomObject.mock.calls[0]![0].body
    expect(replaceBody.metadata.annotations[GENERATION]).toBe('5')

    expect(patch).toHaveBeenCalledOnce()
    const [patchArgs] = patch.mock.calls[0]!
    expect(patchArgs).toMatchObject({
      namespace: 'mcp-host',
      plural: 'hosts',
      name: 'host-a',
      body: {
        metadata: {
          // The precondition comes from the object the write returned, so a
          // concurrent change between the replace and the patch is refused
          // rather than overwritten.
          resourceVersion: '6',
          annotations: { [GENERATION]: '4' },
        },
      },
    })
    // Annotations only: a patch that carried a spec would bump the generation
    // it is correcting and feed itself.
    expect(Object.keys(patchArgs.body.metadata)).toEqual(['resourceVersion', 'annotations'])
    expect(patchArgs.body).not.toHaveProperty('spec')
  })

  /**
   * A differential, because the equality branch emits nothing observable: no
   * patch, no log, no counter. "The patch did not fire" is therefore satisfied
   * just as well by a reconcile that was never called at all, so the matching
   * case is measured against a mismatching one driven through the SAME service
   * in the same test. The second half is the liveness witness for the first.
   *
   * Deleting the reconcile call entirely takes the second half red, which is
   * exactly the mutation this test previously survived.
   */
  it('patches on a mismatch and not on a match, with the correction armed both times', async () => {
    const matched = vi.fn().mockResolvedValue({})
    await update(api(writtenObject(5, '6'), matched))
    expect(matched).not.toHaveBeenCalled()

    const mismatched = vi.fn().mockResolvedValue({})
    await update(api(writtenObject(4, '6'), mismatched))
    expect(mismatched).toHaveBeenCalledOnce()
    expect(mismatched.mock.calls[0]![0].body.metadata.annotations[GENERATION]).toBe('4')
  })

  /**
   * Ownership, not generation, decides whether the correction is still ours.
   * The two annotation keys are written as a pair, so patching the generation
   * key while another operation owns the id key would fuse that operation's id
   * to our generation — a pair that never existed on any object.
   *
   * Same shape as the test above: the owned case is the witness for the
   * reassigned one, and the reassigned branch emits no counter because it is a
   * correct decision to skip, not a failure to apply.
   */
  it('skips the correction when another operation owns the intent annotation', async () => {
    const ours = vi.fn().mockResolvedValue({})
    await update(api(writtenObject(4, '6', OPERATION_ID), ours))
    expect(ours).toHaveBeenCalledOnce()

    const theirs = vi.fn().mockResolvedValue({})
    await update(api(writtenObject(4, '6', OTHER_OPERATION_ID), theirs))
    expect(theirs).not.toHaveBeenCalled()
  })

  /**
   * An object with no intent id carries no pending obligation, so writing the
   * generation key alone would leave half a pair naming no operation. Distinct
   * from reassignment, and counted under its own reason so the two cannot be
   * confused on a dashboard.
   */
  it('counts an absent intent annotation under its own reason and writes nothing', async () => {
    const patch = vi.fn().mockResolvedValue({})
    const before = await failureCount('intent_absent')

    await update(api(writtenObject(4, '6', null), patch))

    // Witness: the counter this branch alone increments moved by exactly one.
    expect((await failureCount('intent_absent')) - before).toBe(1)
    expect(patch).not.toHaveBeenCalled()
  })

  /**
   * The object moved past the generation this operation produced. Correct it
   * ANYWAY: `persisted` is what this write actually produced, which stays true
   * wherever the object has since got to, and writing it lands
   * `annotated < live` — the terminal refusal the binding resolver exists to
   * make.
   *
   * Leaving the PREDICTION in place is the dangerous option. `predicted` is by
   * construction the next generation the object is most likely to reach, so a
   * concurrent bump can make it match the live generation exactly, and the
   * resolver would then bind another writer's change to this operator's intent
   * — the audit-trail falsification #329 exists to prevent.
   */
  it('corrects to the produced generation even when the object outpaced it', async () => {
    const patch = vi.fn().mockRejectedValueOnce(makeConflictError()).mockResolvedValue({})
    const customApi = api(writtenObject(4, '6'), patch)
    customApi.getNamespacedCustomObject.mockResolvedValueOnce(liveObject()).mockResolvedValue({
      metadata: {
        name: 'host-a',
        namespace: 'mcp-host',
        resourceVersion: '9',
        generation: 6,
        annotations: { [INTENT_ID]: OPERATION_ID, [GENERATION]: '5' },
      },
      spec: { contextRef: 'other' },
    })

    await update(customApi)

    // The retry re-read and patched again — the loop's reason for existing,
    // untested before this. The second patch carries the generation THIS write
    // produced (4), below the live 6, against the re-read's resourceVersion.
    expect(patch).toHaveBeenCalledTimes(2)
    expect(patch.mock.calls[1]![0].body.metadata).toMatchObject({
      resourceVersion: '9',
      annotations: { [GENERATION]: '4' },
    })
  })

  /**
   * Three conflicts exhaust the loop. The write itself succeeded, so the method
   * still returns normally; the reason is reported rather than swallowed.
   */
  it('reports patch exhaustion after the last conflict instead of throwing', async () => {
    const patch = vi.fn().mockRejectedValue(makeConflictError())
    const customApi = api(writtenObject(4, '6'), patch)
    customApi.getNamespacedCustomObject
      .mockResolvedValueOnce(liveObject())
      .mockResolvedValue(writtenObject(4, '9'))
    const before = await failureCount('patch_failed')

    await expect(update(customApi)).resolves.toMatchObject({ metadata: { name: 'host-a' } })

    expect(patch).toHaveBeenCalledTimes(3)
    expect((await failureCount('patch_failed')) - before).toBe(1)
  })

  /**
   * Without a resourceVersion there is no optimistic-concurrency precondition,
   * and an unconditional patch could overwrite a concurrent write. Skipping is
   * the fail-closed answer; the counter says why.
   */
  it('refuses to patch without a resourceVersion precondition', async () => {
    const patch = vi.fn().mockResolvedValue({})
    const written = writtenObject(4, '6')
    delete (written.metadata as { resourceVersion?: string }).resourceVersion
    const before = await failureCount('no_precondition')

    await update(api(written, patch))

    expect((await failureCount('no_precondition')) - before).toBe(1)
    expect(patch).not.toHaveBeenCalled()
  })

  /**
   * A create is the one prediction that cannot be wrong. `PrepareForCreate`
   * sets `metadata.generation = 1` unconditionally, and it runs AFTER mutating
   * admission, so no webhook can move it. The annotation is therefore written
   * as literal `1` and the correction never fires.
   *
   * The witness is the annotation on the create body: without it, "no patch"
   * would also describe a create that never annotated anything.
   */
  it('annotates a create with the literal generation 1 and corrects nothing', async () => {
    const patch = vi.fn().mockResolvedValue({})
    const customApi = api(
      {
        metadata: {
          name: 'host-a',
          namespace: 'mcp-host',
          generation: 1,
          resourceVersion: '1',
          annotations: { [INTENT_ID]: OPERATION_ID, [GENERATION]: '1' },
        },
      },
      patch
    )

    await asOperator(() =>
      service(customApi).createResource(
        'hosts',
        { metadata: { name: 'host-a' }, spec: { contextRef: 'next' } },
        'mcp-host'
      )
    )

    const createBody = customApi.createNamespacedCustomObject.mock.calls[0]![0].body
    expect(createBody.metadata.annotations[GENERATION]).toBe('1')
    expect(patch).not.toHaveBeenCalled()
  })

  /**
   * `mutateResource` is the likeliest producer of drift in the repository: it
   * issues a replace even when the mutation computes an identical spec, and the
   * Host CRD's status subresource means an unchanged spec does not advance the
   * generation. Covered here because a wrong argument at that call site would
   * otherwise ship green — the update path's tests say nothing about it.
   */
  it('corrects a mutateResource replace that did not advance the generation', async () => {
    const patch = vi.fn().mockResolvedValue({})
    const customApi = api(writtenObject(4, '6'), patch)

    await asOperator(() =>
      service(customApi).mutateResource(
        'hosts',
        'host-a',
        () => ({ spec: { contextRef: 'live' } }),
        'mcp-host'
      )
    )

    expect(customApi.replaceNamespacedCustomObject).toHaveBeenCalledOnce()
    expect(patch).toHaveBeenCalledOnce()
    expect(patch.mock.calls[0]![0].body.metadata.annotations[GENERATION]).toBe('4')
  })

  /**
   * A re-read that fails leaves the annotation at the prediction. The write
   * succeeded, so the method still returns normally and reports the reason.
   * `extractK8sStatus` reads the status off the wrapped error, which is why it
   * had to learn `httpStatus`: `getResource` rejects with `K8sNotFoundError`,
   * whose status lives on that field alone.
   */
  it('reports a failed re-read instead of throwing, and reads its status', async () => {
    const patch = vi.fn().mockRejectedValue(makeConflictError())
    const customApi = api(writtenObject(4, '6'), patch)
    customApi.getNamespacedCustomObject
      .mockResolvedValueOnce(liveObject())
      .mockRejectedValue(new K8sNotFoundError('hosts/host-a not found in namespace mcp-host'))
    const before = await failureCount('reread_failed')

    await expect(update(customApi)).resolves.toMatchObject({ metadata: { name: 'host-a' } })

    expect(patch).toHaveBeenCalledOnce()
    expect((await failureCount('reread_failed')) - before).toBe(1)
  })

  it('reports rather than throws when the write response carries no generation', async () => {
    const patch = vi.fn().mockResolvedValue({})
    const customApi = api(writtenObject(undefined, '6'), patch)
    const before = await failureCount('generation_missing')

    // The mutation itself succeeded, so it must still return normally: turning
    // an uncorrectable annotation into a caller-visible error would report a
    // completed write as failed.
    await expect(update(customApi)).resolves.toMatchObject({
      metadata: { name: 'host-a' },
    })
    expect(customApi.replaceNamespacedCustomObject).toHaveBeenCalledOnce()
    // Witness the name promises: the branch REPORTED. Without this the test
    // passes with the whole reconcile call deleted, since "no patch went out"
    // was true before this feature existed.
    expect((await failureCount('generation_missing')) - before).toBe(1)
    expect(patch).not.toHaveBeenCalled()
  })
})
