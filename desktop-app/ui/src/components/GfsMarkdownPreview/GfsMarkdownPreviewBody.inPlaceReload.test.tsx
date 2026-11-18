// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import {
  downloadResult,
  resolveDeniedMessage,
  resolvedFile,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { GfsMarkdownPreviewBody } from './Body'

const URI = 'gfs://main/notes'

type Download = Awaited<ReturnType<typeof downloadResult>>

// Every download is a deferred the test settles explicitly, so the order in
// which concurrent downloads finish is under the test's control.
function stubDeferredDownloads() {
  const pending: Array<{ resolve: (value: Download) => void; reject: (error: unknown) => void }> =
    []
  const downloadPreview = vi.fn(
    () =>
      new Promise<Download>((resolve, reject) => {
        pending.push({ resolve, reject })
      })
  )
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: { gfs: { downloadPreview } },
  })
  return { downloadPreview, pending }
}

// Bytes travel through the real GfsClient download producer (T1).
async function markdownDownload(text: string): Promise<Download> {
  const bytes = new TextEncoder().encode(text).buffer as ArrayBuffer
  return downloadResult(
    resolvedFile('notes', 'notes.md', { gfsUri: URI, bytes: bytes.byteLength }),
    bytes
  )
}

function scrollRegion(container: HTMLElement): HTMLElement {
  const region = container.querySelector('.da-gfs-markdown-preview-dialog__body')
  if (!(region instanceof HTMLElement)) throw new Error('markdown scroll region is missing')
  return region
}

function renderBody(contentVersion: number, onDownloadError = vi.fn()) {
  const element = (version: number) => (
    <GfsMarkdownPreviewBody
      byteLength={64}
      contentVersion={version}
      fileName="notes.md"
      gfsUri={URI}
      onDownloadError={onDownloadError}
    />
  )
  const view = render(element(contentVersion))
  return { ...view, bump: (version: number) => view.rerender(element(version)), onDownloadError }
}

describe('GfsMarkdownPreviewBody in-place reload', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('keeps the rendered source and scroll position while a newer version downloads', async () => {
    const { pending, downloadPreview } = stubDeferredDownloads()
    const view = renderBody(3)
    await act(async () => pending[0]!.resolve(await markdownDownload('# Version 3')))
    expect(await screen.findByRole('heading', { name: 'Version 3', level: 1 })).toBeTruthy()

    const region = scrollRegion(view.container)
    region.scrollTop = 120
    view.bump(4)

    await waitFor(() => expect(downloadPreview).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('Loading preview…')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Version 3', level: 1 })).toBeTruthy()

    await act(async () => pending[1]!.resolve(await markdownDownload('# Version 4')))
    expect(await screen.findByRole('heading', { name: 'Version 4', level: 1 })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Version 3', level: 1 })).toBeNull()
    expect(scrollRegion(view.container)).toBe(region)
    expect(region.scrollTop).toBe(120)
  })

  it('discards an older download that finishes after a newer one', async () => {
    const { pending } = stubDeferredDownloads()
    const view = renderBody(3)
    await act(async () => pending[0]!.resolve(await markdownDownload('# Version 3')))
    await screen.findByRole('heading', { name: 'Version 3', level: 1 })

    view.bump(4)
    view.bump(5)
    await waitFor(() => expect(pending).toHaveLength(3))
    await act(async () => pending[2]!.resolve(await markdownDownload('# Version 5')))
    expect(await screen.findByRole('heading', { name: 'Version 5', level: 1 })).toBeTruthy()
    await act(async () => pending[1]!.resolve(await markdownDownload('# Version 4')))

    expect(screen.getByRole('heading', { name: 'Version 5', level: 1 })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Version 4', level: 1 })).toBeNull()
  })

  it('keeps the previous content and flags the failed update when an in-place download fails', async () => {
    const { pending } = stubDeferredDownloads()
    const view = renderBody(3)
    await act(async () => pending[0]!.resolve(await markdownDownload('# Version 3')))
    await screen.findByRole('heading', { name: 'Version 3', level: 1 })

    view.bump(4)
    await waitFor(() => expect(pending).toHaveLength(2))
    const denied = new Error(await resolveDeniedMessage(URI))
    await act(async () => pending[1]!.reject(denied))

    expect(await screen.findByText(/Could not update the preview/)).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Version 3', level: 1 })).toBeTruthy()
    // The session-authority hook still sees every download failure.
    expect(view.onDownloadError).toHaveBeenCalledWith(denied)

    view.bump(5)
    await waitFor(() => expect(pending).toHaveLength(3))
    await act(async () => pending[2]!.resolve(await markdownDownload('# Version 5')))
    expect(await screen.findByRole('heading', { name: 'Version 5', level: 1 })).toBeTruthy()
    expect(screen.queryByText(/Could not update the preview/)).toBeNull()
  })

  it("never shows one file's text while a different gfsUri loads in the same body", async () => {
    const { pending } = stubDeferredDownloads()
    const element = (gfsUri: string) => (
      <GfsMarkdownPreviewBody
        byteLength={64}
        contentVersion={1}
        fileName="notes.md"
        gfsUri={gfsUri}
      />
    )
    const view = render(element(URI))
    await act(async () => pending[0]!.resolve(await markdownDownload('# Private notes')))
    await screen.findByRole('heading', { name: 'Private notes', level: 1 })

    view.rerender(element('gfs://main/other'))
    await waitFor(() => expect(pending).toHaveLength(2))
    expect(screen.queryByRole('heading', { name: 'Private notes', level: 1 })).toBeNull()
    expect(screen.getByText('Loading preview…')).toBeTruthy()
  })

  it('clears a first-load error once a later version downloads', async () => {
    const { pending } = stubDeferredDownloads()
    const view = renderBody(3)
    await act(async () => pending[0]!.reject(new Error(await resolveDeniedMessage(URI))))
    expect(await screen.findByText(/forbidden|not authorized/i)).toBeTruthy()
    expect(screen.queryByText(/Could not update the preview/)).toBeNull()

    view.bump(4)
    await waitFor(() => expect(pending).toHaveLength(2))
    await act(async () => pending[1]!.resolve(await markdownDownload('# Version 4')))

    expect(await screen.findByRole('heading', { name: 'Version 4', level: 1 })).toBeTruthy()
    expect(screen.queryByText(/forbidden|not authorized/i)).toBeNull()
  })

  it('drops the previous content when an in-place download fails with a rejected session', async () => {
    const { pending } = stubDeferredDownloads()
    const view = renderBody(3)
    await act(async () => pending[0]!.resolve(await markdownDownload('# Version 3')))
    await screen.findByRole('heading', { name: 'Version 3', level: 1 })

    view.bump(4)
    await waitFor(() => expect(pending).toHaveLength(2))
    const sessionRejected = await resolveDeniedMessage(
      URI,
      { code: 'unauthorized', message: 'not authenticated' },
      401
    )
    await act(async () => pending[1]!.reject(new Error(sessionRejected)))

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Version 3', level: 1 })).toBeNull()
    )
    expect(screen.queryByText(/Could not update the preview/)).toBeNull()
  })
})
