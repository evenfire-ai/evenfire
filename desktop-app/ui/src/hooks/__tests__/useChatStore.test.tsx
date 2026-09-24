// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useChatStore } from '../useChatStore'

describe('useChatStore remote request cache', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete (window as { clerum?: unknown }).clerum
  })

  it('shares an in-flight session page and clears it at an identity boundary', async () => {
    const listSessions = vi.fn(async () => ({ items: [] }))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { rpc: { listSessions } },
    })
    const { result } = renderHook(() => useChatStore())

    await Promise.all([
      result.current.listSessions('cache-test-host', { limit: 50 }),
      result.current.listSessions('cache-test-host', { limit: 50 }),
    ])
    expect(listSessions).toHaveBeenCalledTimes(1)

    result.current.clearCachedRemoteData()
    await result.current.listSessions('cache-test-host', { limit: 50 })
    expect(listSessions).toHaveBeenCalledTimes(2)
  })

  it('does not reuse remote session cache entries across cache scopes', async () => {
    const listSessions = vi.fn(async () => ({ items: [] }))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { rpc: { listSessions } },
    })
    const { result } = renderHook(() => useChatStore())

    result.current.setRemoteCacheScope('authenticated:team-a')
    await result.current.listSessions('cache-test-host', { limit: 50 })
    await result.current.listSessions('cache-test-host', { limit: 50 })

    expect(listSessions).toHaveBeenCalledTimes(1)

    result.current.setRemoteCacheScope('authenticated:team-b')
    await result.current.listSessions('cache-test-host', { limit: 50 })

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
