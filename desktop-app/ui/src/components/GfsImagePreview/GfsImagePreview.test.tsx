// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { GfsImagePreview } from './index'

describe('GfsImagePreview layout', () => {
  let sidebar: HTMLElement
  let sidebarRight = 74
  let resizeObserverCallback: (() => void) | null = null

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          download: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer })),
        },
      },
    })
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:gfs-image-preview'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })

    sidebar = document.createElement('aside')
    sidebar.className = 'left-nav collapsed'
    vi.spyOn(sidebar, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          right: sidebarRight,
          width: sidebarRight,
          height: 800,
        }) as DOMRect
    )
    document.body.appendChild(sidebar)

    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resizeObserverCallback = callback
        }

        observe() {}

        disconnect() {}
      }
    )
  })

  afterEach(() => {
    cleanup()
    sidebar.remove()
    resizeObserverCallback = null
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('centers in the workspace and follows sidebar expansion changes', async () => {
    render(
      <GfsImagePreview
        byteLength={3}
        fileName="diagram.png"
        gfsUri="gfs://main/image-1"
        mimeType="image/png"
        onClose={vi.fn()}
      />
    )

    const modal = screen.getByRole('presentation')
    expect((modal as HTMLElement).style.left).toBe('74px')
    expect((modal as HTMLElement).style.right).toBe('0px')

    sidebarRight = 328
    sidebar.classList.remove('collapsed')
    resizeObserverCallback?.()

    await waitFor(() => {
      expect((modal as HTMLElement).style.left).toBe('328px')
      expect((modal as HTMLElement).style.right).toBe('0px')
    })
  })
})
