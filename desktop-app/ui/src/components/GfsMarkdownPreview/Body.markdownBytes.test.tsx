// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { previewDownloadResult, resolveResource } from '@/gfs/__fixtures__/gfsProducerFixtures'
import { GfsMarkdownPreviewBody } from './Body'

describe('GfsMarkdownPreviewBody UTF-8 byte boundary', () => {
  it('rejects invalid bytes before source publication or editor mount', async () => {
    const onSourceLoaded = vi.fn((_source: string) => true)
    const onDownloadError = vi.fn()
    const resource = await resolveResource({
      resourceId: 'invalid',
      rid: 'invalid',
      gfsUri: 'gfs://main/invalid',
      drive: 'main',
      parentResourceId: null,
      name: 'invalid.md',
      kind: 'file',
      version: 1,
      bytes: 3,
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          resolve: vi.fn(async () => resource),
          downloadPreview: vi.fn(async (_uri: string, maxBytes: number) =>
            previewDownloadResult(resource, new Uint8Array([0x23, 0x20, 0xc3]).buffer, maxBytes)
          ),
        },
      },
    })

    render(
      <GfsMarkdownPreviewBody
        byteLength={3}
        editor={<textarea aria-label="Markdown editor" />}
        expectedSessionGeneration={1}
        fileName="invalid.md"
        gfsUri="gfs://main/invalid"
        onDownloadError={onDownloadError}
        onSourceLoaded={onSourceLoaded}
      />
    )

    await waitFor(() =>
      expect(onDownloadError.mock.calls.length + onSourceLoaded.mock.calls.length).toBe(1)
    )
    expect(onDownloadError).toHaveBeenCalledOnce()
    expect(onSourceLoaded).not.toHaveBeenCalled()
    expect(screen.queryByRole('textbox', { name: 'Markdown editor' })).toBeNull()
    expect(screen.getByText(/encoded data was not valid for encoding utf-8/i)).toBeTruthy()
  })

  it('publishes a BOM-prefixed source without stripping its supported marker', async () => {
    const onSourceLoaded = vi.fn((_source: string) => true)
    const resource = await resolveResource({
      resourceId: 'bom',
      rid: 'bom',
      gfsUri: 'gfs://main/bom',
      drive: 'main',
      parentResourceId: null,
      name: 'bom.md',
      kind: 'file',
      version: 1,
      bytes: 8,
    })
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('# BOM')])
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          resolve: vi.fn(async () => resource),
          downloadPreview: vi.fn(async (_uri: string, maxBytes: number) =>
            previewDownloadResult(resource, bytes.buffer, maxBytes)
          ),
        },
      },
    })
    render(
      <GfsMarkdownPreviewBody
        byteLength={bytes.byteLength}
        editor={<textarea aria-label="Markdown editor" />}
        expectedSessionGeneration={1}
        fileName="bom.md"
        gfsUri="gfs://main/bom"
        onSourceLoaded={onSourceLoaded}
      />
    )
    await waitFor(() => expect(onSourceLoaded).toHaveBeenCalledOnce())
    expect(onSourceLoaded.mock.calls[0]?.[0].startsWith('\uFEFF')).toBe(true)
  })
})
