import { describe, expect, it } from 'vitest'
import {
  TITLE_ELLIPSIS,
  agentChatPlaceholder,
  remotePlaceholder,
  truncateTitle,
} from '@lib/chatTitle'

describe('truncateTitle (spec 15 §2.4)', () => {
  it('returns the input unchanged when at or under the 60 code-point budget', () => {
    expect(truncateTitle('')).toBe('')
    expect(truncateTitle('short title')).toBe('short title')
    const exactly60 = 'a'.repeat(60)
    expect(truncateTitle(exactly60)).toBe(exactly60)
  })

  it('cuts at the last space at or before the budget and appends the ellipsis', () => {
    const input = `${'a'.repeat(50)} ${'b'.repeat(50)}`
    expect(truncateTitle(input)).toBe(`${'a'.repeat(50)}${TITLE_ELLIPSIS}`)
  })

  // T3 (pr-discipline): documents the §2.4 bug this helper replaces. The old
  // inline version was `substring(0, seed.lastIndexOf(' ', 60) || 60) + '...'`.
  // With no space in the first 60 chars `lastIndexOf` returns -1, which is
  // truthy, so `substring(0, -1)` collapsed to `substring(0, 0)` === '' and the
  // title became just '...'. This assertion FAILS against that buggy logic
  // (which would yield '...'), and passes here.
  it('does NOT degrade to a bare suffix when there is no space in the first 60', () => {
    const input = 'a'.repeat(61)
    const out = truncateTitle(input)
    expect(out).toBe(`${'a'.repeat(60)}${TITLE_ELLIPSIS}`)
    expect(out).not.toBe(TITLE_ELLIPSIS)
    expect(out).not.toBe('...')
    expect(out.startsWith('a'.repeat(60))).toBe(true)
  })

  it('never splits a surrogate pair at the boundary (works on code points)', () => {
    const input = '😀'.repeat(61)
    const out = truncateTitle(input)
    const codePoints = Array.from(out)
    // 60 emoji code points + the ellipsis, no lone surrogate / replacement char.
    expect(codePoints).toHaveLength(61)
    expect(codePoints[59]).toBe('😀')
    expect(codePoints[60]).toBe(TITLE_ELLIPSIS)
    expect(out).not.toContain('�')
  })

  it('cuts hard at 60 code points when the only space is at index 0', () => {
    const input = ` ${'a'.repeat(70)}`
    const out = truncateTitle(input)
    // A leading-space cut would yield an empty prefix; fall back to a hard cut.
    expect(out).toBe(` ${'a'.repeat(59)}${TITLE_ELLIPSIS}`)
  })
})

describe('placeholders (spec 15 §2.2 case B)', () => {
  it('remotePlaceholder uses the first 8 chars of the chat id', () => {
    expect(remotePlaceholder('abcdefgh-1234-5678')).toBe('Remote · abcdefgh')
  })

  it('agentChatPlaceholder uses the first 8 chars of the chat id', () => {
    expect(agentChatPlaceholder('abcdefgh-1234-5678')).toBe('Chat abcdefgh')
  })
})
