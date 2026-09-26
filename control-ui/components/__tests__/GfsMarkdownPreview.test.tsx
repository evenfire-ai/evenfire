import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { GfsMarkdownPreview } from '../GfsMarkdownPreview'
import { ToastProvider } from '../Toast'

const mockGfsFetchFileBlob = vi.fn()

vi.mock('@lib/api', () => ({
  gfsFetchFileBlob: (...args: unknown[]) => mockGfsFetchFileBlob(...args),
}))

function renderMarkdownPreview(markdown: string, fileName = 'inventory.md') {
  mockGfsFetchFileBlob.mockResolvedValueOnce(new Blob([markdown], { type: 'text/markdown' }))

  return render(
    <ToastProvider>
      <GfsMarkdownPreview
        byteLength={new TextEncoder().encode(markdown).byteLength}
        fileName={fileName}
        onClose={vi.fn()}
        rid="r-markdown"
      />
    </ToastProvider>
  )
}

describe('GfsMarkdownPreview', () => {
  beforeEach(() => {
    mockGfsFetchFileBlob.mockReset()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders GFM tables accessibly alongside other Markdown content', async () => {
    const markdown = [
      '# Inventory',
      '',
      '| Item | Count |',
      '| --- | ---: |',
      '| **GFS files** | 12 |',
      '',
      '- [x] Review complete',
      '',
      '> Checked this morning.',
      '',
      '![Trend chart](https://example.com/trend.png)',
      '',
      '[Documentation](https://example.com/docs)',
      '[Unsafe link](javascript:alert(1))',
      '<script>alert(1)</script>',
    ].join('\n')

    renderMarkdownPreview(markdown)

    const article = await screen.findByRole('article', {
      name: 'Markdown preview of inventory.md',
    })
    const table = within(article).getByRole('table')
    expect(within(table).getByRole('columnheader', { name: 'Item' })).toHaveAttribute(
      'scope',
      'col'
    )
    expect(within(table).getByRole('cell', { name: 'GFS files' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Scrollable Markdown table' })).toHaveAttribute(
      'tabindex',
      '0'
    )
    expect(within(article).getByRole('heading', { name: 'Inventory' })).toBeInTheDocument()
    expect(within(article).getByRole('checkbox')).toBeDisabled()
    expect(within(article).getByRole('img', { name: 'Trend chart' })).toHaveAttribute(
      'referrerpolicy',
      'no-referrer'
    )
    expect(within(article).getByRole('link', { name: 'Documentation' })).toHaveAttribute(
      'target',
      '_blank'
    )
    expect(within(article).queryByRole('link', { name: 'Unsafe link' })).not.toBeInTheDocument()
    expect(article.querySelector('script')).toBeNull()
  })

  it('leaves malformed table syntax readable without constructing a table', async () => {
    const markdown = '| Broken | Table |\n| not a separator |\n| still text | here |'

    renderMarkdownPreview(markdown, 'malformed.md')

    const article = await screen.findByRole('article', {
      name: 'Markdown preview of malformed.md',
    })
    expect(within(article).queryByRole('table')).not.toBeInTheDocument()
    expect(article).toHaveTextContent('Broken')
    expect(article).toHaveTextContent('not a separator')
  })
})
