import React from 'react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MarkdownContent } from '../MarkdownContent'
import { ThemeProvider } from '../ThemeContext'

beforeAll(async () => {
  // Resolve the client-only renderer before the default async-query deadline
  // starts, so this test measures rendered theme behavior instead of import
  // transform latency under full-suite worker load.
  await import('@uiw/react-md-editor')
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

const MARKDOWN = [
  '# Preview title',
  '',
  'Paragraph text with `inline code` and a [link](https://example.invalid/).',
  '',
  '- First item',
  '- Second item',
  '',
  '> Quoted text',
  '',
  '```ts',
  'const value = true',
  '```',
  '',
  '| Name | Value |',
  '| --- | --- |',
  '| Mode | Read-only |',
].join('\n')

describe('MarkdownContent theme', () => {
  it.each([{ mode: 'light' }, { mode: 'dark' }])(
    'passes the active $mode palette to the read-only Markdown renderer',
    async expected => {
      window.localStorage.setItem('clerum.control-ui.theme', expected.mode)

      render(
        <ThemeProvider>
          <MarkdownContent
            ariaLabel="Rendered identity document"
            className="cu-gfs-markdown-preview__content"
            emptyMessage="This identity document is empty."
            source={MARKDOWN}
          />
        </ThemeProvider>
      )

      const article = await screen.findByRole('article', { name: 'Rendered identity document' })
      await waitFor(() =>
        expect(document.documentElement).toHaveAttribute('data-theme', expected.mode)
      )
      await screen.findByRole('heading', { name: 'Preview title' })

      const markdownRoot = article.querySelector('.wmde-markdown')
      expect(markdownRoot).not.toBeNull()
      expect(article).toHaveAttribute('data-color-mode', expected.mode)

      expect(screen.getByRole('heading', { name: 'Preview title' })).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'link' })).toHaveAttribute(
        'href',
        'https://example.invalid/'
      )
      expect(screen.getAllByRole('listitem')).toHaveLength(2)
      expect(screen.getByText('Quoted text')).toBeInTheDocument()
      expect(article.querySelector('pre code')?.textContent).toBe('const value = true\n')
      expect(screen.getByRole('table')).toBeInTheDocument()
      expect(screen.getByRole('cell', { name: 'Read-only' })).toBeInTheDocument()
      expect(article.querySelector('button')).toBeNull()
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    }
  )
})
