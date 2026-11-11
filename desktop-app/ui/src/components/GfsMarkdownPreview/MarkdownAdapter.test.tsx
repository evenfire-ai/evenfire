// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { GfsMarkdownDocument, GfsMarkdownEditor } from './MarkdownAdapter'

describe('GFS Markdown adapter', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('sanitizes raw HTML and blocks active content and unsafe URLs', () => {
    const source = [
      '# Safe heading',
      '',
      '<h2>Raw HTML heading</h2>',
      '<script>alert(1)</script>',
      '<iframe src="https://example.com/embed"></iframe>',
      '<form action="https://example.com"><input autofocus onfocus="alert(1)" /></form>',
      '<img src="https://example.com/private.png" onerror="alert(1)" alt="Remote raw image" />',
      '<a href="javascript:alert(1)" onclick="alert(1)">Unsafe raw link</a>',
      '',
      '[Unsafe Markdown link](javascript:alert(1))',
    ].join('\n')

    const { container } = render(
      <article aria-label="Markdown preview of unsafe.md">
        <GfsMarkdownDocument source={source} />
      </article>
    )

    const article = screen.getByRole('article', { name: 'Markdown preview of unsafe.md' })
    expect(within(article).getByRole('heading', { name: 'Safe heading', level: 1 })).toBeTruthy()
    expect(within(article).queryByRole('heading', { name: 'Raw HTML heading' })).toBeNull()
    expect(container.querySelector('script, iframe, form')).toBeNull()
    expect(container.querySelector('input[type="checkbox"]:not(:disabled)')).toBeNull()
    expect(container.querySelector('[onfocus], [onclick], [onerror]')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(within(article).queryByRole('link', { name: /Unsafe/ })).toBeNull()
  })

  it('keeps GFM tables keyboard-scrollable and preserves safe links', () => {
    const source = [
      '# Guide',
      '',
      '| Item | Count |',
      '| --- | ---: |',
      '| Files | 3 |',
      '',
      '- [x] Reviewed',
      '',
      '[Docs](https://example.com/docs)',
      '[Mail](mailto:help@example.com)',
      '[Anchor](#details)',
    ].join('\n')

    render(
      <article aria-label="Markdown preview of guide.md">
        <GfsMarkdownDocument source={source} />
      </article>
    )

    const article = screen.getByRole('article', { name: 'Markdown preview of guide.md' })
    const table = within(article).getByRole('table')
    expect(within(table).getByRole('columnheader', { name: 'Item' }).getAttribute('scope')).toBe(
      'col'
    )
    expect(within(table).getByRole('cell', { name: 'Files' })).toBeTruthy()
    expect(
      within(article).getByRole('region', { name: 'Scrollable Markdown table' }).tabIndex
    ).toBe(0)
    expect((within(article).getByRole('checkbox') as HTMLInputElement).disabled).toBe(true)
    expect(within(article).getByRole('link', { name: 'Docs' }).getAttribute('rel')).toBe(
      'noreferrer'
    )
    expect(within(article).getByRole('link', { name: 'Mail' }).getAttribute('href')).toBe(
      'mailto:help@example.com'
    )
    expect(within(article).getByRole('link', { name: 'Anchor' }).getAttribute('href')).toBe(
      '#details'
    )
  })

  it('allows only inline raster Markdown images and renders remote sources as inert alt text', () => {
    const source =
      '![Inline](data:image/png;base64,aGVsbG8=) ![Remote](https://example.com/private.png)'
    const fetchRequest = vi.fn()
    vi.stubGlobal('fetch', fetchRequest)

    render(
      <article aria-label="Markdown preview of images.md">
        <GfsMarkdownDocument source={source} />
      </article>
    )

    const article = screen.getByRole('article', { name: 'Markdown preview of images.md' })
    expect(within(article).getByRole('img', { name: 'Inline' }).getAttribute('src')).toBe(
      'data:image/png;base64,aGVsbG8='
    )
    expect(within(article).queryByRole('img', { name: 'Remote' })).toBeNull()
    expect(article.textContent).toContain('Remote')
    expect(fetchRequest).not.toHaveBeenCalled()
  })

  it('exposes an accessible editable source and forwards ordinary text changes', () => {
    const onChange = vi.fn()
    render(<GfsMarkdownEditor ariaLabel="Markdown source" onChange={onChange} value="# Start" />)

    const editor = screen.getByRole('textbox', { name: 'Markdown source' })
    expect((editor as HTMLTextAreaElement).value).toBe('# Start')
    expect(editor.closest('.w-md-editor')?.getAttribute('style')).toContain('height: 100%')
    expect(editor.closest('.w-md-editor')?.querySelector('.w-md-editor-bar')).toBeNull()
    fireEvent.change(editor, { target: { value: '# Updated' } })
    expect(onChange).toHaveBeenCalledWith('# Updated')
  })
})
