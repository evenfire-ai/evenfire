// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WindowTitleBar, resolveWindowControlsPlatform } from '..'
import type { WindowControlsState } from '../types'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function setNavigatorPlatform(platform: string): void {
  Object.defineProperty(window.navigator, 'platform', {
    configurable: true,
    value: platform,
  })
}

function installWindowControls(
  state: WindowControlsState = { fullscreen: false, maximized: false }
) {
  const controlsStateListeners = new Set<(nextState: WindowControlsState) => void>()
  const api = {
    close: vi.fn(async () => undefined),
    getControlsState: vi.fn(async () => state),
    minimize: vi.fn(async () => undefined),
    onControlsStateChange: vi.fn((callback: (nextState: WindowControlsState) => void) => {
      controlsStateListeners.add(callback)
      return () => controlsStateListeners.delete(callback)
    }),
    toggleMaximize: vi.fn(async () => undefined),
  }

  Object.defineProperty(window, 'evenfire', {
    configurable: true,
    value: {
      window: api,
    },
  })

  return {
    api,
    emitControlsState: (nextState: WindowControlsState) => {
      controlsStateListeners.forEach(listener => listener(nextState))
    },
  }
}

describe('resolveWindowControlsPlatform', () => {
  it('maps desktop navigator platform values to the supported control styles', () => {
    expect(resolveWindowControlsPlatform('MacIntel')).toBe('mac')
    expect(resolveWindowControlsPlatform('Win32')).toBe('windows')
    expect(resolveWindowControlsPlatform('Linux x86_64')).toBe('linux')
  })
})

describe('WindowTitleBar', () => {
  it('uses macOS traffic-light ordering and native window actions', async () => {
    setNavigatorPlatform('MacIntel')
    const { api } = installWindowControls()

    render(<WindowTitleBar />)

    const buttons = screen.getAllByRole('button')
    expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual([
      'Close window',
      'Minimize window',
      'Maximize window',
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Close window' }))
    fireEvent.click(screen.getByRole('button', { name: 'Minimize window' }))
    fireEvent.click(screen.getByRole('button', { name: 'Maximize window' }))

    expect(api.close).toHaveBeenCalledTimes(1)
    expect(api.minimize).toHaveBeenCalledTimes(1)
    expect(api.toggleMaximize).toHaveBeenCalledTimes(1)
  })

  it('uses the Windows/Linux icon order and updates the maximize label when restored', async () => {
    setNavigatorPlatform('Win32')
    const { emitControlsState } = installWindowControls({ fullscreen: false, maximized: true })

    render(<WindowTitleBar />)

    await screen.findByRole('button', { name: 'Restore window' })
    expect(screen.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual([
      'Minimize window',
      'Restore window',
      'Close window',
    ])

    emitControlsState({ fullscreen: false, maximized: false })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Maximize window' })).toBeTruthy()
    })
  })
})
