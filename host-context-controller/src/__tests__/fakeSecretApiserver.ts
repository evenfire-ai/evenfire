import { vi } from 'vitest'
import type { V1SecretList } from '@kubernetes/client-node'
import type { SecretList, SecretListPage, WatchLike } from '../informers/secretInformer'

/**
 * A fake apiserver for one namespace's Secrets with real watch semantics
 * (#1338 F2 Layer B tests):
 * - a watch without `resourceVersion` sends a synthetic ADDED for every
 *   existing Secret, then live changes;
 * - a watch with `resourceVersion` sends only the changes made after it;
 * - `list` pages with `limit` and `_continue` and returns the current
 *   resourceVersion.
 * Each change bumps one global resourceVersion, as etcd does.
 */
type WatchCallback = (phase: string, apiObj: unknown) => void
type DoneCallback = (err: Error | null) => void

export interface FakeWatchCall {
  queryParams: Record<string, unknown>
  cb: WatchCallback
  done: DoneCallback
  abort: ReturnType<typeof vi.fn>
}

type StoredSecret = { uid: string; resourceVersion: string }
type Change = {
  revision: number
  type: 'ADDED' | 'MODIFIED' | 'DELETED'
  name: string
} & StoredSecret

export function fakeSecretApiserver(namespace: string, initialNames: string[]) {
  let revision = 100
  let uidSequence = 0
  const objects = new Map<string, StoredSecret>()
  const changes: Change[] = []
  const watchCalls: FakeWatchCall[] = []
  let live: FakeWatchCall | null = null
  let expireNextResume = false
  const listPageFailures = new Map<number, () => unknown>()
  let listPage = 0

  const secretObject = (name: string, stored: StoredSecret) => ({
    metadata: { name, namespace, uid: stored.uid, resourceVersion: stored.resourceVersion },
    data: { value: Buffer.from(`fixture-${stored.resourceVersion}`).toString('base64') },
  })

  const record = (type: Change['type'], name: string, stored: StoredSecret) => {
    const change = { revision, type, name, ...stored }
    changes.push(change)
    live?.cb(type, secretObject(name, stored))
  }

  const create = (name: string) => {
    revision += 1
    const stored = { uid: `${name}-uid-${++uidSequence}`, resourceVersion: String(revision) }
    objects.set(name, stored)
    record('ADDED', name, stored)
  }

  const remove = (name: string) => {
    const previous = objects.get(name)
    if (!previous) throw new Error(`fake apiserver: no Secret ${name} to delete`)
    revision += 1
    objects.delete(name)
    record('DELETED', name, { uid: previous.uid, resourceVersion: String(revision) })
  }

  for (const name of initialNames) create(name)

  const watchFn = vi.fn<WatchLike['watch']>(async (_path, queryParams, cb, done) => {
    const abort = vi.fn()
    const call: FakeWatchCall = { queryParams, cb, done, abort }
    watchCalls.push(call)
    const from = queryParams.resourceVersion
    if (from === undefined) {
      for (const [name, stored] of objects) cb('ADDED', secretObject(name, stored))
    } else if (expireNextResume) {
      expireNextResume = false
      // client-node 1.4.0: a non-200 watch response calls done(err) with
      // `statusCode`, then resolves.
      done(Object.assign(new Error('Gone'), { statusCode: 410 }))
      return { abort } as unknown as AbortController
    } else {
      for (const change of changes) {
        if (change.revision > Number(from)) {
          cb(change.type, secretObject(change.name, change))
        }
      }
    }
    live = call
    return { abort } as unknown as AbortController
  })

  const list = vi.fn<SecretList>(async (_namespace: string, page: SecretListPage) => {
    listPage += 1
    const pageNumber = page.continueToken === undefined ? 1 : Number(page.continueToken)
    const failure = listPageFailures.get(pageNumber)
    if (failure) {
      listPageFailures.delete(pageNumber)
      throw failure()
    }
    const names = [...objects.keys()].sort()
    const start = (pageNumber - 1) * page.limit
    const slice = names.slice(start, start + page.limit)
    const more = start + page.limit < names.length
    const result: V1SecretList = {
      items: slice.map(name => secretObject(name, objects.get(name)!)),
      metadata: {
        resourceVersion: String(revision),
        ...(more ? { _continue: String(pageNumber + 1) } : {}),
      },
    }
    return result
  })

  return {
    watch: watchFn as unknown as WatchLike['watch'],
    watchFn,
    list,
    watchCalls,
    revision: () => String(revision),
    stored: (name: string) => objects.get(name),
    create,
    modify(name: string) {
      const previous = objects.get(name)
      if (!previous) throw new Error(`fake apiserver: no Secret ${name} to modify`)
      revision += 1
      const stored = { uid: previous.uid, resourceVersion: String(revision) }
      objects.set(name, stored)
      record('MODIFIED', name, stored)
    },
    remove,
    recreate(name: string) {
      remove(name)
      create(name)
    },
    bookmark(resourceVersion: string) {
      if (!live) throw new Error('fake apiserver: no live watch for a bookmark')
      live.cb('BOOKMARK', { metadata: { resourceVersion } })
    },
    /** End the live watch stream, as node-fetch reports a closed chunked body. */
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
    failListPage(pageNumber: number, failure: () => unknown) {
      listPageFailures.set(pageNumber, failure)
    },
    listPagesServed: () => listPage,
  }
}
