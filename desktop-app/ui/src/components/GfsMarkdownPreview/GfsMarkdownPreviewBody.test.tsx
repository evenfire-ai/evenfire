// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GFS_MARKDOWN_PREVIEW_MAX_BYTES } from '@constants/gfsMarkdownPreview'
import { GfsMarkdownPreviewBody } from './Body'

// Mirror the producer shape: `window.clerum.gfs.downloadPreview` → `{ bytes: ArrayBuffer }`.
function stubDownload(text: string) {
  const downloadPreview = vi.fn(async () => ({ bytes: new TextEncoder().encode(text).buffer }))
  const resolve = vi.fn(async () => ({ version: 1 }))
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: { gfs: { downloadPreview, resolve } },
  })
  return downloadPreview
}

describe('GfsMarkdownPreviewBody', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders markdown with safe vanilla rendering (no modal, no unsafe links or scripts)', async () => {
    const markdown =
      '# Project guide\n\nUse **safe rendering**.\n\n1. First\n2. Second\n\n[Unsafe](javascript:alert)\n\n<script>alert("no")</script>'
    const downloadPreview = stubDownload(markdown)

    const { container } = render(
      <GfsMarkdownPreviewBody
        byteLength={markdown.length}
        fileName="README.md"
        gfsUri="gfs://main/markdown-1"
      />
    )

    expect(await screen.findByRole('heading', { name: 'Project guide', level: 1 })).toBeTruthy()
    expect(screen.getByText('safe rendering').tagName).toBe('STRONG')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText('Unsafe').closest('a')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(downloadPreview).toHaveBeenCalledWith(
      'gfs://main/markdown-1',
      GFS_MARKDOWN_PREVIEW_MAX_BYTES,
      undefined
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('retries a torn read once and publishes only bytes paired with a stable version', async () => {
    const versions = [1, 2, 2, 2]
    const resolve = vi.fn(async () => ({ version: versions.shift()! }))
    const downloadPreview = vi
      .fn()
      .mockResolvedValueOnce({ bytes: new TextEncoder().encode('# Torn').buffer })
      .mockResolvedValueOnce({ bytes: new TextEncoder().encode('# Stable').buffer })
    const onSourceLoaded = vi.fn()
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { gfs: { downloadPreview, resolve } },
    })
    render(
      <GfsMarkdownPreviewBody
        byteLength={8}
        fileName="README.md"
        gfsUri="gfs://main/stable"
        expectedSessionGeneration={7}
        onSourceLoaded={onSourceLoaded}
      />
    )
    expect(await screen.findByRole('heading', { name: 'Stable', level: 1 })).toBeTruthy()
    expect(downloadPreview).toHaveBeenCalledTimes(2)
    expect(downloadPreview).toHaveBeenLastCalledWith(
      'gfs://main/stable',
      GFS_MARKDOWN_PREVIEW_MAX_BYTES,
      7
    )
    expect(onSourceLoaded).toHaveBeenCalledWith('# Stable', 2)
    expect(screen.queryByRole('heading', { name: 'Torn' })).toBeNull()
  })

  it('renders a .txt file as plain text', async () => {
    stubDownload('line one\nline two\twith tab')
    render(
      <GfsMarkdownPreviewBody byteLength={26} fileName="notes.txt" gfsUri="gfs://main/text-1" />
    )
    const pre = await screen.findByText(/line one/)
    expect(pre.tagName).toBe('PRE')
    expect(pre.textContent).toContain('line two\twith tab')
  })

  it('exposes source copying to the owning preview toolbar', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { ...(navigator.clipboard ?? {}), writeText },
    })
    const markdown = '# Hello\n\nGreetings.'
    stubDownload(markdown)
    const copyContent: { current: (() => Promise<boolean>) | null } = { current: null }

    render(
      <GfsMarkdownPreviewBody
        byteLength={markdown.length}
        fileName="README.md"
        gfsUri="gfs://main/markdown-2"
        onCopyContentReady={copy => {
          copyContent.current = copy
        }}
      />
    )
    await screen.findByRole('heading', { name: 'Hello' })
    await waitFor(() => expect(copyContent.current).toEqual(expect.any(Function)))
    expect(await copyContent.current?.()).toBe(true)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(markdown))
    expect(screen.queryByRole('button', { name: /Copy preview contents/i })).toBeNull()
  })

  it('rejects an oversized markdown file from metadata before downloading', async () => {
    const downloadPreview = stubDownload('x')
    render(
      <GfsMarkdownPreviewBody
        byteLength={GFS_MARKDOWN_PREVIEW_MAX_BYTES + 1}
        fileName="oversized.md"
        gfsUri="gfs://main/oversized"
      />
    )
    expect(await screen.findByText(/Markdown previews are limited to 2 MB/)).toBeTruthy()
    expect(downloadPreview).not.toHaveBeenCalled()
  })

  it('fails closed on a download error and notifies onDownloadError', async () => {
    const onDownloadError = vi.fn()
    const downloadPreview = vi.fn(async () => {
      throw new Error('401 not authenticated')
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { gfs: { downloadPreview, resolve: vi.fn(async () => ({ version: 1 })) } },
    })
    render(
      <GfsMarkdownPreviewBody
        byteLength={5}
        fileName="README.md"
        gfsUri="gfs://main/markdown-3"
        onDownloadError={onDownloadError}
      />
    )
    expect(await screen.findByText('401 not authenticated')).toBeTruthy()
    await waitFor(() => expect(onDownloadError).toHaveBeenCalled())
  })
})
