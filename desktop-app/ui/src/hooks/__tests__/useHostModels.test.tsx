// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { HostModelsResult } from '../useChatStore'
import { useChatStore } from '../useChatStore'
import { useHostModels } from '../useHostModels'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const AGENT = 'chatllm'
const CHAT = 'chat-1'

function baseModels(overrides: Partial<HostModelsResult> = {}): HostModelsResult {
  return {
    provider: 'claude',
    hostDefault: 'claude-opus-4-8',
    sessionModel: 'claude-haiku-4-5',
    degraded: false,
    models: [
      { name: 'claude-opus-4-8', displayName: 'Opus 4.8' },
      { name: 'claude-haiku-4-5', displayName: 'Haiku 4.5' },
    ],
    ...overrides,
  }
}

function installClerum(
  getHostModels: ReturnType<typeof vi.fn>,
  setHostModel: ReturnType<typeof vi.fn>
) {
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    writable: true,
    value: { rpc: { getHostModels, setHostModel } },
  })
}

/**
 * Renders `useHostModels` next to a `useChatStore` handle so the tests can read
 * the module-level pending-model store the send path drains. Waits for the
 * initial model-list fetch so `data` is populated before a selection.
 */
async function renderLoaded(setHostModel: ReturnType<typeof vi.fn>) {
  const getHostModels = vi.fn(async () => baseModels())
  installClerum(getHostModels, setHostModel)
  const rendered = renderHook(() => ({
    models: useHostModels(AGENT, CHAT),
    store: useChatStore(),
  }))
  await waitFor(() => expect(rendered.result.current.models.data).toBeTruthy())
  // Start each case from a clean pending slot (the store is a module singleton).
  act(() => rendered.result.current.store.clearPendingModel(AGENT, CHAT))
  return rendered
}

afterEach(() => {
  delete (window as { clerum?: unknown }).clerum
  vi.restoreAllMocks()
})

describe('useHostModels.selectModel — R2 "Option A" optimistic + pending', () => {
  it('(a) on POST success reflects the canonical model and clears any pending', async () => {
    const setHostModel = vi.fn(async () => ({
      effective: 'next-task' as const,
      provider: 'claude',
      model: 'claude-opus-4-8',
    }))
    const { result } = await renderLoaded(setHostModel)
    // Seed a stale pending to prove success drains it.
    act(() => result.current.store.setPendingModel(AGENT, CHAT, 'claude-haiku-4-5'))

    let ok = false
    await act(async () => {
      ok = await result.current.models.selectModel('claude-opus-4-8')
    })

    expect(ok).toBe(true)
    expect(result.current.models.data?.sessionModel).toBe('claude-opus-4-8')
    expect(result.current.models.error).toBeNull()
    expect(result.current.store.getPendingModel(AGENT, CHAT)).toBeUndefined()
  })

  it('(b) on a 403 model_not_allowed reverts the optimistic UI, errors, and sets NO pending', async () => {
    const setHostModel = vi.fn(async () => {
      throw new Error('Set host model rejected (model_not_allowed)')
    })
    const { result } = await renderLoaded(setHostModel)

    let ok = true
    await act(async () => {
      ok = await result.current.models.selectModel('claude-opus-4-8')
    })

    expect(ok).toBe(false)
    // Reverted to the pre-optimistic selection.
    expect(result.current.models.data?.sessionModel).toBe('claude-haiku-4-5')
    expect(result.current.models.error).toMatch(/no longer allowed/i)
    expect(result.current.store.getPendingModel(AGENT, CHAT)).toBeUndefined()
  })

  it('(c1) seeds the chip from a pending model when the server has no session selection yet', async () => {
    // Host was suspended earlier: the pick lives only in the pending slot. On a
    // fresh fetch the server returns no `sessionModel`, so the chip must fall back
    // to the pending model rather than flashing the host default.
    const getHostModels = vi.fn(async () => baseModels({ sessionModel: null }))
    installClerum(getHostModels, vi.fn())
    const seed = renderHook(() => useChatStore())
    act(() => seed.result.current.setPendingModel(AGENT, CHAT, 'claude-haiku-4-5'))
    seed.unmount()

    const { result } = renderHook(() => ({
      models: useHostModels(AGENT, CHAT),
      store: useChatStore(),
    }))
    await waitFor(() => expect(result.current.models.data).toBeTruthy())
    expect(result.current.models.data?.sessionModel).toBe('claude-haiku-4-5')

    act(() => result.current.store.clearPendingModel(AGENT, CHAT))
  })

  it('(c) on a host-unavailable failure keeps the optimistic UI and records a pending model', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const setHostModel = vi.fn(async () => {
      throw new Error('Set host model failed (503): {"code":"host_waking"}')
    })
    const { result } = await renderLoaded(setHostModel)

    let ok = false
    await act(async () => {
      ok = await result.current.models.selectModel('claude-opus-4-8')
    })

    // Optimistically accepted (the selector shows "applies to next message").
    expect(ok).toBe(true)
    expect(result.current.models.data?.sessionModel).toBe('claude-opus-4-8')
    // No hard error surfaced — swallowed + logged.
    expect(result.current.models.error).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
    // Recorded for the next send to piggyback.
    expect(result.current.store.getPendingModel(AGENT, CHAT)).toBe('claude-opus-4-8')

    // Clean up the module-level pending we intentionally left set.
    act(() => result.current.store.clearPendingModel(AGENT, CHAT))
  })
})

describe('useHostModels — R2 new-chat composer (no chatId yet)', () => {
  it('fetches the host-level model list with an empty chatId (list is host-level)', async () => {
    const getHostModels = vi.fn(async () => baseModels({ sessionModel: null }))
    installClerum(getHostModels, vi.fn())

    const { result } = renderHook(() => useHostModels(AGENT, ''))
    await waitFor(() => expect(result.current.data).toBeTruthy())

    // The list loaded even without a chat, and the underlying fetch was told there
    // is no chatId (server returns `sessionModel: null` → chip shows host default).
    expect(getHostModels).toHaveBeenCalledWith(AGENT, '')
    expect(result.current.data?.sessionModel).toBeNull()
  })

  it('holds the pick locally (no POST, pre-chat slot set) and reflects it optimistically', async () => {
    const getHostModels = vi.fn(async () => baseModels({ sessionModel: null }))
    const setHostModel = vi.fn()
    installClerum(getHostModels, setHostModel)

    const { result } = renderHook(() => ({
      models: useHostModels(AGENT, ''),
      store: useChatStore(),
    }))
    await waitFor(() => expect(result.current.models.data).toBeTruthy())
    // Ensure a clean pre-chat slot (module singleton).
    act(() => result.current.store.clearPreChatModel(AGENT))

    let ok = false
    await act(async () => {
      ok = await result.current.models.selectModel('claude-haiku-4-5')
    })

    expect(ok).toBe(true)
    // No server round-trip — there is no session to POST to yet.
    expect(setHostModel).not.toHaveBeenCalled()
    // Held in the agent-keyed pre-chat slot for the first send to migrate.
    expect(result.current.store.getPreChatModel(AGENT)).toBe('claude-haiku-4-5')
    // Chip reflects the pick immediately.
    expect(result.current.models.data?.sessionModel).toBe('claude-haiku-4-5')

    act(() => result.current.store.clearPreChatModel(AGENT))
  })

  it('seeds the chip from the pre-chat slot across a refetch/remount', async () => {
    const getHostModels = vi.fn(async () => baseModels({ sessionModel: null }))
    installClerum(getHostModels, vi.fn())
    const seed = renderHook(() => useChatStore())
    act(() => seed.result.current.setPreChatModel(AGENT, 'claude-haiku-4-5'))
    seed.unmount()

    const { result } = renderHook(() => ({
      models: useHostModels(AGENT, ''),
      store: useChatStore(),
    }))
    await waitFor(() => expect(result.current.models.data).toBeTruthy())
    // The server has no session selection, but the pre-chat slot restores the pick.
    expect(result.current.models.data?.sessionModel).toBe('claude-haiku-4-5')

    act(() => result.current.store.clearPreChatModel(AGENT))
  })
})
