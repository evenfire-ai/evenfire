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
})
