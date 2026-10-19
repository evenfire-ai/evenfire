// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { buildChatMessageSemanticModel } from '@lib/chatMessageSemantics'
import { ChatMarkdownContent } from '../ChatMarkdownContent'

afterEach(() => {
  cleanup()
})

function renderMarkdown(source: string) {
  const model = buildChatMessageSemanticModel({
    id: 'assistant-1',
    role: 'assistant',
    content: source,
    timestamp: 1,
  })
  return render(<ChatMarkdownContent model={model} query="" activeOccurrence={null} />)
}

describe('ChatMarkdownContent ordinary Markdown', () => {
  it('preserves Markdown, GFM, authored HTTP links, and semantic text', () => {
    renderMarkdown(
      [
        '## Notes',
        '',
        '- one',
        '- **two**',
        '',
        '| Item | Count |',
        '| --- | --- |',
        '| file | 2 |',
        '',
        '[Guide](https://docs.example.test/guide)',
      ].join('\n')
    )

    expect(screen.getByRole('heading', { name: 'Notes', level: 2 })).toBeTruthy()
    expect(screen.getAllByRole('listitem')[1]?.textContent).toBe('two')
    expect(screen.getByRole('table')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Guide' }).getAttribute('href')).toBe(
      'https://docs.example.test/guide'
    )
  })

  it('keeps bare GFS URIs literal and unsafe links inert', () => {
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    const { container } = renderMarkdown(`Open ${uri} and [unsafe](javascript:alert(1)).`)

    expect(container.textContent).toContain(`Open ${uri} and unsafe.`)
    expect(container.querySelector('a')).toBeNull()
  })

  it('does not activate authored GFS or EvenDrive targets in ordinary chat Markdown', () => {
    const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
    const desktopLink = `evenfire://files?uri=${encodeURIComponent(uri)}`
    const { container } = renderMarkdown(`[Project](${uri}) and [Route](${desktopLink})`)

    expect(container.textContent).toContain('Project and Route')
    expect(container.querySelector('a')).toBeNull()
  })

  it('keeps raw HTML as text', () => {
    const { container } = renderMarkdown('<img src="https://example.test/x.png" onerror="run()">')

    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img')
  })

  it('keeps remote Markdown images inert while preserving their alt text', () => {
    const { container } = renderMarkdown('![Remote](https://example.test/private.png)')

    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('Remote')).toBeTruthy()
  })

  it('allows only inline data images through the chat Markdown renderer', () => {
    const { container } = renderMarkdown('![Embedded](data:image/png;base64,AAAA)')

    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
  })
})
