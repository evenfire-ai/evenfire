// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { FilePreviewPage } from '../FilePreviewPage'

const hookMock = vi.hoisted(() => ({
  useGfsBrowserController: vi.fn(),
}))

vi.mock('@hooks/domain/useGfsBrowserController', () => hookMock)

function controller(accessState: 'active' | 'revoked' = 'active') {
  return {
    accessState,
    handleAuthorityFailure: vi.fn(() => false),
  }
}

// The producer (`window.clerum.gfs.download`) returns `{ bytes: ArrayBuffer }`.
function stubDownload(impl: () => Promise<{ bytes: ArrayBuffer }>) {
  const download = vi.fn(impl)
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: { gfs: { download } },
  })
  return download
}

describe('FilePreviewPage', () => {
  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:gfs-preview'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('mounts the image body for an image preview tab', async () => {
    hookMock.useGfsBrowserController.mockReturnValue(controller())
    stubDownload(async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer }))

    render(
      <FilePreviewPage
        gfsUri="gfs://main/image-1"
        fileName="diagram.png"
        fileKind="image"
        mimeType="image/png"
        byteLength={3}
      />
    )

    expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
    // The preview page title is a page-level h2 (not a dialog h3).
    expect(screen.getByRole('heading', { name: 'diagram.png', level: 2 })).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('mounts the markdown body for a markdown preview tab', async () => {
    hookMock.useGfsBrowserController.mockReturnValue(controller())
    stubDownload(async () => ({ bytes: new TextEncoder().encode('# Hi').buffer }))

    render(
      <FilePreviewPage
        gfsUri="gfs://main/md-1"
        fileName="README.md"
        fileKind="markdown"
        byteLength={4}
      />
    )

    expect(await screen.findByRole('heading', { name: 'Hi', level: 1 })).toBeTruthy()
  })

  it('mounts the video body for a video preview tab', async () => {
    hookMock.useGfsBrowserController.mockReturnValue(controller())
    stubDownload(async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer }))

    render(
      <FilePreviewPage
        gfsUri="gfs://main/video-1"
        fileName="demo.mp4"
        fileKind="video"
        mimeType="video/mp4"
        byteLength={3}
      />
    )

    expect(await screen.findByLabelText('Video preview of demo.mp4')).toBeTruthy()
  })

  // R-4 (spec 18 §3.B.5): the preview tab must NOT close when access is revoked;
  // the revocation signal re-fetches the body so stale bytes are replaced by the
  // fail-closed error. Here the second fetch (after revocation) returns 403.
  it('re-fetches and fails closed when authority is revoked while the tab is mounted', async () => {
    let revoked = false
    const download = stubDownload(async () => {
      if (revoked) throw new Error('403 Forbidden')
      return { bytes: new Uint8Array([1, 2, 3]).buffer }
    })
    const controllerState = controller('active')
    hookMock.useGfsBrowserController.mockReturnValue(controllerState)

    // A fresh element per render pass so the mutated mock is observed.
    const makeElement = () => (
      <FilePreviewPage
        gfsUri="gfs://main/secret"
        fileName="secret.png"
        fileKind="image"
        mimeType="image/png"
        byteLength={3}
      />
    )
    const { rerender } = render(makeElement())

    // First fetch succeeds and the image renders.
    expect(await screen.findByAltText('Preview of secret.png')).toBeTruthy()
    expect(download).toHaveBeenCalledTimes(1)

    // Access is revoked out-of-band → the authority controller reports revoked.
    revoked = true
    controllerState.accessState = 'revoked'
    rerender(makeElement())

    // The tab stays mounted (heading still present) but the stale image is gone
    // and the revoke reason is shown — no accessible content survives the revoke.
    await waitFor(() => expect(screen.queryByAltText('Preview of secret.png')).toBeNull())
    expect(await screen.findByText('403 Forbidden')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'secret.png', level: 2 })).toBeTruthy()
    expect(download).toHaveBeenCalledTimes(2)
  })
})
