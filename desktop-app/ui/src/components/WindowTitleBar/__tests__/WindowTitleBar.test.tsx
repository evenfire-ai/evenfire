// @vitest-environment jsdom
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TitlebarActionsPortal, WindowTitleBar, resolveWindowControlsPlatform } from '..'
import type { WindowControlsState } from '../types'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'clerum')
})

function setNavigatorPlatform(platform: string): void {
  Object.defineProperty(window.navigator, 'platform', {
    configurable: true,
    value: platform,
  })
}

function installClerumWindowControls(
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

  Object.defineProperty(window, 'clerum', {
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
    listenerCount: () => controlsStateListeners.size,
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
    const { api } = installClerumWindowControls()

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
    const { emitControlsState } = installClerumWindowControls({
      fullscreen: false,
      maximized: true,
    })

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

  it('renders reusable titlebar actions beside the native window controls', () => {
    setNavigatorPlatform('MacIntel')
    installClerumWindowControls()

    render(
      <WindowTitleBar
        actions={
          <button type="button" aria-label="Search">
            Search
          </button>
        }
      />
    )

    expect(screen.getByRole('button', { name: 'Search' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close window' })).toBeTruthy()
  })

  it('toggles maximize when the draggable titlebar area is double clicked', () => {
    setNavigatorPlatform('MacIntel')
    const { api } = installClerumWindowControls()
    const { container } = render(<WindowTitleBar />)

    fireEvent.doubleClick(container.querySelector('.window-titlebar') as HTMLElement)

    expect(api.toggleMaximize).toHaveBeenCalledTimes(1)
  })

  it('keeps double clicks on titlebar controls scoped to that control', () => {
    setNavigatorPlatform('MacIntel')
    const { api } = installClerumWindowControls()
    render(
      <WindowTitleBar
        actions={
          <button type="button" aria-label="Search">
            Search
          </button>
        }
      />
    )

    fireEvent.doubleClick(screen.getByRole('button', { name: 'Close window' }))
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Search' }))

    expect(api.toggleMaximize).not.toHaveBeenCalled()
  })

  it('portals provider-backed actions above the titlebar background', async () => {
    setNavigatorPlatform('MacIntel')
    installClerumWindowControls()

    function Harness() {
      const [actionsRoot, setActionsRoot] = React.useState<HTMLDivElement | null>(null)

      return (
        <>
          <WindowTitleBar actionsRef={setActionsRoot} />
          <div className="app-root">
            <TitlebarActionsPortal container={actionsRoot}>
              <button type="button" aria-label="Search">
                Search
              </button>
            </TitlebarActionsPortal>
          </div>
        </>
      )
    }

    render(<Harness />)

    const search = await screen.findByRole('button', { name: 'Search' })
    expect(search.closest('.window-titlebar')).toBeTruthy()
    expect(search.closest('.app-root')).toBeNull()
  })

  it('cleans up the exposed controls-state listener when unmounted', async () => {
    setNavigatorPlatform('Win32')
    const { api, listenerCount } = installClerumWindowControls()
    const { unmount } = render(<WindowTitleBar />)

    await waitFor(() => {
      expect(api.getControlsState).toHaveBeenCalledTimes(1)
    })
    expect(api.onControlsStateChange).toHaveBeenCalledTimes(1)
    expect(listenerCount()).toBe(1)

    unmount()

    expect(listenerCount()).toBe(0)
  })
})
