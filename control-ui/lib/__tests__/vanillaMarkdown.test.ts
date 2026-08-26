import { describe, expect, it } from 'vitest'
import { isGfsMarkdownPreviewFile } from '@lib/gfsMarkdownPreview'
import { parseInlineMarkdown, parseVanillaMarkdown } from '@lib/vanillaMarkdown'

describe('vanilla Markdown preview', () => {
  it.each(['README.md', 'guide.MARKDOWN', 'notes.txt'])('recognizes %s', fileName => {
    expect(isGfsMarkdownPreviewFile(fileName)).toBe(true)
  })

  it.each(['README', 'archive.md.zip'])('rejects %s', fileName => {
    expect(isGfsMarkdownPreviewFile(fileName)).toBe(false)
  })

  it('parses basic block Markdown without interpreting HTML', () => {
    const blocks = parseVanillaMarkdown(
      '# Guide\n\n- **First**\n- Second\n\n> Safe quote\n\n```ts\nconst value = 1\n```\n\n<script>alert(1)</script>'
    )

    expect(blocks.map(block => block.kind)).toEqual([
      'heading',
      'list',
      'blockquote',
      'code',
      'paragraph',
    ])
    expect(blocks.at(-1)).toMatchObject({ kind: 'paragraph' })
  })

  it('allows safe links and neutralizes executable protocols', () => {
    const safe = parseInlineMarkdown('[Docs](https://example.com)')
    const unsafe = parseInlineMarkdown('[Run](javascript:alert)')

    expect(safe[0]).toMatchObject({ kind: 'link', href: 'https://example.com' })
    expect(unsafe[0]).toMatchObject({ kind: 'link', href: null })
  })
})
