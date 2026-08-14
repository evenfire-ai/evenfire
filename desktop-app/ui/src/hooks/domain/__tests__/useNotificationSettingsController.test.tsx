// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useNotificationSettingsController } from '../useNotificationSettingsController'

type WindowState = { visible: boolean; focused: boolean }

function installWindowBridge(initialState: WindowState) {
  let listener: ((state: WindowState) => void) | null = null
  const getVisibility = vi.fn(async () => initialState)
  const onVisibilityChange = vi.fn((callback: (state: WindowState) => void) => {
    listener = callback
    return () => {
      listener = null
    }
  })
  const subscribe = () => () => undefined

  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      window: { getVisibility, onVisibilityChange },
      notifications: {
        onClick: subscribe,
        onAction: subscribe,
        onFailed: subscribe,
      },
    },
  })

  return {
    getVisibility,
    emit(state: WindowState) {
      listener?.(state)
    },
  }
}

describe('useNotificationSettingsController', () => {
  afterEach(() => {
    delete (window as { clerum?: unknown }).clerum
  })

  it('re-evaluates focused delivery after native focus changes', async () => {
    const bridge = installWindowBridge({ visible: true, focused: false })
    const { result } = renderHook(() => useNotificationSettingsController())

    await waitFor(() => expect(bridge.getVisibility).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      expect(
        result.current.canDeliverChatResponseNotification('inApp', { activeChatVisible: false })
      ).toBe(false)
    })

    act(() => bridge.emit({ visible: true, focused: true }))

    await waitFor(() => {
      expect(
        result.current.canDeliverChatResponseNotification('inApp', { activeChatVisible: false })
      ).toBe(true)
    })
  })
})
