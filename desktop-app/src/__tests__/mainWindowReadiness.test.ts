import { describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import { wireMainWindowRendererReadiness } from '../mainWindowReadiness.js'

describe('main window renderer readiness', () => {
  function makeWebContents() {
    const listeners = new Map<string, (...args: unknown[]) => void>()
    return {
      listeners,
      webContents: {
        isDestroyed: vi.fn(() => false),
        on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
          listeners.set(event, listener)
        }),
        reload: vi.fn(),
      },
    }
  }

  it('marks the renderer not ready only after a navigation commits', () => {
    const { listeners, webContents } = makeWebContents()
    const markNotReady = vi.fn()

    wireMainWindowRendererReadiness({
      webContents: webContents as never,
      isCurrentWindow: () => true,
      markNotReady,
    })

    expect(listeners.has('did-start-navigation')).toBe(false)
    expect(listeners.has('did-navigate')).toBe(true)

    listeners.get('did-navigate')?.()
    expect(markNotReady).toHaveBeenCalledOnce()
  })

  it('reloads a crashed renderer so it can perform a new ready handshake', () => {
    const { listeners, webContents } = makeWebContents()
    const markNotReady = vi.fn()

    wireMainWindowRendererReadiness({
      webContents: webContents as never,
      isCurrentWindow: () => true,
      markNotReady,
    })

    listeners.get('render-process-gone')?.({}, { reason: 'crashed' })

    expect(markNotReady).toHaveBeenCalledOnce()
    expect(webContents.reload).toHaveBeenCalledOnce()
  })

  it('does not reload a clean exit or react to an obsolete window', () => {
    const clean = makeWebContents()
    wireMainWindowRendererReadiness({
      webContents: clean.webContents as never,
      isCurrentWindow: () => true,
      markNotReady: vi.fn(),
    })
    clean.listeners.get('render-process-gone')?.({}, { reason: 'clean-exit' })
    expect(clean.webContents.reload).not.toHaveBeenCalled()

    const obsolete = makeWebContents()
    const markNotReady = vi.fn()
    wireMainWindowRendererReadiness({
      webContents: obsolete.webContents as never,
      isCurrentWindow: () => false,
      markNotReady,
    })
    obsolete.listeners.get('render-process-gone')?.({}, { reason: 'crashed' })
    expect(markNotReady).not.toHaveBeenCalled()
    expect(obsolete.webContents.reload).not.toHaveBeenCalled()
  })
})
