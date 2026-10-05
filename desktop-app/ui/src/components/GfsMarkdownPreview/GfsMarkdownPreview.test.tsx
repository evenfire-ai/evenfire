// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { GfsMarkdownPreviewBody } from '@components/GfsMarkdownPreview'

function stubDownload(text: string) {
  const downloadPreview = vi.fn(async () => ({ bytes: new TextEncoder().encode(text).buffer }))
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: { gfs: { downloadPreview } },
  })
  return downloadPreview
}

describe('GfsMarkdownPreview public barrel', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders GFM tables through the public import surface', async () => {
    const markdown = [
      '# Inventory',
      '',
      '| Item | Count |',
      '| --- | ---: |',
      '| **GFS files** | 12 |',
      '',
      '[Documentation](https://example.com/docs)',
      '[Unsafe link](javascript:alert(1))',
    ].join('\n')
    const downloadPreview = stubDownload(markdown)

    render(
      <GfsMarkdownPreviewBody
        byteLength={new TextEncoder().encode(markdown).byteLength}
        fileName="inventory.md"
        gfsUri="gfs://main/inventory"
      />
    )

    const article = await screen.findByRole('article', {
      name: 'Markdown preview of inventory.md',
    })
    const table = within(article).getByRole('table')
    expect(within(table).getByRole('columnheader', { name: 'Item' }).getAttribute('scope')).toBe(
      'col'
    )
    expect(within(table).getByRole('cell', { name: 'GFS files' })).toBeTruthy()
    expect(within(article).queryByRole('link', { name: 'Unsafe link' })).toBeNull()
    expect(downloadPreview).toHaveBeenCalledWith('gfs://main/inventory', expect.any(Number))
  })
})
