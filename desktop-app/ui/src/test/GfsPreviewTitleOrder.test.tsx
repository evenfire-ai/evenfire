// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { GfsImagePreviewBody } from '@components/GfsImagePreview/Body'
import { GfsMarkdownPreviewBody } from '@components/GfsMarkdownPreview/Body'
import { GfsVideoPreviewBody } from '@components/GfsVideoPreview/Body'

function installPreviewBoundary() {
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      gfs: {
        downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer })),
      },
    },
  })
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:title-order'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
}

function expectTitleOrder(container: HTMLElement, title: string) {
  const titleRow = container.querySelector('.da-gfs-preview-title-row')
  expect(titleRow).toBeTruthy()
  expect(
    Array.from(titleRow!.children).map(child => {
      if (child.textContent === title) return 'filename'
      if (child.matches('[data-testid="title-menu"]')) return 'menu'
      if (child.matches('[data-testid="permission-progress"]')) return 'spinner'
      return 'other'
    })
  ).toEqual(['filename', 'menu', 'spinner'])
}

describe('GFS preview title sibling order', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders image filename, menu, then the final permission spinner', () => {
    installPreviewBoundary()
    const { container } = render(
      <GfsImagePreviewBody
        byteLength={1}
        dataBase64="AQ=="
        fileName="diagram.png"
        mimeType="image/png"
        permissionProgress={<span data-testid="permission-progress" />}
        titleActions={
          <button data-testid="title-menu" type="button">
            Options
          </button>
        }
      />
    )
    expectTitleOrder(container, 'diagram.png')
  })

  it('renders Markdown/text filename, menu, then the final permission spinner', () => {
    installPreviewBoundary()
    const { container } = render(
      <GfsMarkdownPreviewBody
        byteLength={1}
        fileName="notes.txt"
        gfsUri="gfs://main/notes"
        permissionProgress={<span data-testid="permission-progress" />}
        titleActions={
          <button data-testid="title-menu" type="button">
            Options
          </button>
        }
      />
    )
    expectTitleOrder(container, 'notes.txt')
  })

  it('renders video filename, menu, then the final permission spinner', () => {
    installPreviewBoundary()
    const { container } = render(
      <GfsVideoPreviewBody
        byteLength={1}
        fileName="clip.mp4"
        gfsUri="gfs://main/clip"
        mimeType="video/mp4"
        permissionProgress={<span data-testid="permission-progress" />}
        titleActions={
          <button data-testid="title-menu" type="button">
            Options
          </button>
        }
      />
    )
    expectTitleOrder(container, 'clip.mp4')
  })
})
