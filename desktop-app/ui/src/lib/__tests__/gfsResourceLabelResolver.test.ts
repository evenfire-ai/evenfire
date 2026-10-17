import { describe, expect, it, vi } from 'vitest'
import { GFS_RESOURCE_LABEL_POLICY, GfsResourceLabelResolver } from '../gfsResourceLabelResolver'

function uri(index: number): string {
  return `gfs://main/${String(index).padStart(32, '0')}`
}

function resolved(uriValue: string, name = 'Authorized label') {
  return { gfsUri: uriValue, name, kind: 'file' }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise(resolvePromise => setTimeout(resolvePromise, 0))
}

describe('GfsResourceLabelResolver', () => {
  it('deduplicates the same exact URI across mounted consumers', async () => {
    const pending = deferred<unknown>()
    const resolve = vi.fn(() => pending.promise)
    const coordinator = new GfsResourceLabelResolver(resolve)
    const first = vi.fn()
    const second = vi.fn()

    coordinator.subscribe('test:user-a:team-a', 0, uri(1), first)
    coordinator.subscribe('test:user-a:team-a', 0, uri(1), second)
    await flushPromises()

    expect(resolve).toHaveBeenCalledOnce()
    await pending.resolve(resolved(uri(1)))
    await flushPromises()
    expect(first).toHaveBeenCalledWith({ name: 'Authorized label', kind: 'file' })
    expect(second).toHaveBeenCalledWith({ name: 'Authorized label', kind: 'file' })
  })

  it('caps starts, queued work, and concurrent resolutions', async () => {
    const deferreds: Array<ReturnType<typeof deferred<unknown>>> = []
    let concurrent = 0
    let maximumConcurrent = 0
    const resolve = vi.fn(() => {
      const pending = deferred<unknown>()
      deferreds.push(pending)
      concurrent += 1
      maximumConcurrent = Math.max(maximumConcurrent, concurrent)
      return pending.promise.finally(() => {
        concurrent -= 1
      })
    })
    const coordinator = new GfsResourceLabelResolver(resolve)
    const listeners = Array.from({ length: 70 }, () => vi.fn())
    for (let index = 1; index <= 70; index += 1) {
      coordinator.subscribe('test:user-a:team-a', 0, uri(index), listeners[index - 1]!)
    }
    await flushPromises()

    expect(resolve).toHaveBeenCalledTimes(GFS_RESOURCE_LABEL_POLICY.maxConcurrent)
    expect(deferreds).toHaveLength(GFS_RESOURCE_LABEL_POLICY.maxConcurrent)
    expect(maximumConcurrent).toBeLessThanOrEqual(GFS_RESOURCE_LABEL_POLICY.maxConcurrent)
    expect(listeners.slice(68).every(listener => listener.mock.calls.length === 1)).toBe(true)
    expect(listeners[68]).toHaveBeenCalledWith(null)
    expect(listeners[69]).toHaveBeenCalledWith(null)

    let nextDeferred = 0
    while (nextDeferred < 60) {
      const batch = deferreds.slice(nextDeferred)
      nextDeferred = deferreds.length
      batch.forEach((pending, offset) => {
        const startedIndex = nextDeferred - batch.length + offset + 1
        pending.resolve(resolved(uri(startedIndex)))
      })
      await flushPromises()
    }

    expect(resolve).toHaveBeenCalledTimes(GFS_RESOURCE_LABEL_POLICY.maxStartsPerPrincipalPerMinute)
    expect(maximumConcurrent).toBeLessThanOrEqual(GFS_RESOURCE_LABEL_POLICY.maxConcurrent)
  })

  it('retains the rolling principal budget across authorization epochs', async () => {
    let now = 10_000
    const resolve = vi.fn(async (requestedUri: string) => resolved(requestedUri))
    const coordinator = new GfsResourceLabelResolver(resolve, () => now)

    for (let index = 1; index <= 60; index += 1) {
      coordinator.subscribe('test:user-a:team-a', 0, uri(index), () => undefined)
    }
    await flushPromises()
    coordinator.subscribe('test:user-a:team-a', 1, uri(61), () => undefined)
    await flushPromises()
    expect(resolve).toHaveBeenCalledTimes(60)

    now += GFS_RESOURCE_LABEL_POLICY.rollingWindowMs + 1
    coordinator.subscribe('test:user-a:team-a', 1, uri(61), () => undefined)
    await flushPromises()
    expect(resolve).toHaveBeenCalledTimes(61)
  })

  it('ignores late old-epoch results and resolves the current link under the new epoch', async () => {
    const oldRequest = deferred<unknown>()
    const currentRequest = deferred<unknown>()
    const resolve = vi
      .fn()
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(currentRequest.promise)
    const coordinator = new GfsResourceLabelResolver(resolve)
    const oldListener = vi.fn()
    const currentListener = vi.fn()

    const unsubscribeOld = coordinator.subscribe('test:user-a:team-a', 0, uri(1), oldListener)
    await flushPromises()
    coordinator.subscribe('test:user-a:team-a', 1, uri(1), currentListener)
    await flushPromises()

    oldRequest.resolve(resolved(uri(1), 'Stale name'))
    await flushPromises()
    expect(oldListener).not.toHaveBeenCalled()
    expect(currentListener).not.toHaveBeenCalled()

    currentRequest.resolve(resolved(uri(1), 'Fresh name'))
    await flushPromises()
    expect(currentListener).toHaveBeenCalledWith({ name: 'Fresh name', kind: 'file' })
    unsubscribeOld()
  })

  it('drops queued work after the last consumer removes its source link', async () => {
    const deferreds: Array<ReturnType<typeof deferred<unknown>>> = []
    const resolve = vi.fn(() => {
      const pending = deferred<unknown>()
      deferreds.push(pending)
      return pending.promise
    })
    const coordinator = new GfsResourceLabelResolver(resolve)
    const listeners = Array.from({ length: 5 }, () => vi.fn())
    const unsubscribe: Array<() => void> = []
    for (let index = 0; index < listeners.length; index += 1) {
      unsubscribe.push(
        coordinator.subscribe('test:user-a:team-a', 0, uri(index + 1), listeners[index]!)
      )
    }
    await flushPromises()
    expect(resolve).toHaveBeenCalledTimes(4)

    unsubscribe[4]!()
    deferreds[0]!.resolve(resolved(uri(1)))
    await flushPromises()
    expect(resolve).toHaveBeenCalledTimes(4)
    expect(listeners[4]).not.toHaveBeenCalled()
  })

  it('clears completed names across principal changes and logout', async () => {
    const resolve = vi.fn(async (requestedUri: string) => resolved(requestedUri, 'Private name'))
    const coordinator = new GfsResourceLabelResolver(resolve)
    const firstPrincipal = vi.fn()
    const secondPrincipal = vi.fn()
    const afterLogout = vi.fn()

    coordinator.subscribe('test:user-a:team-a', 0, uri(1), firstPrincipal)
    await flushPromises()
    coordinator.subscribe('test:user-b:team-b', 0, uri(1), secondPrincipal)
    await flushPromises()
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(secondPrincipal).toHaveBeenCalledWith({ name: 'Private name', kind: 'file' })

    coordinator.setActivePrincipal(null)
    coordinator.subscribe('test:user-a:team-a', 0, uri(1), afterLogout)
    await flushPromises()
    expect(resolve).toHaveBeenCalledTimes(3)
    expect(afterLogout).toHaveBeenCalledWith({ name: 'Private name', kind: 'file' })
  })

  it('does not reuse cached labels across main session generations', async () => {
    let sessionGeneration = 1
    const resolve = vi.fn(async (requestedUri: string) =>
      resolved(requestedUri, `Session ${sessionGeneration} label`)
    )
    const coordinator = new GfsResourceLabelResolver(
      resolve,
      Date.now,
      async () => sessionGeneration
    )
    const firstSession = vi.fn()
    const secondSession = vi.fn()

    coordinator.subscribe('test:user-a:team-a', 0, uri(6), firstSession)
    await flushPromises()
    expect(firstSession).toHaveBeenCalledWith({ name: 'Session 1 label', kind: 'file' })

    sessionGeneration = 2
    coordinator.subscribe('test:user-a:team-a', 0, uri(6), secondSession)
    await flushPromises()

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(secondSession).toHaveBeenCalledWith({ name: 'Session 2 label', kind: 'file' })
  })

  it('discards in-flight labels when the main session generation changes', async () => {
    let sessionGeneration = 1
    const oldResult = deferred<unknown>()
    const currentResult = deferred<unknown>()
    const resolve = vi
      .fn()
      .mockReturnValueOnce(oldResult.promise)
      .mockReturnValueOnce(currentResult.promise)
    const coordinator = new GfsResourceLabelResolver(
      resolve,
      Date.now,
      async () => sessionGeneration
    )
    const oldSession = vi.fn()
    const currentSession = vi.fn()

    coordinator.subscribe('test:user-a:team-a', 0, uri(7), oldSession)
    await flushPromises()
    sessionGeneration = 2
    coordinator.subscribe('test:user-a:team-a', 0, uri(7), currentSession)
    await flushPromises()

    currentResult.resolve(resolved(uri(7), 'Current session name'))
    await flushPromises()
    oldResult.resolve(resolved(uri(7), 'Old session name'))
    await flushPromises()

    expect(currentSession).toHaveBeenCalledWith({ name: 'Current session name', kind: 'file' })
    expect(oldSession).not.toHaveBeenCalled()
  })

  it('does not cache a late result after authority invalidation and resolves fresh on retry', async () => {
    const lateResult = deferred<unknown>()
    const resolve = vi
      .fn()
      .mockReturnValueOnce(lateResult.promise)
      .mockResolvedValueOnce(resolved(uri(8), 'Fresh authorized name'))
    const coordinator = new GfsResourceLabelResolver(resolve)
    const staleListener = vi.fn()
    const retryListener = vi.fn()

    coordinator.subscribe('test:user-a:team-a', 0, uri(8), staleListener)
    await flushPromises()
    coordinator.invalidatePrincipal('test:user-a:team-a')
    lateResult.resolve(resolved(uri(8), 'Revoked stale name'))
    await flushPromises()

    coordinator.subscribe('test:user-a:team-a', 0, uri(8), retryListener)
    await flushPromises()

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(staleListener).not.toHaveBeenCalled()
    expect(retryListener).toHaveBeenCalledWith({ name: 'Fresh authorized name', kind: 'file' })
  })

  it('rejects denied, malformed, and URI-mismatched resolver results', async () => {
    const responses: unknown[] = [
      Promise.reject(new Error('403 Forbidden')),
      { gfsUri: uri(99), name: 'Wrong resource', kind: 'file' },
      { gfsUri: uri(3), name: '   ', kind: 'file' },
      { gfsUri: uri(4), name: 'Unknown type', kind: 'shortcut' },
    ]
    const resolve = vi.fn(async () => {
      const response = responses.shift()
      if (response instanceof Promise) return response
      return response
    })
    const coordinator = new GfsResourceLabelResolver(resolve)
    const results = [vi.fn(), vi.fn(), vi.fn(), vi.fn()]
    results.forEach((listener, index) => {
      coordinator.subscribe('test:user-a:team-a', 0, uri(index + 1), listener)
    })
    await flushPromises()

    results.forEach((listener, index) => {
      expect(listener).toHaveBeenCalledOnce()
      if (index === 0) {
        expect(listener).toHaveBeenCalledWith(
          null,
          expect.objectContaining({ message: '403 Forbidden' })
        )
      } else {
        expect(listener).toHaveBeenCalledWith(null)
      }
    })
  })

  it('removes bidi controls from externally controlled resource labels', async () => {
    const resolve = vi.fn(async (requestedUri: string) =>
      resolved(requestedUri, 'invoice.pdf\u202Eexe')
    )
    const coordinator = new GfsResourceLabelResolver(resolve)
    const listener = vi.fn()

    coordinator.subscribe('test:user-a:team-a', 0, uri(5), listener)
    await flushPromises()

    expect(listener).toHaveBeenCalledWith({ name: 'invoice.pdfexe', kind: 'file' })
  })
})
