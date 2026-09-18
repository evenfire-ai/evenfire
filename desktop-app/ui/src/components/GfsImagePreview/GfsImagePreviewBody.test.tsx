// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GFS_IMAGE_PREVIEW_MAX_BYTES } from '@constants/gfsImagePreview'
import { GfsImagePreviewBody } from './Body'

// The producer (`window.clerum.gfs.download`) returns `{ bytes: ArrayBuffer }`
// (renderer.d.ts); the body reads only `.bytes`, so the mock mirrors that shape.
function stubDownload(bytes: ArrayBuffer) {
  const download = vi.fn(async () => ({ bytes }))
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: { gfs: { download } },
  })
  return download
}

describe('GfsImagePreviewBody', () => {
  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:gfs-image-preview'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('downloads by gfsUri and renders the image without a modal', async () => {
    const download = stubDownload(new Uint8Array([1, 2, 3]).buffer)

    render(
      <GfsImagePreviewBody
        byteLength={3}
        fileName="diagram.PNG"
        gfsUri="gfs://main/image-1"
        mimeType="image/png"
      />
    )

    const img = await screen.findByAltText('Preview of diagram.PNG')
    expect(img.tagName).toBe('IMG')
    expect(img.getAttribute('src')).toBe('blob:gfs-image-preview')
    expect(download).toHaveBeenCalledWith('gfs://main/image-1')
    // No portal/backdrop/dialog chrome — this is the de-modalized body.
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('presentation')).toBeNull()
  })

  it('renders the heading at the requested level (a page uses h2)', async () => {
    stubDownload(new Uint8Array([1, 2, 3]).buffer)
    render(
      <GfsImagePreviewBody
        byteLength={3}
        fileName="diagram.PNG"
        gfsUri="gfs://main/image-1"
        mimeType="image/png"
        headingLevel={2}
      />
    )
    expect(await screen.findByRole('heading', { name: 'diagram.PNG', level: 2 })).toBeTruthy()
  })

  it('rejects an oversized image from metadata before downloading', async () => {
    const download = stubDownload(new Uint8Array([1]).buffer)
    render(
      <GfsImagePreviewBody
        byteLength={GFS_IMAGE_PREVIEW_MAX_BYTES + 1}
        fileName="oversized.png"
        gfsUri="gfs://main/oversized"
        mimeType="image/png"
      />
    )
    expect(await screen.findByText(/Image previews are limited to 10 MB/)).toBeTruthy()
    expect(download).not.toHaveBeenCalled()
  })

  it('fails closed on a download error: shows the reason and notifies onDownloadError', async () => {
    const onDownloadError = vi.fn()
    const download = vi.fn(async () => {
      throw new Error('403 Forbidden')
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { gfs: { download } },
    })

    render(
      <GfsImagePreviewBody
        byteLength={3}
        fileName="secret.png"
        gfsUri="gfs://main/secret"
        mimeType="image/png"
        onDownloadError={onDownloadError}
      />
    )

    expect(await screen.findByText('403 Forbidden')).toBeTruthy()
    expect(screen.queryByAltText('Preview of secret.png')).toBeNull()
    await waitFor(() => expect(onDownloadError).toHaveBeenCalled())
  })

  it('renders the copy affordance in the header', async () => {
    stubDownload(new Uint8Array([1, 2, 3]).buffer)
    render(
      <GfsImagePreviewBody
        byteLength={3}
        fileName="diagram.PNG"
        gfsUri="gfs://main/image-1"
        mimeType="image/png"
      />
    )
    const copyButton = await screen.findByRole('button', { name: /Copy image to clipboard/i })
    expect(copyButton.textContent).toContain('Copy')
  })
})
