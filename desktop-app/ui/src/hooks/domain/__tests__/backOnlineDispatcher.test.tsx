// @vitest-environment jsdom
/**
 * §4.1 BACK_ONLINE dispatcher — a chat parked `offline` (a reconcile hit a
 * network error and dispatched WENT_OFFLINE) recovers automatically when the OS
 * fires a `window 'online'` event: the hook dispatches BACK_ONLINE, whose
 * `schedule_reconcile` effect routes back through the single-flight reconcileChat
 * gate (observable as a fresh `loadSessionMessages`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTaskKey } from '@contexts/AgentTaskTrackerContext'
import { act, waitFor } from '@testing-library/react'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

let clerum: MockClerum
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  clerum = installMockClerum()
})

afterEach(() => {
  vi.restoreAllMocks()
  uninstallMockClerum()
})

async function settleMount() {
  await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
}

describe('BACK_ONLINE dispatcher (§4.1)', () => {
  it('fires a reconcile for every offline chat when the network comes back', async () => {
    const { result } = renderController()
    await settleMount()

    const chatKey = makeTaskKey('agent-x', 'chat-offline')
    // Park the chat offline (as reconcileChat's network-error branch would).
    act(() => {
      result.current.sessionFsmStore.dispatch(chatKey, { type: 'WENT_OFFLINE' })
    })
    expect(result.current.sessionFsmStore.getState(chatKey)?.phase).toBe('offline')

    // Ignore any mount-time reconcile; only count the online-triggered one.
    clerum.rpc.loadSessionMessages.mockClear()

    act(() => {
      window.dispatchEvent(new Event('online'))
    })

    await waitFor(() =>
      expect(clerum.rpc.loadSessionMessages).toHaveBeenCalledWith(
        'agent-x',
        'agent-x',
        'chat-offline'
      )
    )
  })

  it('is a no-op when no chat is offline', async () => {
    const { result } = renderController()
    await settleMount()
    act(() => {
      result.current.sessionFsmStore.dispatch(makeTaskKey('agent-x', 'chat-live'), {
        type: 'SEND_STARTED',
        taskId: 't1',
      })
    })
    clerum.rpc.loadSessionMessages.mockClear()

    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    // Give any stray async dispatch a tick to settle.
    await Promise.resolve()
    expect(clerum.rpc.loadSessionMessages).not.toHaveBeenCalled()
  })
})
