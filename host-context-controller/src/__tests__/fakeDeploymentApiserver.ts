import { vi } from 'vitest'
import type { V1Deployment, V1DeploymentList } from '@kubernetes/client-node'
import type { WatchLike } from '../informers/secretInformer'

/**
 * A fake apiserver for one namespace's managed Deployments with real watch
 * semantics: a watch with `resourceVersion` sends only the changes made after
 * it, and every change bumps one global resourceVersion, as etcd does.
 */
type WatchCallback = (phase: string, apiObj: unknown) => void
type DoneCallback = (err: Error | null) => void

export interface FakeDeploymentWatchCall {
  path: string
  queryParams: Record<string, unknown>
  cb: WatchCallback
  done: DoneCallback
  abort: ReturnType<typeof vi.fn>
}

type StoredRollout = { generation: number; ready: boolean }
type Change = {
  revision: number
  type: 'ADDED' | 'MODIFIED' | 'DELETED'
  name: string
} & StoredRollout

export function fakeDeploymentApiserver(namespace: string, initial: Record<string, StoredRollout>) {
  let revision = 100
  const objects = new Map<string, StoredRollout>(Object.entries(initial))
  const changes: Change[] = []
  const watchCalls: FakeDeploymentWatchCall[] = []
  let live: FakeDeploymentWatchCall | null = null
  let expireNextResume = false
  let watchFailure: (() => Error) | null = null
  const listFailures: Array<() => unknown> = []

  const deployment = (name: string, stored: StoredRollout, version: number): V1Deployment => ({
    metadata: {
      name,
      namespace,
      generation: stored.generation,
      resourceVersion: String(version),
    },
    spec: { replicas: 1 } as V1Deployment['spec'],
    status: {
      observedGeneration: stored.generation,
      replicas: 1,
      updatedReplicas: 1,
      readyReplicas: stored.ready ? 1 : 0,
      availableReplicas: stored.ready ? 1 : 0,
    },
  })

  const record = (type: Change['type'], name: string, stored: StoredRollout) => {
    revision += 1
    changes.push({ revision, type, name, ...stored })
    live?.cb(type, deployment(name, stored, revision))
  }

  const watchFn = vi.fn<WatchLike['watch']>(async (path, queryParams, cb, done) => {
    const abort = vi.fn()
    const call: FakeDeploymentWatchCall = { path, queryParams, cb, done, abort }
    watchCalls.push(call)
    if (watchFailure) {
      // client-node 1.4.0: a non-200 watch response calls done(err), then resolves.
      done(watchFailure())
      return { abort } as unknown as AbortController
    }
    if (queryParams.resourceVersion !== undefined && expireNextResume) {
      expireNextResume = false
      done(Object.assign(new Error('Gone'), { statusCode: 410 }))
      return { abort } as unknown as AbortController
    }
    for (const change of changes) {
      if (change.revision > Number(queryParams.resourceVersion)) {
        cb(change.type, deployment(change.name, change, change.revision))
      }
    }
    live = call
    return { abort } as unknown as AbortController
  })

  const list = vi.fn(async (): Promise<V1DeploymentList> => {
    const failure = listFailures.shift()
    if (failure) throw failure()
    return {
      items: [...objects].map(([name, stored]) => deployment(name, stored, revision)),
      metadata: { resourceVersion: String(revision) },
    }
  })

  return {
    watch: watchFn as unknown as WatchLike['watch'],
    watchFn,
    list,
    watchCalls,
    revision: () => String(revision),
    /** Change a Deployment; the live watch, if any, sees the event. */
    set(name: string, stored: StoredRollout) {
      const type = objects.has(name) ? 'MODIFIED' : 'ADDED'
      objects.set(name, stored)
      record(type, name, stored)
    },
    remove(name: string) {
      const stored = objects.get(name)
      if (!stored) throw new Error(`fake apiserver: no Deployment ${name} to delete`)
      objects.delete(name)
      record('DELETED', name, stored)
    },
    /** Send an event as the apiserver would, without touching the store. */
    emitRaw(type: string, apiObj: unknown) {
      if (!live) throw new Error('fake apiserver: no live watch')
      live.cb(type, apiObj)
    },
    bookmark(resourceVersion: string) {
      if (!live) throw new Error('fake apiserver: no live watch for a bookmark')
      live.cb('BOOKMARK', { metadata: { resourceVersion } })
    },
    disconnect(error: Error | null = new Error('Premature close')) {
      if (!live) throw new Error('fake apiserver: no live watch to disconnect')
      const ended = live
      live = null
      ended.done(error)
    },
    /** The next watch that carries a resourceVersion is answered with HTTP 410. */
    expireNextResume() {
      expireNextResume = true
    },
    /** In-stream expiry: an ERROR event with a 410 Status, then the stream ends. */
    expireInStream() {
      if (!live) throw new Error('fake apiserver: no live watch to expire')
      const ended = live
      live = null
      ended.cb('ERROR', { kind: 'Status', code: 410, reason: 'Expired' })
      ended.done(null)
    },
    /** Every watch until cleared with null answers this failure through done(err). */
    failWatches(failure: (() => Error) | null) {
      watchFailure = failure
    },
    failNextList(failure: () => unknown) {
      listFailures.push(failure)
    },
  }
}
