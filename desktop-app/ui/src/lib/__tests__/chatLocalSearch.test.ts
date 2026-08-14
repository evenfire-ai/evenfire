import { describe, expect, it } from 'vitest'
import type { AgentChatMessage } from '../../uiTypes'
import {
  findLoadedChatMessageMatches,
  markdownSearchableText,
  wrapMatchIndex,
} from '../chatLocalSearch'

function message(id: string, content: string, role: AgentChatMessage['role'] = 'assistant') {
  return { id, content, role, timestamp: 1 } satisfies AgentChatMessage
}

describe('loaded chat local search', () => {
  it('matches case-insensitively across renderer-owned loaded message data', () => {
    expect(
      findLoadedChatMessageMatches(
        [message('one', 'Alpha alpha'), message('two', 'BETA Alpha')],
        'ALPHA'
      )
    ).toEqual([
      { messageId: 'one', occurrence: 0 },
      { messageId: 'one', occurrence: 1 },
      { messageId: 'two', occurrence: 0 },
    ])
  })

  it('uses visible user text rather than hidden attachment prompt content', () => {
    const content =
      'Visible question\n\nUSER-ATTACHED CONTEXT: The user selected these capabilities/files for this message.\nPlugins: hidden-search-plugin.'
    expect(
      findLoadedChatMessageMatches([message('user', content, 'user')], 'visible')
    ).toHaveLength(1)
    expect(
      findLoadedChatMessageMatches([message('user', content, 'user')], 'hidden-search')
    ).toEqual([])
  })

  it('counts visible Markdown text without hidden destinations or syntax metadata', () => {
    const content = [
      '# Needle heading',
      '[needle link](https://needle.example/path "needle title")',
      '```needle-language',
      'needle in code',
      '```',
      '[hidden-ref]: https://example.test/needle "needle title"',
    ].join('\n')

    expect(markdownSearchableText(content)).not.toContain('needle.example')
    expect(findLoadedChatMessageMatches([message('assistant', content)], 'needle')).toEqual([
      { messageId: 'assistant', occurrence: 0 },
      { messageId: 'assistant', occurrence: 1 },
      { messageId: 'assistant', occurrence: 2 },
    ])
  })

  it('wraps forward and backward through loaded matches', () => {
    expect(wrapMatchIndex(2, 3, 1)).toBe(0)
    expect(wrapMatchIndex(0, 3, -1)).toBe(2)
    expect(wrapMatchIndex(0, 0, 1)).toBe(0)
  })
})
