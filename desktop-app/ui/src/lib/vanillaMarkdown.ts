import type { MarkdownBlock, MarkdownInlineNode } from './vanillaMarkdown.types'

const INLINE_TOKEN_PATTERN =
  /(!?\[[^\]\n]+\]\([^\s)\n]+(?:\s+"[^"\n]*")?\)|`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_)/g
const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/
const UNORDERED_LIST_PATTERN = /^\s*[-+*]\s+(.+)$/
const ORDERED_LIST_PATTERN = /^\s*\d+[.)]\s+(.+)$/
const DIVIDER_PATTERN = /^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/
const FENCE_PATTERN = /^\s*(```|~~~)\s*([\w-]+)?\s*$/

function safeMarkdownHref(rawHref: string): string | null {
  const href = rawHref.trim()
  if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href) || href.startsWith('#')) return href
  return null
}

export function parseInlineMarkdown(source: string, idPrefix = 'inline'): MarkdownInlineNode[] {
  const nodes: MarkdownInlineNode[] = []
  let cursor = 0

  for (const match of source.matchAll(INLINE_TOKEN_PATTERN)) {
    const offset = match.index ?? 0
    const token = match[0]
    if (offset > cursor) {
      nodes.push({
        id: `${idPrefix}-text-${cursor}`,
        kind: 'text',
        value: source.slice(cursor, offset),
      })
    }

    const tokenId = `${idPrefix}-token-${offset}`
    if (token.startsWith('![')) {
      const imageMatch = token.match(/^!\[([^\]]+)\]\(/)
      nodes.push({
        id: tokenId,
        kind: 'text',
        value: imageMatch ? `[Image: ${imageMatch[1]}]` : token,
      })
    } else if (token.startsWith('[')) {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)$/)
      if (linkMatch) {
        nodes.push({
          id: tokenId,
          kind: 'link',
          href: safeMarkdownHref(linkMatch[2] ?? ''),
          children: parseInlineMarkdown(linkMatch[1] ?? '', `${tokenId}-link`),
        })
      } else {
        nodes.push({ id: tokenId, kind: 'text', value: token })
      }
    } else if (token.startsWith('`')) {
      nodes.push({ id: tokenId, kind: 'code', value: token.slice(1, -1) })
    } else {
      const markerLength = token.startsWith('**') || token.startsWith('__') ? 2 : 1
      const kind = token.startsWith('~~')
        ? 'strikethrough'
        : markerLength === 2
          ? 'strong'
          : 'emphasis'
      const edgeLength = kind === 'strikethrough' ? 2 : markerLength
      nodes.push({
        id: tokenId,
        kind,
        children: parseInlineMarkdown(token.slice(edgeLength, -edgeLength), `${tokenId}-${kind}`),
      })
    }
    cursor = offset + token.length
  }

  if (cursor < source.length) {
    nodes.push({
      id: `${idPrefix}-text-${cursor}`,
      kind: 'text',
      value: source.slice(cursor),
    })
  }
  return nodes
}

function startsBlock(line: string): boolean {
  return (
    !line.trim() ||
    FENCE_PATTERN.test(line) ||
    HEADING_PATTERN.test(line) ||
    DIVIDER_PATTERN.test(line) ||
    /^\s*>\s?/.test(line) ||
    UNORDERED_LIST_PATTERN.test(line) ||
    ORDERED_LIST_PATTERN.test(line)
  )
}

export function parseVanillaMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: MarkdownBlock[] = []
  let lineIndex = 0

  while (lineIndex < lines.length) {
    const line = lines[lineIndex] ?? ''
    if (!line.trim()) {
      lineIndex += 1
      continue
    }

    const fenceMatch = line.match(FENCE_PATTERN)
    if (fenceMatch) {
      const startLine = lineIndex
      const fence = fenceMatch[1] ?? '```'
      const language = fenceMatch[2] ?? null
      const codeLines: string[] = []
      lineIndex += 1
      while (lineIndex < lines.length && !(lines[lineIndex] ?? '').trimStart().startsWith(fence)) {
        codeLines.push(lines[lineIndex] ?? '')
        lineIndex += 1
      }
      if (lineIndex < lines.length) lineIndex += 1
      blocks.push({
        id: `block-${startLine}-code`,
        kind: 'code',
        language,
        value: codeLines.join('\n'),
      })
      continue
    }

    const headingMatch = line.match(HEADING_PATTERN)
    if (headingMatch) {
      const level = headingMatch[1]?.length as 1 | 2 | 3 | 4 | 5 | 6
      blocks.push({
        id: `block-${lineIndex}-heading`,
        kind: 'heading',
        level,
        children: parseInlineMarkdown(headingMatch[2] ?? '', `block-${lineIndex}`),
      })
      lineIndex += 1
      continue
    }

    if (DIVIDER_PATTERN.test(line)) {
      blocks.push({ id: `block-${lineIndex}-divider`, kind: 'divider' })
      lineIndex += 1
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      const startLine = lineIndex
      const quoteLines: string[] = []
      while (lineIndex < lines.length && /^\s*>\s?/.test(lines[lineIndex] ?? '')) {
        quoteLines.push((lines[lineIndex] ?? '').replace(/^\s*>\s?/, ''))
        lineIndex += 1
      }
      blocks.push({
        id: `block-${startLine}-quote`,
        kind: 'blockquote',
        children: parseInlineMarkdown(quoteLines.join(' '), `block-${startLine}`),
      })
      continue
    }

    const unorderedMatch = line.match(UNORDERED_LIST_PATTERN)
    const orderedMatch = line.match(ORDERED_LIST_PATTERN)
    if (unorderedMatch || orderedMatch) {
      const startLine = lineIndex
      const ordered = Boolean(orderedMatch)
      const pattern = ordered ? ORDERED_LIST_PATTERN : UNORDERED_LIST_PATTERN
      const items: Array<{ id: string; children: MarkdownInlineNode[] }> = []
      while (lineIndex < lines.length) {
        const itemMatch = (lines[lineIndex] ?? '').match(pattern)
        if (!itemMatch) break
        const itemId = `block-${startLine}-item-${lineIndex}`
        items.push({
          id: itemId,
          children: parseInlineMarkdown(itemMatch[1] ?? '', itemId),
        })
        lineIndex += 1
      }
      blocks.push({ id: `block-${startLine}-list`, kind: 'list', ordered, items })
      continue
    }

    const startLine = lineIndex
    const paragraphLines = [line.trim()]
    lineIndex += 1
    while (lineIndex < lines.length && !startsBlock(lines[lineIndex] ?? '')) {
      paragraphLines.push((lines[lineIndex] ?? '').trim())
      lineIndex += 1
    }
    blocks.push({
      id: `block-${startLine}-paragraph`,
      kind: 'paragraph',
      children: parseInlineMarkdown(paragraphLines.join(' '), `block-${startLine}`),
    })
  }

  return blocks
}
