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

  it('does not reuse remote session or model cache entries across cache scopes', async () => {
    const listSessions = vi.fn(async () => ({ items: [] }))
    const getHostModels = vi.fn(async () => ({ models: [] }))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { rpc: { listSessions, getHostModels } },
    })
    const { result } = renderHook(() => useChatStore())

    result.current.setRemoteCacheScope('authenticated:team-a')
    await result.current.listSessions('cache-test-host', { limit: 50 })
    await result.current.getHostModels('cache-test-host', 'chat-1')
    await result.current.listSessions('cache-test-host', { limit: 50 })
    await result.current.getHostModels('cache-test-host', 'chat-1')

    expect(listSessions).toHaveBeenCalledTimes(1)
    expect(getHostModels).toHaveBeenCalledTimes(1)

    result.current.setRemoteCacheScope('authenticated:team-b')
    await result.current.listSessions('cache-test-host', { limit: 50 })
    await result.current.getHostModels('cache-test-host', 'chat-1')

    expect(listSessions).toHaveBeenCalledTimes(2)
    expect(getHostModels).toHaveBeenCalledTimes(2)
  })
})
