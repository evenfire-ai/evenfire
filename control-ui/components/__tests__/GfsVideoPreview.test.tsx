import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { GfsVideoPreview } from '../GfsVideoPreview'
import { ToastProvider } from '../Toast'

const mockGfsFetchFileBlob = vi.fn()
const mockCreateObjectUrl = vi.fn((blob: Blob) => `blob:${blob.type}-preview`)
const mockRevokeObjectUrl = vi.fn()

vi.mock('@lib/api', () => ({
  gfsFetchFileBlob: (...args: unknown[]) => mockGfsFetchFileBlob(...args),
}))

function renderVideoPreview(props: Parameters<typeof GfsVideoPreview>[0]) {
  return render(
    <ToastProvider>
      <GfsVideoPreview {...props} />
    </ToastProvider>
  )
}

describe('GfsVideoPreview', () => {
  beforeEach(() => {
    mockGfsFetchFileBlob.mockReset()
    mockCreateObjectUrl.mockReset()
    mockCreateObjectUrl.mockReturnValue('blob:video-preview')
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

  it('renders a video element with the file as a Blob URL and frees it on close', async () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
    mockGfsFetchFileBlob.mockResolvedValueOnce(new Blob([bytes], { type: 'video/mp4' }))

    const { unmount } = renderVideoPreview({
      byteLength: 4096,
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
      onClose: vi.fn(),
      rid: 'r-clip',
    })

    expect(await screen.findByLabelText('Video preview of clip.mp4')).toBeTruthy()
    expect(mockGfsFetchFileBlob).toHaveBeenCalledWith('r-clip')
    expect(mockCreateObjectUrl).toHaveBeenCalledTimes(1)
    const blobArg = mockCreateObjectUrl.mock.calls[0]?.[0] as Blob
    expect(blobArg.type).toBe('video/mp4')

    unmount()
    expect(mockRevokeObjectUrl).toHaveBeenCalledWith('blob:video-preview')
  })

  it('rejects oversized videos before downloading them', async () => {
    renderVideoPreview({
      byteLength: 200 * 1024 * 1024,
      fileName: 'huge.mp4',
      mimeType: 'video/mp4',
      onClose: vi.fn(),
      rid: 'r-huge',
    })

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Video previews are limited to 100 MB'
    )
    expect(mockGfsFetchFileBlob).not.toHaveBeenCalled()
  })

  it('falls back to a friendly error when the browser cannot decode the video', async () => {
    mockGfsFetchFileBlob.mockResolvedValueOnce(
      new Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' })
    )

    renderVideoPreview({
      byteLength: 1024,
      fileName: 'broken.mp4',
      mimeType: 'video/mp4',
      onClose: vi.fn(),
      rid: 'r-broken',
    })

    const video = await screen.findByLabelText('Video preview of broken.mp4')
    fireEvent.error(video)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This video could not be played by your browser'
    )
  })

  it('escapes the modal when Escape is pressed', async () => {
    const onClose = vi.fn()
    mockGfsFetchFileBlob.mockResolvedValueOnce(
      new Blob([new Uint8Array([1])], { type: 'video/mp4' })
    )

    renderVideoPreview({
      byteLength: 1024,
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
      onClose,
      rid: 'r-clip',
    })

    await screen.findByLabelText('Video preview of clip.mp4')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
