// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useBrowserWindowState } from '../useBrowserWindowState'

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

  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: { window: { getVisibility, onVisibilityChange } },
  })

  return {
    getVisibility,
    onVisibilityChange,
    emit(state: WindowState) {
      listener?.(state)
    },
  }
}

describe('useBrowserWindowState', () => {
  afterEach(() => {
    delete (window as { clerum?: unknown }).clerum
  })

  it('uses native application focus instead of renderer document focus', async () => {
    const bridge = installWindowBridge({ visible: true, focused: false })
    const { result } = renderHook(() => useBrowserWindowState())

    await waitFor(() => expect(bridge.getVisibility).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      expect(result.current.isWindowVisible).toBe(true)
      expect(result.current.isAppFocused).toBe(false)
    })

    act(() => bridge.emit({ visible: true, focused: true }))
    expect(result.current.isAppFocused).toBe(true)
  })

  it('keeps the existing visibility behavior when the bridge is unavailable', () => {
    const { result } = renderHook(() => useBrowserWindowState())

    expect(result.current).toEqual({ isWindowVisible: true, isAppFocused: true })
  })
})
