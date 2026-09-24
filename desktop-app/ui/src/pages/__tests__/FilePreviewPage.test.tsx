// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { resolveDeniedMessage } from '@/gfs/__fixtures__/gfsProducerFixtures'
import { FilePreviewPage } from '../FilePreviewPage'

const hookMock = vi.hoisted(() => ({
  useGfsBrowserController: vi.fn(),
}))

vi.mock('@hooks/domain/useGfsBrowserController', () => hookMock)

function controller(
  accessState: 'active' | 'revoked' = 'active',
  handleAuthorityFailure: (message: string, surface?: 'discovery' | 'operation') => boolean = () =>
    false
) {
  return {
    accessState,
    handleAuthorityFailure: vi.fn(handleAuthorityFailure),
  }
}

// The producer (`window.clerum.gfs.downloadPreview`) returns `{ bytes: ArrayBuffer }`.
function stubDownload(impl: () => Promise<{ bytes: ArrayBuffer }>) {
  const downloadPreview = vi.fn(impl)
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: { gfs: { downloadPreview } },
  })
  return downloadPreview
}

// Preview + the per-resource re-check primitive (`gfs.resolve`) the focus
// revalidation calls. `resolve` rejects to model an unshared resource.
function stubGfs(opts: {
  downloadPreview: () => Promise<{ bytes: ArrayBuffer }>
  resolve: () => Promise<unknown>
}) {
  const downloadPreview = vi.fn(opts.downloadPreview)
  const resolve = vi.fn(opts.resolve)
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: { gfs: { downloadPreview, resolve } },
  })
  return { downloadPreview, resolve }
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
    const downloadPreview = stubDownload(async () => {
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
    expect(downloadPreview).toHaveBeenCalledTimes(1)

    // Access is revoked out-of-band → the authority controller reports revoked.
    revoked = true
    controllerState.accessState = 'revoked'
    rerender(makeElement())

    // The tab stays mounted (heading still present) but the stale image is gone
    // and the revoke reason is shown — no accessible content survives the revoke.
    await waitFor(() => expect(screen.queryByAltText('Preview of secret.png')).toBeNull())
    expect(await screen.findByText('403 Forbidden')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'secret.png', level: 2 })).toBeTruthy()
    expect(downloadPreview).toHaveBeenCalledTimes(2)
  })

  // R1-H6: a persistent preview tab outlives the grant that opened it. A
  // per-RESOURCE unshare (gfs.read now 403s for THIS file, session still valid)
  // must drop the rendered bytes and the Copy affordance on window focus WITHOUT
  // a tab switch/remount — otherwise the image stays on screen and Copy keeps
  // writing the PNG. This is distinct from the session-401 path (H2) above.
  it('drops the previewed bytes and Copy on focus when the resource is unshared (R1-H6)', async () => {
    // Producer-derived denial: the exact ApiError message resolve rejects with
    // for a per-resource 403 (T1 — not a hand-written string).
    const deniedMessage = await resolveDeniedMessage('gfs://main/secret')

    const controllerState = controller('active')
    hookMock.useGfsBrowserController.mockReturnValue(controllerState)
    const { resolve } = stubGfs({
      downloadPreview: async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer }),
      resolve: async () => {
        throw new Error(deniedMessage)
      },
    })

    render(
      <FilePreviewPage
        gfsUri="gfs://main/secret"
        fileName="secret.png"
        fileKind="image"
        mimeType="image/png"
        byteLength={3}
      />
    )

    // The bytes load and Copy is enabled.
    expect(await screen.findByAltText('Preview of secret.png')).toBeTruthy()
    const copyBefore = screen.getByRole('button', { name: 'Copy image to clipboard' })
    expect((copyBefore as HTMLButtonElement).disabled).toBe(false)

    // The file is unshared out-of-band → the next focus re-check 403s.
    fireEvent.focus(window)

    // The image AND the Copy affordance are gone (observable UI — T4), the
    // denial reason renders, and the tab was never remounted.
    await waitFor(() => expect(screen.queryByAltText('Preview of secret.png')).toBeNull())
    expect(screen.queryByRole('button', { name: 'Copy image to clipboard' })).toBeNull()
    expect(screen.getByText(deniedMessage)).toBeTruthy()
    expect(resolve).toHaveBeenCalledWith('gfs://main/secret')
    // A per-resource 403 is NOT a session-authority failure: it was routed
    // through handleAuthorityFailure (which declined) and did not revoke.
    expect(controllerState.handleAuthorityFailure).toHaveReturnedWith(false)
  })

  // H2 no-regress: a SESSION-authority failure discovered by the focus re-check
  // must route to the shared session revoke, NOT to the local per-resource
  // denied state (the two cases stay distinct).
  it('routes a session-authority failure on focus to the shared revoke, not local denial', async () => {
    const sessionMessage = await resolveDeniedMessage(
      'gfs://main/secret',
      { code: 'unauthorized', message: 'not authenticated' },
      401
    )

    // The controller classifies this as a session-authority failure (revokes).
    const controllerState = controller('active', () => true)
    hookMock.useGfsBrowserController.mockReturnValue(controllerState)
    stubGfs({
      downloadPreview: async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer }),
      resolve: async () => {
        throw new Error(sessionMessage)
      },
    })

    render(
      <FilePreviewPage
        gfsUri="gfs://main/secret"
        fileName="secret.png"
        fileKind="image"
        mimeType="image/png"
        byteLength={3}
      />
    )

    expect(await screen.findByAltText('Preview of secret.png')).toBeTruthy()

    fireEvent.focus(window)

    await waitFor(() =>
      expect(controllerState.handleAuthorityFailure).toHaveBeenCalledWith(
        sessionMessage,
        'operation'
      )
    )
    // The session path handled it; the local per-resource denial did NOT fire.
    expect(controllerState.handleAuthorityFailure).toHaveReturnedWith(true)
    expect(screen.queryByText('You no longer have access to this file')).toBeNull()
  })
})
