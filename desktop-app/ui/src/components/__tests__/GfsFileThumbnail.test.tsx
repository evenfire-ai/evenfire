// @vitest-environment jsdom
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { clearCachedGfsBlob } from '@lib/gfsBlobCache'
import { GfsFileThumbnail } from '../GfsFileThumbnail'

const mockDownload = vi.fn()
const mockCreateObjectUrl = vi.fn(() => 'blob:gfs-thumbnail')
const mockRevokeObjectUrl = vi.fn()

function renderThumb(props: Parameters<typeof GfsFileThumbnail>[0]) {
  return render(<GfsFileThumbnail {...props} />)
}

describe('GfsFileThumbnail', () => {
  beforeEach(() => {
    mockDownload.mockReset()
    clearCachedGfsBlob('r-logo')
    clearCachedGfsBlob('r-svg')
    mockCreateObjectUrl.mockReset()
    mockCreateObjectUrl.mockReturnValue('blob:gfs-thumbnail')
    mockRevokeObjectUrl.mockReset()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: mockCreateObjectUrl,
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: mockRevokeObjectUrl,
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { gfs: { download: mockDownload } },
    })
  })

  afterEach(async () => {
    cleanup()
    await new Promise(resolve => setTimeout(resolve, 0))
    vi.restoreAllMocks()
  })

  it('renders the inline image glyph when the file exceeds the thumbnail budget', () => {
    renderThumb({
      byteLength: 2 * 1024 * 1024,
      fileName: 'big.png',
      rid: 'r-big',
    })
    expect(screen.queryByRole('img')).toBeNull()
    expect(mockDownload).not.toHaveBeenCalled()
  })

  it('renders an <img> with the resolved blob URL once the download returns', async () => {
    mockDownload.mockResolvedValueOnce({ bytes: new Uint8Array([1, 2, 3, 4]).buffer })
    renderThumb({
      byteLength: 64 * 1024,
      fileName: 'logo.png',
      rid: 'r-logo',
    })

    const img = await screen.findByAltText('Thumbnail of logo.png')
    expect(img.tagName).toBe('IMG')
    expect(img.getAttribute('src')).toBe('blob:gfs-thumbnail')
    expect(mockCreateObjectUrl).toHaveBeenCalledTimes(1)
  })

  it('releases the cached URL when the row unmounts so a remount fetches again', async () => {
    mockDownload.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3, 4]).buffer })
    const firstRender = renderThumb({
      byteLength: 64 * 1024,
      fileName: 'logo.png',
      rid: 'r-remount',
    })

    await screen.findByAltText('Thumbnail of logo.png')
    firstRender.unmount()

    renderThumb({
      byteLength: 64 * 1024,
      fileName: 'logo.png',
      rid: 'r-remount',
    })

    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(2))
    expect(mockRevokeObjectUrl).toHaveBeenCalledWith('blob:gfs-thumbnail')
  })

  it('rewraps the blob with image/svg+xml when the download returns SVG bytes', async () => {
    const svgBytes = new TextEncoder().encode('<svg></svg>').buffer
    mockDownload.mockResolvedValueOnce({ bytes: svgBytes })
    renderThumb({
      byteLength: 64 * 1024,
      fileName: 'logo.svg',
      rid: 'r-svg',
    })

    await screen.findByAltText('Thumbnail of logo.svg')
    expect(mockCreateObjectUrl).toHaveBeenCalledTimes(1)
    const blobArg = mockCreateObjectUrl.mock.calls[0]?.[0] as Blob
    expect(blobArg.type).toBe('image/svg+xml')
  })

  it('falls back to the image glyph when the download rejects', async () => {
    let rejectDownload: (() => void) | undefined
    const slowDownload = new Promise<{ bytes: ArrayBuffer }>((_, reject) => {
      rejectDownload = () => reject(new Error('boom'))
    })
    mockDownload.mockReturnValueOnce(slowDownload)
    renderThumb({
      byteLength: 64 * 1024,
      fileName: 'logo.png',
      rid: 'r-logo',
    })

    await waitFor(() => expect(mockDownload).toHaveBeenCalledTimes(1))
    rejectDownload?.()
    await waitFor(() => expect(mockCreateObjectUrl).not.toHaveBeenCalled())
    expect(screen.queryByAltText('Thumbnail of logo.png')).toBeNull()
  })
})
