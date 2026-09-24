// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { GFS_VIDEO_PREVIEW_MAX_BYTES } from '@constants/gfsVideoPreview'
import { GfsVideoPreviewBody } from './Body'

function stubDownload(bytes: ArrayBuffer) {
  const downloadPreview = vi.fn(async () => ({ bytes }))
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: { gfs: { downloadPreview } },
  })
  return downloadPreview
}

describe('GfsVideoPreviewBody', () => {
  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:gfs-video-preview'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('downloads by gfsUri and renders an HTML5 video without a modal', async () => {
    const createObjectURL = vi.fn(() => 'blob:gfs-video-preview')
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    const downloadPreview = stubDownload(new Uint8Array([1, 2, 3]).buffer)

    render(
      <GfsVideoPreviewBody
        byteLength={3}
        fileName="demo.mp4"
        gfsUri="gfs://main/video-1"
        mimeType="video/mp4"
      />
    )

    const video = await screen.findByLabelText('Video preview of demo.mp4')
    expect(video.tagName).toBe('VIDEO')
    expect(video.getAttribute('controls')).not.toBeNull()
    expect(video.getAttribute('src')).toBe('blob:gfs-video-preview')
    expect(createObjectURL).toHaveBeenCalledWith(expect.objectContaining({ type: 'video/mp4' }))
    expect(downloadPreview).toHaveBeenCalledWith('gfs://main/video-1', GFS_VIDEO_PREVIEW_MAX_BYTES)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('rejects an oversized video from metadata before downloading', async () => {
    const downloadPreview = stubDownload(new Uint8Array([1]).buffer)
    render(
      <GfsVideoPreviewBody
        byteLength={GFS_VIDEO_PREVIEW_MAX_BYTES + 1}
        fileName="oversized.mp4"
        gfsUri="gfs://main/oversized"
        mimeType="video/mp4"
      />
    )
    expect(await screen.findByText(/Video previews are limited to 100 MB/)).toBeTruthy()
    expect(downloadPreview).not.toHaveBeenCalled()
  })

  it('fails closed on a download error and notifies onDownloadError', async () => {
    const onDownloadError = vi.fn()
    const downloadPreview = vi.fn(async () => {
      throw new Error('403 Forbidden')
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { gfs: { downloadPreview } },
    })
    render(
      <GfsVideoPreviewBody
        byteLength={3}
        fileName="secret.mp4"
        gfsUri="gfs://main/secret"
        mimeType="video/mp4"
        onDownloadError={onDownloadError}
      />
    )
    expect(await screen.findByText('403 Forbidden')).toBeTruthy()
    await waitFor(() => expect(onDownloadError).toHaveBeenCalled())
  })
})
