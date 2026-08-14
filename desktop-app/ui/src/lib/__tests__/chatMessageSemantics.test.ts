import { describe, expect, it } from 'vitest'
import type { AgentChatMessage } from '../../uiTypes'
import {
  annotateChatSemanticTree,
  buildChatMessageSemanticModel,
  findChatSemanticMatches,
} from '../chatMessageSemantics'

function assistant(content: string): AgentChatMessage {
  return { id: 'assistant-1', role: 'assistant', content, timestamp: 1 }
}

function textValues(node: unknown): string {
  if (!node || typeof node !== 'object') return ''
  const value = node as { type?: string; value?: string; children?: unknown[] }
  if (value.type === 'text') return value.value ?? ''
  return value.children?.map(textValues).join('') ?? ''
}

function markCount(node: unknown): number {
  if (!node || typeof node !== 'object') return 0
  const value = node as { tagName?: string; children?: unknown[] }
  return (
    (value.tagName === 'mark' ? 1 : 0) +
    (value.children?.map(markCount).reduce((total, count) => total + count, 0) ?? 0)
  )
}

describe('chat message Markdown semantic model', () => {
  it('derives visible text and logical highlights from the same immutable tree', () => {
    const model = buildChatMessageSemanticModel(
      assistant('# Heading\n\nA cross **node** and [visible link](https://example.test/hidden).')
    )
    const matches = findChatSemanticMatches(model, 'cross node')
    const annotated = annotateChatSemanticTree(model, 'cross node', 0)

    expect(matches).toHaveLength(1)
    expect(matches[0]?.ranges).toHaveLength(2)
    expect(markCount(annotated)).toBe(2)
    expect(textValues(annotated)).toContain('A cross node and visible link.')
    expect(model.searchText).not.toContain('example.test')
    expect(Object.isFrozen(model.renderTree)).toBe(true)
  })

  it('preserves code, entities, raw HTML text, and excludes invisible Markdown metadata', () => {
    const model = buildChatMessageSemanticModel(
      assistant(
        [
          '&amp; escaped',
          '`inline code`',
          '````js',
          '```needle',
          'fenced needle',
          '````',
          '<button onclick="evil()">literal</button>',
          '[ref label][target]',
          '[target]: javascript:alert(1) "hidden title"',
          '![hidden image metadata](https://example.test/image.png)',
        ].join('\n\n')
      )
    )

    expect(model.searchText).toContain('& escaped')
    expect(model.searchText).toContain('inline code')
    expect(model.searchText).toContain('```needle')
    expect(model.searchText).toContain('fenced needle')
    expect(model.searchText).toContain('<button onclick="evil()">literal</button>')
    expect(model.searchText).toContain('ref label')
    expect(model.searchText).not.toContain('hidden title')
    expect(model.searchText).not.toContain('hidden image metadata')
    expect(findChatSemanticMatches(model, 'needle')).toHaveLength(2)
  })

  it('prevents logical matches from crossing blocks and GFM table cells', () => {
    const blocks = buildChatMessageSemanticModel(assistant('alpha\n\nbeta'))
    const table = buildChatMessageSemanticModel(assistant('| alpha | beta |\n| --- | --- |'))
    const inline = buildChatMessageSemanticModel(assistant('alpha **beta**'))

    expect(findChatSemanticMatches(blocks, 'alpha beta')).toEqual([])
    expect(findChatSemanticMatches(table, 'alpha beta')).toEqual([])
    expect(findChatSemanticMatches(inline, 'alpha beta')).toHaveLength(1)
  })

  it('preserves the transcript plain-text contract for JSON-shaped assistant output', () => {
    const model = buildChatMessageSemanticModel(assistant('{**not valid JSON**}'))

    expect(model.representation).toBe('plain')
    expect(model.searchText).toBe('{**not valid JSON**}')
    expect(findChatSemanticMatches(model, '**not valid JSON**')).toHaveLength(1)
  })

  it('maps Unicode case-fold expansions back to valid original UTF-16 slices', () => {
    const model = buildChatMessageSemanticModel(assistant('İstanbul 😀 STRASSE'))
    const dotted = findChatSemanticMatches(model, 'i̇stanbul')
    const emoji = findChatSemanticMatches(model, '😀')

    expect(dotted).toHaveLength(1)
    expect(dotted[0]?.ranges[0]).toMatchObject({ start: 0, end: 8 })
    expect(emoji).toHaveLength(1)
    expect(emoji[0]?.ranges[0]).toMatchObject({ start: 9, end: 11 })
  })

  it('handles adversarial destination-like input without a projection regex', () => {
    const hostile = `[label](${String.raw`\(`.repeat(20_000)}destination)`
    const started = performance.now()
    const model = buildChatMessageSemanticModel(assistant(hostile))
    expect(findChatSemanticMatches(model, 'label')).toHaveLength(1)
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  it('maps dense inline matches without rescanning every fragment per occurrence', () => {
    const model = buildChatMessageSemanticModel(assistant(Array(8_000).fill('*a*').join(' ')))
    const started = performance.now()

    expect(findChatSemanticMatches(model, 'a')).toHaveLength(8_000)
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})
