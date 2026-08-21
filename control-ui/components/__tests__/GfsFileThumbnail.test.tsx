import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { GfsFileThumbnail } from '../GfsFileThumbnail'
import { ToastProvider } from '../Toast'

const mockGfsFetchFileBlob = vi.fn()
const mockCreateObjectUrl = vi.fn(() => 'blob:gfs-thumbnail')
const mockRevokeObjectUrl = vi.fn()

vi.mock('@lib/api', () => ({
  gfsFetchFileBlob: (...args: unknown[]) => mockGfsFetchFileBlob(...args),
}))

function renderThumb(props: Parameters<typeof GfsFileThumbnail>[0]) {
  return render(
    <ToastProvider>
      <GfsFileThumbnail {...props} />
    </ToastProvider>
  )
}

describe('GfsFileThumbnail', () => {
  beforeEach(() => {
    mockGfsFetchFileBlob.mockReset()
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
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the inline image glyph for files larger than the thumbnail budget', () => {
    renderThumb({
      byteLength: 2 * 1024 * 1024,
      fileName: 'big.png',
      rid: 'r-big',
    })
    expect(screen.queryByRole('img')).toBeNull()
    expect(mockGfsFetchFileBlob).not.toHaveBeenCalled()
  })

  it('renders an <img> with the resolved blob URL once the proxy returns the bytes', async () => {
    mockGfsFetchFileBlob.mockResolvedValueOnce(new Blob(['fake-image-bytes']))
    renderThumb({
      byteLength: 64 * 1024,
      fileName: 'logo.png',
      rid: 'r-logo',
    })

    const img = await screen.findByAltText('Thumbnail of logo.png')
    expect(img.tagName).toBe('IMG')
    expect(img).toHaveAttribute('src', 'blob:gfs-thumbnail')
    expect(mockCreateObjectUrl).toHaveBeenCalledTimes(1)
  })

  it('rewraps the blob with image/svg+xml when the proxy returns SVG bytes', async () => {
    const svgBytes = new Blob(['<svg></svg>'], { type: 'application/octet-stream' })
    mockGfsFetchFileBlob.mockResolvedValueOnce(svgBytes)
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

  it('falls back to the image glyph when the proxy fetch rejects', async () => {
    mockGfsFetchFileBlob.mockRejectedValueOnce(new Error('boom'))
    renderThumb({
      byteLength: 64 * 1024,
      fileName: 'logo.png',
      rid: 'r-logo',
    })

    await waitFor(() => expect(mockGfsFetchFileBlob).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('img')).toBeNull()
    expect(mockCreateObjectUrl).not.toHaveBeenCalled()
  })
})
