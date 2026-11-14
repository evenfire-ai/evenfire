// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { GfsImagePreviewBody } from '../GfsImagePreview'
import { GfsMarkdownPreviewBody } from '../GfsMarkdownPreview'
import { GfsVideoPreviewBody } from '../GfsVideoPreview'

/**
 * The three preview bodies all read bytes through
 * `window.clerum.gfs.downloadPreview`, which crosses Electron IPC, and all three
 * put whatever comes back into a `StatusBanner`. Raw, that banner reads
 * "Error invoking remote method 'gfs:downloadPreview': Error: 429 Too Many
 * Requests" — our own main/renderer split plus a bare status line, in front of a
 * user who opened a file. The Files page stopped saying that; these had not.
 *
 * The bodies are the unit under test rather than the modal chrome: after the
 * de-modalization only the image preview still has a modal wrapper, and every
 * surface that reads bytes (the surviving modal, `FilePreviewPage`, the
 * workspace preview tab) mounts one of these three.
 *
 * One file for the three because the contract is one function. A preview that
 * stops routing through it fails here regardless of which one it is.
 */

const RATE_LIMITED_DOWNLOAD =
  "Error invoking remote method 'gfs:downloadPreview': Error: 429 Too Many Requests: " +
  'Too Many Requests httpStatus=429 retryAfterSeconds=7'

const PREVIEWS = [
  [
    'image',
    () => (
      <GfsImagePreviewBody
        byteLength={3}
        fileName="diagram.png"
        gfsUri="gfs://main/image-1"
        mimeType="image/png"
      />
    ),
  ],
  [
    'video',
    () => (
      <GfsVideoPreviewBody
        byteLength={3}
        fileName="clip.mp4"
        gfsUri="gfs://main/video-1"
        mimeType="video/mp4"
      />
    ),
  ],
  [
    'markdown',
    () => <GfsMarkdownPreviewBody byteLength={3} fileName="notes.md" gfsUri="gfs://main/md-1" />,
  ],
] as const

describe('GFS preview read failures', () => {
  let downloadPreview: ReturnType<typeof vi.fn>

  beforeEach(() => {
    downloadPreview = vi.fn(async () => {
      throw new Error(RATE_LIMITED_DOWNLOAD)
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { gfs: { downloadPreview } },
    })
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:gfs-preview'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}

        disconnect() {}
      }
    )
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it.each(PREVIEWS)(
    'presents a rate-limited %s download in the shared read-plane words',
    async (_label, renderPreview) => {
      render(renderPreview())

      // Liveness witness: the read really ran and really rejected, so the
      // absence of the IPC wrapper below is a presented verdict and not a
      // preview that never attempted the download.
      await waitFor(() => expect(downloadPreview).toHaveBeenCalledTimes(1))
      await waitFor(() =>
        expect(screen.getByText('Too many file requests — try again in 7s.')).toBeTruthy()
      )
      expect(screen.queryByText(/Error invoking remote method/)).toBeNull()
    }
  )

  it.each(PREVIEWS)(
    'keeps a non-rate-limited %s verdict, minus the IPC wrapper',
    async (_label, renderPreview) => {
      downloadPreview.mockImplementation(async () => {
        throw new Error(
          "Error invoking remote method 'gfs:downloadPreview': Error: 403 Forbidden: " +
            'read access was revoked httpStatus=403'
        )
      })

      render(renderPreview())

      await waitFor(() => expect(downloadPreview).toHaveBeenCalledTimes(1))
      // The server's own verdict survives — fail loud, never swallowed — while
      // the wrapper naming our process boundary does not. Without this case the
      // assertions above would also pass on a presenter that answered
      // "Too many file requests" to everything.
      //
      // Matched whole, not as a substring. An un-anchored matcher passes with
      // the vetted `httpStatus=403` marker still on screen, which is how the
      // banner shipped one piece of our plumbing in place of another.
      await waitFor(() =>
        expect(screen.getByText('403 Forbidden: read access was revoked')).toBeTruthy()
      )
      expect(screen.queryByText(/httpStatus=/)).toBeNull()
      expect(screen.queryByText(/Error invoking remote method/)).toBeNull()
    }
  )
})
