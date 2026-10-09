// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useChatStore } from '../useChatStore'

describe('useChatStore remote request cache', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete (window as { clerum?: unknown }).clerum
  })

  // Unit controls complement the real coordinator-boundary integration suite.
  // They isolate each reset so another required reset cannot mask its no-op mutant.
  it('R4 unit global reset refetches both hot Hosts', async () => {
    const listSessions = vi.fn(async () => ({ items: [] }))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { rpc: { listSessions } },
    })
    const { result } = renderHook(() => useChatStore())
    const hosts = ['cache-test-host-a', 'cache-test-host-b']
    const query = { limit: 50 }
    const callsFor = (hostRef: string) =>
      listSessions.mock.calls.filter(call => (call as unknown[])[0] === hostRef).length
    const warm = hosts.map(host => result.current.listSessions(host, query))
    await Promise.all(warm)
    hosts.forEach((host, index) => {
      expect(result.current.listSessions(host, query)).toBe(warm[index])
      expect(callsFor(host)).toBe(1)
    })

    result.current.clearCachedRemoteData()
    const fresh = hosts.map(host => result.current.listSessions(host, query))
    await Promise.all(fresh)
    hosts.forEach((host, index) => {
      expect(fresh[index]).not.toBe(warm[index])
      expect(callsFor(host)).toBe(2)
    })
  })

  it.each([
    { boundary: 'environment', next: 'authenticated:env-b:user-a:team-a' },
    { boundary: 'user', next: 'authenticated:env-a:user-b:team-a' },
    { boundary: 'team', next: 'authenticated:env-a:user-a:team-b' },
    { boundary: 'logout', next: 'signed-out' },
  ])('R4 unit $boundary scope refetches both hot Hosts', async ({ next }) => {
    const listSessions = vi.fn(async () => ({ items: [] }))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { rpc: { listSessions } },
    })
    const { result } = renderHook(() => useChatStore())
    const hosts = ['cache-test-host-a', 'cache-test-host-b']
    const query = { limit: 50 }
    const callsFor = (hostRef: string) =>
      listSessions.mock.calls.filter(call => (call as unknown[])[0] === hostRef).length
    result.current.setRemoteCacheScope('authenticated:env-a:user-a:team-a')
    const warm = hosts.map(host => result.current.listSessions(host, query))
    await Promise.all(warm)
    hosts.forEach((host, index) => {
      expect(result.current.listSessions(host, query)).toBe(warm[index])
      expect(callsFor(host)).toBe(1)
    })

    result.current.setRemoteCacheScope(next)
    const fresh = hosts.map(host => result.current.listSessions(host, query))
    await Promise.all(fresh)
    hosts.forEach((host, index) => {
      expect(fresh[index]).not.toBe(warm[index])
      expect(callsFor(host)).toBe(2)
    })
  })

  // F4: holding a Host drops its cached catalog requests (every query) and
  // leaves every other Host's entries shared. The scope itself contains ':',
  // so the Host is matched on the entry, not parsed out of the key.
  it('invalidates only the held Host catalog entries', async () => {
    const listSessions = vi.fn(async () => ({ items: [] }))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { rpc: { listSessions } },
    })
    const { result } = renderHook(() => useChatStore())
    const readAll = () =>
      Promise.all([
        result.current.listSessions('host', { agent: 'host', limit: 50 }),
        result.current.listSessions('host', { agent: 'host', limit: 50, cursor: 'page-2' }),
        result.current.listSessions('host-b', { agent: 'host-b', limit: 50 }),
      ])
    const callsFor = (hostRef: string) =>
      listSessions.mock.calls.filter(call => (call as unknown[])[0] === hostRef).length

    result.current.setRemoteCacheScope('authenticated:user-f4:team-f4')
    await readAll()
    await readAll()
    // Witness: the cache is live (three distinct keys, one upstream call each).
    expect(callsFor('host')).toBe(2)
    expect(callsFor('host-b')).toBe(1)

    result.current.invalidateSessionCatalog('host')
    await readAll()

    expect(callsFor('host')).toBe(4)
    expect(callsFor('host-b')).toBe(1)
  })

  // A request issued before the invalidation that rejects afterwards must not
  // evict the newer request cached under the same key.
  it('keeps the newer cached request when an invalidated one rejects late', async () => {
    let rejectStale: (error: Error) => void = () => {
      throw new Error('the stale request was never issued')
    }
    const listSessions = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectStale = reject
          })
      )
      .mockImplementation(async () => ({ items: [] }))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { rpc: { listSessions } },
    })
    const { result } = renderHook(() => useChatStore())
    result.current.setRemoteCacheScope('authenticated:user-race:team-race')
    const query = { agent: 'host', limit: 50 }

    const stale = result.current.listSessions('host', query)
    result.current.invalidateSessionCatalog('host')
    const fresh = result.current.listSessions('host', query)
    await fresh
    expect(listSessions).toHaveBeenCalledTimes(2)

    rejectStale(new Error('host access revoked'))
    await expect(stale).rejects.toThrow('host access revoked')

    // Witness: the fresh request is still the cached one for this key.
    await expect(result.current.listSessions('host', query)).resolves.toEqual({ items: [] })
    expect(listSessions).toHaveBeenCalledTimes(2)
  })

  // #654 M12 — the host-model catalog has exactly one cache, in
  // `hostModelSelectionStore`, which also owns revision ordering. A second TTL
  // layer here could only serve a response read BEFORE a write, which is the
  // stale revision the CAS must never be armed with.
  it('never caches host models: each call reaches the IPC bridge', async () => {
    const getHostModels = vi.fn(async () => ({ models: [] }))
    const setHostModel = vi.fn(async () => ({ success: true }))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { rpc: { getHostModels, setHostModel } },
    })
    const { result } = renderHook(() => useChatStore())

    result.current.setRemoteCacheScope('authenticated:team-a')
    await result.current.getHostModels('cache-test-host', 'chat-1')
    await result.current.getHostModels('cache-test-host', 'chat-1')
    // Back-to-back and identical: the old layer answered the second from cache.
    expect(getHostModels).toHaveBeenCalledTimes(2)

    // Even concurrently — there is no in-flight coalescing at this layer either.
    await Promise.all([
      result.current.getHostModels('cache-test-host', 'chat-1'),
      result.current.getHostModels('cache-test-host', 'chat-1'),
    ])
    expect(getHostModels).toHaveBeenCalledTimes(4)
    expect(getHostModels).toHaveBeenLastCalledWith('cache-test-host', 'chat-1')
  })

  it('forwards the CAS revision to the model write without a cache round-trip', async () => {
    const setHostModel = vi.fn(async () => ({ success: true }))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { rpc: { setHostModel } },
    })
    const { result } = renderHook(() => useChatStore())

    await result.current.setHostModel('cache-test-host', 'chat-1', 'model-b', 7)

    expect(setHostModel).toHaveBeenCalledTimes(1)
    expect(setHostModel).toHaveBeenCalledWith('cache-test-host', 'chat-1', 'model-b', undefined, 7)
  })

  it('does not carry pending model selections across an identity scope change', () => {
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { rpc: {} },
    })
    const { result } = renderHook(() => useChatStore())
    result.current.setRemoteCacheScope('authenticated:user-a:team-a')
    result.current.setPendingModel('agent', 'chat', 'model-a')
    result.current.setPreChatModel('agent', 'model-b')

    result.current.setRemoteCacheScope('authenticated:user-b:team-b')

    expect(result.current.getPendingModel('agent', 'chat')).toBeUndefined()
    expect(result.current.getPreChatModel('agent')).toBeUndefined()
  })
})
