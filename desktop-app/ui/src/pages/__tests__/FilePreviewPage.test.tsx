// @vitest-environment jsdom
import { useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { buildGfsResourceWebLink } from '@clerum/desktop-app-links'
import { EntityChangeRegistry } from '@lib/entityChangeRegistry'
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

function openPreviewActions(fileName: string) {
  const heading = screen.getByRole('heading', { name: fileName, level: 2 })
  const titleRow = heading.closest('.da-gfs-preview-title-row')
  if (!titleRow) throw new Error(`Preview title actions are unavailable for ${fileName}`)
  fireEvent.click(
    within(titleRow as HTMLElement).getByRole('button', { name: `Options for ${fileName}` })
  )
  return screen.getByRole('menu', { name: `Actions for ${fileName}` })
}

function clickPreviewAction(fileName: string, actionName: string) {
  const menu = openPreviewActions(fileName)
  fireEvent.click(within(menu).getByRole('menuitem', { name: actionName }))
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
        onOpenRoute={() => undefined}
      />
    )

    expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
    // The preview page title is a page-level h2 (not a dialog h3).
    const title = screen.getByRole('heading', { name: 'diagram.png', level: 2 })
    expect(title).toBeTruthy()
    const titleRow = title.closest('.da-gfs-preview-title-row')
    expect(titleRow).toBeTruthy()
    fireEvent.click(
      within(titleRow as HTMLElement).getByRole('button', { name: 'Options for diagram.png' })
    )
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'Refresh',
      'Copy link',
      'Copy route',
      'Open route',
      'Copy content',
    ])
    expect(screen.queryByRole('dialog')).toBeNull()
    const menu = screen.getByRole('menu', { name: 'Actions for diagram.png' })
    expect(within(menu).getByRole('menuitem', { name: 'Refresh' })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: 'Copy link' })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: 'Copy route' })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: 'Open route' })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: 'Copy content' })).toBeTruthy()
  })

  it('keeps preview actions beside the filename without populating the navbar slot', async () => {
    hookMock.useGfsBrowserController.mockReturnValue(controller())
    stubDownload(async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer }))
    const titlebarLeadingRoot = document.createElement('div')
    document.body.appendChild(titlebarLeadingRoot)

    const view = render(
      <FilePreviewPage
        gfsUri="gfs://main/image-1"
        fileName="diagram.png"
        fileKind="image"
        byteLength={3}
        titlebarLeadingTarget={titlebarLeadingRoot}
      />
    )

    try {
      expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
      expect(within(titlebarLeadingRoot).queryByRole('toolbar')).toBeNull()
      const menu = openPreviewActions('diagram.png')
      expect(within(menu).getByRole('menuitem', { name: 'Copy link' })).toBeTruthy()
    } finally {
      view.unmount()
      titlebarLeadingRoot.remove()
    }
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
        onOpenRoute={() => undefined}
      />
    )

    expect(await screen.findByLabelText('Video preview of demo.mp4')).toBeTruthy()
    const menu = openPreviewActions('demo.mp4')
    expect(within(menu).queryByRole('menuitem', { name: 'Copy content' })).toBeNull()
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map(item => item.textContent)
    ).toEqual(['Refresh', 'Copy link', 'Copy route', 'Open route'])
  })

  it('uses the shareable link, canonical route, and preview copy semantics from the filename menu', async () => {
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    const markdown = '# Hello\n\nText to copy.'
    const copyDeepLink = vi.fn(async () => ({
      url: buildGfsResourceWebLink('https://profile.example', uri),
    }))
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          copyDeepLink,
          downloadPreview: vi.fn(async () => ({
            bytes: new TextEncoder().encode(markdown).buffer,
          })),
          resolve: vi.fn(async () => ({ kind: 'file' })),
        },
      },
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    hookMock.useGfsBrowserController.mockReturnValue(controller())

    render(
      <FilePreviewPage
        gfsUri={uri}
        fileName="Résumé # ? %.md"
        fileKind="markdown"
        byteLength={markdown.length}
      />
    )

    await screen.findByRole('heading', { name: 'Hello' })
    clickPreviewAction('Résumé # ? %.md', 'Copy link')
    clickPreviewAction('Résumé # ? %.md', 'Copy route')
    const menu = openPreviewActions('Résumé # ? %.md')
    const copyContent = within(menu).getByRole('menuitem', { name: 'Copy content' })
    await waitFor(() => expect((copyContent as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(copyContent)

    await waitFor(() => expect(copyDeepLink).toHaveBeenCalledWith(uri))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(uri))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(markdown))
  })

  it('copies the loaded image bytes through the filename menu', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    hookMock.useGfsBrowserController.mockReturnValue(controller())
    stubGfs({
      downloadPreview: async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer }),
      resolve: async () => ({ kind: 'file' }),
    })

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
    const menu = openPreviewActions('diagram.png')
    const copyContent = within(menu).getByRole('menuitem', { name: 'Copy content' })
    await waitFor(() => expect((copyContent as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(copyContent)

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('data:image/png;base64,AQID'))
  })

  it('refreshes by revalidating and reloading the exact preview resource', async () => {
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    let downloadNumber = 0
    const { downloadPreview, resolve } = stubGfs({
      downloadPreview: async () => ({
        bytes: new TextEncoder().encode(`# Load ${++downloadNumber}`).buffer,
      }),
      resolve: async () => ({ kind: 'file' }),
    })
    hookMock.useGfsBrowserController.mockReturnValue(controller())

    render(<FilePreviewPage gfsUri={uri} fileName="report.md" fileKind="markdown" byteLength={7} />)

    expect(await screen.findByRole('heading', { name: 'Load 1' })).toBeTruthy()
    clickPreviewAction('report.md', 'Refresh')

    await waitFor(() => expect(resolve).toHaveBeenCalledWith(uri))
    expect(await screen.findByRole('heading', { name: 'Load 2' })).toBeTruthy()
    expect(downloadPreview).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('heading', { name: 'report.md', level: 2 })).toBeTruthy()
  })

  it('omits Refresh while the preview is unavailable', () => {
    hookMock.useGfsBrowserController.mockReturnValue(controller())
    render(
      <FilePreviewPage
        gfsUri="gfs://main/secret"
        fileName="secret.png"
        fileKind="image"
        byteLength={3}
        unavailable
      />
    )

    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull()
  })

  // R-4 (spec 18 §3.B.5): the preview tab must NOT close when access is revoked;
  // stale bytes are purged and replaced by a non-sensitive unavailable shell.
  it('purges the open preview when authority reports a revoked resource', async () => {
    const downloadPreview = stubDownload(async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer }))
    const controllerState = controller('active')
    hookMock.useGfsBrowserController.mockReturnValue(controllerState)

    // A fresh element per render pass so the authority update is observed.
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
    controllerState.accessState = 'revoked'
    rerender(makeElement())

    // The tab stays mounted, but sensitive preview bytes, filename, and denial
    // details are removed when authorization is no longer available.
    await waitFor(() => expect(screen.queryByAltText('Preview of secret.png')).toBeNull())
    expect(await screen.findByRole('heading', { name: 'File unavailable', level: 3 })).toBeTruthy()
    expect(screen.queryByText('403 Forbidden')).toBeNull()
    expect(screen.queryByText('secret.png')).toBeNull()
    expect(downloadPreview).toHaveBeenCalledTimes(1)
  })

  it('purges image bytes and its object URL on session expiry through the entity registry', async () => {
    hookMock.useGfsBrowserController.mockReturnValue(controller())
    stubDownload(async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer }))
    const registry = new EntityChangeRegistry()

    function SessionAwarePreview() {
      const [unavailable, setUnavailable] = useState(false)
      useEffect(() => registry.subscribe(['gfs', 'authorization'], () => setUnavailable(true)), [])
      return (
        <FilePreviewPage
          gfsUri="gfs://main/session-expired"
          fileName="session-secret.png"
          fileKind="image"
          mimeType="image/png"
          byteLength={3}
          unavailable={unavailable}
        />
      )
    }

    render(<SessionAwarePreview />)
    expect(await screen.findByAltText('Preview of session-secret.png')).toBeTruthy()

    act(() =>
      registry.dispatch({
        type: 'stream.closing',
        schemaVersion: 1,
        cursor: '00000000-0000-0000-0000-000000000001',
        reason: 'session_expired',
      })
    )

    expect(await screen.findByRole('heading', { name: 'File unavailable', level: 3 })).toBeTruthy()
    expect(screen.queryByAltText('Preview of session-secret.png')).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:gfs-preview')
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
    const menuBefore = openPreviewActions('secret.png')
    const copyBefore = within(menuBefore).getByRole('menuitem', { name: 'Copy content' })
    await waitFor(() => expect((copyBefore as HTMLButtonElement).disabled).toBe(false))

    // The file is unshared out-of-band → the next focus re-check 403s.
    fireEvent.focus(window)

    // The image, Copy affordance, filename, and denial details are gone; the
    // tab remains mounted behind a generic unavailable shell.
    await waitFor(() => expect(screen.queryByAltText('Preview of secret.png')).toBeNull())
    expect(screen.queryByRole('button', { name: 'Options for secret.png' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Copy content' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'File unavailable', level: 3 })).toBeTruthy()
    expect(screen.queryByText(deniedMessage)).toBeNull()
    expect(screen.queryByText('secret.png')).toBeNull()
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
