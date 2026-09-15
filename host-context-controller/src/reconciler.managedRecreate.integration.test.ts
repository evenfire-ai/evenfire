import { describe, expect, it, vi } from 'vitest'
import { McpServerReconciler } from './reconciler'
import type { McpServerCRD } from './types'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}

function notFound(): Error & { code: number } {
  return Object.assign(new Error('not found'), { code: 404 })
}

function server(uid: string, managed: boolean, enabled = true): McpServerCRD {
  return {
    name: 'ownership-recreate',
    namespace: 'mcp-server',
    uid,
    generation: 1,
    spec: {
      contextRef: 'ctx',
      image: 'example.invalid/runtime:v1',
      enabled,
      managed,
      transport: {
        type: 'streamableHttp',
        url: 'http://ownership-recreate.mcp-server.svc.cluster.local:3000/mcp',
      },
    },
  }
}

function hccDeployment() {
  return {
    metadata: {
      name: 'ownership-recreate',
      namespace: 'mcp-server',
      generation: 1,
      labels: {
        'clerum.io/managed-by': 'host-context-controller',
        'clerum.io/mcpserver': 'ownership-recreate',
      },
    },
    spec: { replicas: 1 },
    status: {
      observedGeneration: 1,
      replicas: 1,
      updatedReplicas: 1,
      readyReplicas: 1,
      availableReplicas: 1,
      unavailableReplicas: 0,
    },
  }
}

function fixture() {
  const current = new Map<string, McpServerCRD>()
  const deleteReadEntered = deferred<void>()
  const releaseDeleteRead = deferred<void>()
  let phase: 'seed' | 'delete' | 'replacement' = 'seed'
  let replacementDeploymentReads = 0
  const appsApi = {
    readNamespacedDeployment: vi.fn(async () => {
      if (phase === 'delete') {
        deleteReadEntered.resolve()
        await releaseDeleteRead.promise
        return hccDeployment()
      }
      if (phase === 'replacement') {
        replacementDeploymentReads += 1
        if (replacementDeploymentReads === 1) throw notFound()
        return hccDeployment()
      }
      throw notFound()
    }),
    createNamespacedDeployment: vi.fn(async () => hccDeployment()),
    replaceNamespacedDeployment: vi.fn(async () => hccDeployment()),
    deleteNamespacedDeployment: vi.fn(async () => ({})),
    listNamespacedDeployment: vi.fn(async () => ({ items: [] })),
  }
  const coreApi = {
    readNamespacedService: vi.fn(async () => {
      throw notFound()
    }),
    createNamespacedService: vi.fn(async () => ({})),
    replaceNamespacedService: vi.fn(async () => ({})),
    deleteNamespacedService: vi.fn(async () => ({})),
    readNamespacedConfigMap: vi.fn(async () => {
      throw notFound()
    }),
    deleteNamespacedConfigMap: vi.fn(async () => ({})),
    readNamespacedSecret: vi.fn(async () => {
      throw notFound()
    }),
  }
  const customApi = {
    getNamespacedCustomObjectStatus: vi.fn(async () => ({
      metadata: { resourceVersion: 'status-rv' },
      status: { conditions: [] },
    })),
    patchNamespacedCustomObjectStatus: vi.fn(async () => ({})),
    patchNamespacedCustomObject: vi.fn(async () => ({})),
    getNamespacedCustomObject: vi.fn(async () => {
      const live = current.get('ownership-recreate')
      if (live) return live
      throw notFound()
    }),
  }
  const reconciler = new McpServerReconciler({} as never, {
    appsApi: appsApi as never,
    coreApi: coreApi as never,
    customApi: customApi as never,
  })
  reconciler.setInventoryAuthority(() => ({ known: true, generation: 1 }))
  reconciler.setResolveCurrentServer(name => current.get(name))
  return {
    appsApi,
    current,
    deleteReadEntered,
    releaseDeleteRead,
    reconciler,
    setPhase(value: typeof phase) {
      phase = value
    },
  }
}

async function replaceAcrossBlockedDelete(oldManaged: boolean, newManaged: boolean) {
  const f = fixture()
  const oldServer = server('old-uid', oldManaged, oldManaged ? false : true)
  f.current.set(oldServer.name, oldServer)
  await f.reconciler.reconcile(oldServer)
  f.current.delete(oldServer.name)
  f.setPhase('delete')
  const deletion = f.reconciler.reconcileDelete(oldServer.name, oldServer.namespace)
  await f.deleteReadEntered.promise
  const replacement = server('new-uid', newManaged)
  f.current.set(replacement.name, replacement)
  f.releaseDeleteRead.resolve()
  await deletion
  f.setPhase('replacement')
  await f.reconciler.reconcile(replacement)
  return { ...f, replacement }
}

describe('managed ownership across same-name CRD recreation', () => {
  it('allows managed:true to managed:false after a new UID replaces a guarded delete', async () => {
    const f = await replaceAcrossBlockedDelete(true, false)
    expect(f.appsApi.deleteNamespacedDeployment).not.toHaveBeenCalled()
    expect(f.reconciler.hasIncompleteReconciliation()).toBe(false)
    expect(f.reconciler.getStatus(f.replacement)).toMatchObject({
      deployed: true,
      ready: true,
      message: 'WRC-owned runtime registered',
    })
  })

  it('allows managed:false to managed:true after a new UID replaces a guarded delete', async () => {
    const f = await replaceAcrossBlockedDelete(false, true)
    expect(f.appsApi.createNamespacedDeployment).toHaveBeenCalledTimes(1)
    expect(f.reconciler.hasIncompleteReconciliation()).toBe(false)
    expect(f.reconciler.getStatus(f.replacement)).toMatchObject({ deployed: true, ready: true })
  })

  it('still rejects an in-place managed change for the same UID', async () => {
    const f = fixture()
    const oldServer = server('same-uid', false)
    f.current.set(oldServer.name, oldServer)
    await f.reconciler.reconcile(oldServer)
    const edited = server('same-uid', true)
    edited.generation = 2
    f.current.set(edited.name, edited)
    await f.reconciler.reconcile(edited)
    expect(f.appsApi.createNamespacedDeployment).not.toHaveBeenCalled()
    expect(f.reconciler.getStatus(edited).message).toContain('managed field is immutable')
  })
})
