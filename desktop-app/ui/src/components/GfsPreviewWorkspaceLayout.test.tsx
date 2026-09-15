// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { GfsMarkdownPreview } from '@components/GfsMarkdownPreview'
import { GfsVideoPreview } from '@components/GfsVideoPreview'

describe('GFS workspace-aware preview layout', () => {
  let sidebar: HTMLElement
  let sidebarRight = 74
  let resizeObserverCallback: (() => void) | null = null

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          download: vi.fn(async () => ({
            bytes: new TextEncoder().encode('# Preview\nBody').buffer,
          })),
        },
      },
    })
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:gfs-video-preview'),
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
    sidebarRight = 74
    resizeObserverCallback = null
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it.each([
    ['plain text', 'notes.txt'],
    ['Markdown', 'readme.md'],
    ['video', 'demo.mp4'],
  ])('keeps the %s preview clear of an expanding sidebar', async (kind, fileName) => {
    if (kind === 'video') {
      render(
        <GfsVideoPreview
          byteLength={14}
          fileName={fileName}
          gfsUri="gfs://main/file-1"
          mimeType="video/mp4"
          onClose={vi.fn()}
        />
      )
    } else {
      render(
        <GfsMarkdownPreview
          byteLength={14}
          fileName={fileName}
          gfsUri="gfs://main/file-1"
          onClose={vi.fn()}
        />
      )
    }

    const modal = screen.getByRole('presentation') as HTMLElement
    expect(modal.style.left).toBe('74px')
    expect(modal.style.right).toBe('0px')

    sidebarRight = 328
    sidebar.classList.remove('collapsed')
    resizeObserverCallback?.()

    await waitFor(() => {
      expect(modal.style.left).toBe('328px')
      expect(modal.style.right).toBe('0px')
    })
  })
})
