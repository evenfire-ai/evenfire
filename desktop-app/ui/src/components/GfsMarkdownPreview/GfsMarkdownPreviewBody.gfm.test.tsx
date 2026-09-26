// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { GfsMarkdownPreviewBody } from './Body'

function stubDownload(text: string) {
  const downloadPreview = vi.fn(async () => ({ bytes: new TextEncoder().encode(text).buffer }))
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: { gfs: { downloadPreview } },
  })
  return downloadPreview
}

describe('GfsMarkdownPreviewBody GFM rendering', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders accessible tables and other Markdown content safely', async () => {
    const markdown = [
      '# Inventory',
      '',
      '| Item | Count |',
      '| :--- | ---: |',
      '| **GFS files** | 12 |',
      '',
      '- [x] Review complete',
      '',
      '> Checked this morning.',
      '',
      '~~outdated~~',
      '',
      '![Trend chart](https://example.com/trend.png)',
      '',
      '[Documentation](https://example.com/docs)',
      '[Unsafe link](javascript:alert(1))',
      '',
      '<script>alert(1)</script>',
    ].join('\n')
    stubDownload(markdown)

    const { container } = render(
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
    expect(screen.getByRole('region', { name: 'Scrollable Markdown table' }).tabIndex).toBe(0)
    expect(within(article).getByRole('heading', { name: 'Inventory', level: 1 })).toBeTruthy()
    expect((within(article).getByRole('checkbox') as HTMLInputElement).disabled).toBe(true)
    expect(within(article).getByText('outdated').tagName).toBe('DEL')
    expect(
      within(article).getByRole('img', { name: 'Trend chart' }).getAttribute('referrerpolicy')
    ).toBe('no-referrer')
    expect(
      within(article).getByRole('link', { name: 'Documentation' }).getAttribute('target')
    ).toBe('_blank')
    expect(within(article).queryByRole('link', { name: 'Unsafe link' })).toBeNull()
    expect(container.querySelector('script')).toBeNull()
  })

  it('keeps malformed table syntax readable without inventing a table', async () => {
    const markdown = '| Broken | Table |\n| not a separator |\n| still text | here |'
    stubDownload(markdown)

    const { container } = render(
      <GfsMarkdownPreviewBody
        byteLength={markdown.length}
        fileName="malformed.md"
        gfsUri="gfs://main/malformed"
      />
    )

    const article = await screen.findByRole('article', {
      name: 'Markdown preview of malformed.md',
    })
    expect(within(article).queryByRole('table')).toBeNull()
    expect(article.textContent).toContain('Broken')
    expect(article.textContent).toContain('not a separator')
    expect(container.querySelector('script')).toBeNull()
  })
})
