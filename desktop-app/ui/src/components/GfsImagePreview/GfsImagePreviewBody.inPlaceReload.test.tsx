// @vitest-environment jsdom
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import {
  downloadResult,
  resolveDeniedMessage,
  resolvedFile,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { GfsImagePreviewBody } from './Body'
import { GfsImagePreview } from './index'

const URI = 'gfs://main/diagram'
const ALT = 'Preview of diagram.png'

type Download = Awaited<ReturnType<typeof downloadResult>>

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

async function imageDownload(seed: number): Promise<Download> {
  const bytes = new Uint8Array([seed, seed, seed]).buffer as ArrayBuffer
  return downloadResult(resolvedFile('diagram', 'diagram.png', { gfsUri: URI, bytes: 3 }), bytes)
}

let createdUrls: string[] = []
let revokeObjectURL: ReturnType<typeof vi.fn>

function imageSrc(): string | null {
  return screen.getByAltText(ALT).getAttribute('src')
}

describe('GfsImagePreviewBody in-place reload', () => {
  beforeEach(() => {
    createdUrls = []
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => {
        const url = `blob:gfs-image-${createdUrls.length + 1}`
        createdUrls.push(url)
        return url
      }),
    })
    revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  function renderBody(contentVersion: number) {
    const element = (version: number) => (
      <GfsImagePreviewBody
        byteLength={3}
        contentVersion={version}
        fileName="diagram.png"
        gfsUri={URI}
        mimeType="image/png"
      />
    )
    const view = render(element(contentVersion))
    return { ...view, bump: (version: number) => view.rerender(element(version)) }
  }

  it('keeps the visible object URL until the new version loads, then revokes only the old one', async () => {
    const { pending, downloadPreview } = stubDeferredDownloads()
    const view = renderBody(3)
    await act(async () => pending[0]!.resolve(await imageDownload(3)))
    await screen.findByAltText(ALT)
    expect(imageSrc()).toBe('blob:gfs-image-1')

    view.bump(4)
    await waitFor(() => expect(downloadPreview).toHaveBeenCalledTimes(2))
    expect(imageSrc()).toBe('blob:gfs-image-1')
    expect(screen.queryByText('Loading image preview…')).toBeNull()
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:gfs-image-1')

    await act(async () => pending[1]!.resolve(await imageDownload(4)))
    await waitFor(() => expect(imageSrc()).toBe('blob:gfs-image-2'))
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:gfs-image-1')
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:gfs-image-2')

    view.unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:gfs-image-2')
  })

  it('discards an older download that finishes after a newer one', async () => {
    const { pending } = stubDeferredDownloads()
    const view = renderBody(3)
    await act(async () => pending[0]!.resolve(await imageDownload(3)))
    await screen.findByAltText(ALT)

    view.bump(4)
    view.bump(5)
    await waitFor(() => expect(pending).toHaveLength(3))
    await act(async () => pending[2]!.resolve(await imageDownload(5)))
    await waitFor(() => expect(imageSrc()).toBe('blob:gfs-image-2'))
    await act(async () => pending[1]!.resolve(await imageDownload(4)))

    expect(imageSrc()).toBe('blob:gfs-image-2')
    expect(createdUrls).toEqual(['blob:gfs-image-1', 'blob:gfs-image-2'])
  })

  it('keeps the previous image and flags the failed update when an in-place download fails', async () => {
    const { pending } = stubDeferredDownloads()
    const view = renderBody(3)
    await act(async () => pending[0]!.resolve(await imageDownload(3)))
    await screen.findByAltText(ALT)

    view.bump(4)
    await waitFor(() => expect(pending).toHaveLength(2))
    await act(async () => pending[1]!.reject(new Error(await resolveDeniedMessage(URI))))

    expect(await screen.findByText(/Could not update the preview/)).toBeTruthy()
    expect(imageSrc()).toBe('blob:gfs-image-1')
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:gfs-image-1')

    view.bump(5)
    await waitFor(() => expect(pending).toHaveLength(3))
    await act(async () => pending[2]!.resolve(await imageDownload(5)))
    await waitFor(() => expect(imageSrc()).toBe('blob:gfs-image-2'))
    expect(screen.queryByText(/Could not update the preview/)).toBeNull()
  })

  it("never shows one file's image while a different gfsUri loads in the same body", async () => {
    const { pending } = stubDeferredDownloads()
    const element = (gfsUri: string) => (
      <GfsImagePreviewBody
        byteLength={3}
        contentVersion={1}
        fileName="diagram.png"
        gfsUri={gfsUri}
        mimeType="image/png"
      />
    )
    const view = render(element(URI))
    await act(async () => pending[0]!.resolve(await imageDownload(1)))
    await waitFor(() => expect(imageSrc()).toBe('blob:gfs-image-1'))

    view.rerender(element('gfs://main/other'))
    await waitFor(() => expect(pending).toHaveLength(2))
    expect(screen.queryByAltText(ALT)).toBeNull()
    expect(screen.getByText('Loading image preview…')).toBeTruthy()
  })

  it('reloads the modal preview in place when its reloadVersion changes', async () => {
    const { pending, downloadPreview } = stubDeferredDownloads()
    const element = (reloadVersion: number) => (
      <GfsImagePreview
        byteLength={3}
        fileName="diagram.png"
        gfsUri={URI}
        mimeType="image/png"
        onClose={() => undefined}
        reloadVersion={reloadVersion}
      />
    )
    const view = render(element(0))
    await act(async () => pending[0]!.resolve(await imageDownload(1)))
    await screen.findByAltText(ALT)

    view.rerender(element(1))
    await waitFor(() => expect(downloadPreview).toHaveBeenCalledTimes(2))
    expect(imageSrc()).toBe('blob:gfs-image-1')
    expect(revokeObjectURL).not.toHaveBeenCalled()

    await act(async () => pending[1]!.resolve(await imageDownload(2)))
    await waitFor(() => expect(imageSrc()).toBe('blob:gfs-image-2'))
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:gfs-image-1')
  })

  it('drops the previous content when an in-place download fails with a rejected session', async () => {
    const { pending } = stubDeferredDownloads()
    const view = renderBody(3)
    await act(async () => pending[0]!.resolve(await imageDownload(3)))
    await waitFor(() => expect(imageSrc()).toBe('blob:gfs-image-1'))

    view.bump(4)
    await waitFor(() => expect(pending).toHaveLength(2))
    const sessionRejected = await resolveDeniedMessage(
      URI,
      { code: 'unauthorized', message: 'not authenticated' },
      401
    )
    await act(async () => pending[1]!.reject(new Error(sessionRejected)))

    await waitFor(() => expect(screen.queryByAltText(ALT)).toBeNull())
    expect(screen.queryByText(/Could not update the preview/)).toBeNull()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:gfs-image-1')
  })

  it('clears a first-load error once a later version downloads', async () => {
    const { pending } = stubDeferredDownloads()
    const view = renderBody(3)
    await act(async () => pending[0]!.reject(new Error(await resolveDeniedMessage(URI))))
    expect(await screen.findByText(/forbidden|not authorized/i)).toBeTruthy()

    view.bump(4)
    await waitFor(() => expect(pending).toHaveLength(2))
    await act(async () => pending[1]!.resolve(await imageDownload(4)))

    await waitFor(() => expect(imageSrc()).toBe('blob:gfs-image-1'))
    expect(screen.queryByText(/forbidden|not authorized/i)).toBeNull()
  })

  describe('under StrictMode', () => {
    function revokedCount(url: string): number {
      return revokeObjectURL.mock.calls.filter(([revoked]) => revoked === url).length
    }

    function expectVisibleUrlLive() {
      const visible = screen.queryByAltText(ALT)?.getAttribute('src')
      if (visible) expect(revokedCount(visible)).toBe(0)
    }

    function renderStrict(contentVersion: number) {
      const element = (version: number) => (
        <StrictMode>
          <GfsImagePreviewBody
            byteLength={3}
            contentVersion={version}
            fileName="diagram.png"
            gfsUri={URI}
            mimeType="image/png"
          />
        </StrictMode>
      )
      const view = render(element(contentVersion))
      return { ...view, bump: (version: number) => view.rerender(element(version)) }
    }

    // StrictMode replays the download effect, so a version can have a
    // superseded twin download; settling every pending one covers both.
    async function settleAll(
      pending: ReturnType<typeof stubDeferredDownloads>['pending'],
      seed: number
    ) {
      for (const download of pending.splice(0)) {
        await act(async () => download.resolve(await imageDownload(seed)))
      }
    }

    it('revokes every URL exactly once across reloads and unmount', async () => {
      const { pending } = stubDeferredDownloads()
      const view = renderStrict(1)
      await settleAll(pending, 1)
      await waitFor(() => expect(screen.queryByAltText(ALT)).toBeTruthy())
      expectVisibleUrlLive()

      for (const version of [2, 3]) {
        view.bump(version)
        await waitFor(() => expect(pending.length).toBeGreaterThan(0))
        expectVisibleUrlLive()
        await settleAll(pending, version)
        await waitFor(() =>
          expect(screen.queryByAltText(ALT)?.getAttribute('src')).toBe(createdUrls.at(-1))
        )
        expectVisibleUrlLive()
      }

      view.unmount()
      expect(createdUrls).toHaveLength(3)
      for (const url of createdUrls) expect(revokedCount(url)).toBe(1)
    })

    it('revokes every URL exactly once when unmounted during an in-place download', async () => {
      const { pending } = stubDeferredDownloads()
      const view = renderStrict(1)
      await settleAll(pending, 1)
      await waitFor(() => expect(screen.queryByAltText(ALT)).toBeTruthy())

      view.bump(2)
      await waitFor(() => expect(pending.length).toBeGreaterThan(0))
      expectVisibleUrlLive()
      view.unmount()
      await settleAll(pending, 2)

      expect(createdUrls).toHaveLength(1)
      for (const url of createdUrls) expect(revokedCount(url)).toBe(1)
    })
  })
})
