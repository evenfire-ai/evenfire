// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GFS_MARKDOWN_PREVIEW_MAX_BYTES } from '@constants/gfsMarkdownPreview'
import { GfsMarkdownPreviewBody } from './Body'

// Mirror the producer shape: `window.clerum.gfs.download` → `{ bytes: ArrayBuffer }`.
function stubDownload(text: string) {
  const download = vi.fn(async () => ({ bytes: new TextEncoder().encode(text).buffer }))
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: { gfs: { download } },
  })
  return download
}

describe('GfsMarkdownPreviewBody', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders markdown with safe vanilla rendering (no modal, no unsafe links or scripts)', async () => {
    const markdown =
      '# Project guide\n\nUse **safe rendering**.\n\n1. First\n2. Second\n\n[Unsafe](javascript:alert)\n\n<script>alert("no")</script>'
    const download = stubDownload(markdown)

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
    expect(download).toHaveBeenCalledWith('gfs://main/markdown-1')
    expect(screen.queryByRole('dialog')).toBeNull()
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

  it('copies the source to the clipboard from the header button', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { ...(navigator.clipboard ?? {}), writeText },
    })
    const markdown = '# Hello\n\nGreetings.'
    stubDownload(markdown)

    render(
      <GfsMarkdownPreviewBody
        byteLength={markdown.length}
        fileName="README.md"
        gfsUri="gfs://main/markdown-2"
      />
    )
    const copyButton = await screen.findByRole('button', {
      name: /Copy preview contents to clipboard/i,
    })
    fireEvent.click(copyButton)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(markdown))
  })

  it('rejects an oversized markdown file from metadata before downloading', async () => {
    const download = stubDownload('x')
    render(
      <GfsMarkdownPreviewBody
        byteLength={GFS_MARKDOWN_PREVIEW_MAX_BYTES + 1}
        fileName="oversized.md"
        gfsUri="gfs://main/oversized"
      />
    )
    expect(await screen.findByText(/Markdown previews are limited to 2 MB/)).toBeTruthy()
    expect(download).not.toHaveBeenCalled()
  })

  it('fails closed on a download error and notifies onDownloadError', async () => {
    const onDownloadError = vi.fn()
    const download = vi.fn(async () => {
      throw new Error('401 not authenticated')
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { gfs: { download } },
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
