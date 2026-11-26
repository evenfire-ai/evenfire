import { describe, expect, it } from 'vitest'
import {
  SLACK_CHAT_POST_TEXT_LIMIT,
  SLACK_CHAT_UPDATE_TEXT_LIMIT,
  SLACK_SECTION_TEXT_LIMIT,
  planSlackReply,
  splitSlackText,
} from '../../src/channels/slackText'

function essay(wordCount: number, word = 'review'): string {
  return Array.from({ length: wordCount }, () => word).join(' ')
}

function assertIntact(text: string, limit: number): string[] {
  const chunks = splitSlackText(text, limit)
  expect(chunks.join('')).toBe(text)
  for (const chunk of chunks) {
    const fenceOpens = chunk.match(/```/g)?.length ?? 0
    if (chunk.length > limit) {
      expect(/^( {0,3})?(```|~~~)/.test(chunk)).toBe(true)
      expect(fenceOpens % 2).toBe(0)
    } else {
      expect(chunk.length).toBeLessThanOrEqual(limit)
    }
  }
  return chunks
}

describe('splitSlackText', () => {
  it('keeps a 600-word answer whole when it fits and splits it when it does not', () => {
    const text = essay(600)
    expect(text.split(/\s+/)).toHaveLength(600)
    expect(text.length).toBeGreaterThan(SLACK_CHAT_UPDATE_TEXT_LIMIT)
    const chunks = assertIntact(text, SLACK_CHAT_UPDATE_TEXT_LIMIT)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(chunk => chunk.length <= SLACK_CHAT_UPDATE_TEXT_LIMIT)).toBe(true)
  })

  it('splits a 5,000-word answer without dropping words', () => {
    const text = essay(5_000)
    expect(text.split(/\s+/)).toHaveLength(5_000)
    const chunks = assertIntact(text, SLACK_CHAT_UPDATE_TEXT_LIMIT)
    expect(chunks.length).toBeGreaterThan(5)
    expect(chunks.join(' ').split(/\s+/).filter(Boolean)).toHaveLength(5_000)
  })

  it('does not cut inside a fenced code block', () => {
    const fence = '```ts\n' + 'const value = 1\n'.repeat(400) + '```'
    expect(fence.length).toBeGreaterThan(SLACK_CHAT_UPDATE_TEXT_LIMIT)
    const text = `Before the sample.\n\n${fence}\n\nAfter the sample.`
    const chunks = assertIntact(text, SLACK_CHAT_UPDATE_TEXT_LIMIT)
    const codeChunks = chunks.filter(chunk => chunk.includes('const value = 1'))
    expect(codeChunks).toHaveLength(1)
    expect(codeChunks[0]).toContain(fence)
    expect(codeChunks[0]?.startsWith('```')).toBe(true)
  })

  it('does not split a fence indented by 1 to 3 spaces', () => {
    for (const openIndent of [1, 2, 3]) {
      for (const closeIndent of [0, 1, 2, 3]) {
        const fence =
          `${' '.repeat(openIndent)}\`\`\`ts\n` +
          'const value = 1\n'.repeat(400) +
          `${' '.repeat(closeIndent)}\`\`\``
        expect(fence.length).toBeGreaterThan(SLACK_CHAT_UPDATE_TEXT_LIMIT)
        const text = `Before the sample.\n\n${fence}\n\nAfter the sample.`
        const chunks = assertIntact(text, SLACK_CHAT_UPDATE_TEXT_LIMIT)
        const codeChunks = chunks.filter(chunk => chunk.includes('const value = 1'))
        expect(codeChunks).toHaveLength(1)
        expect(codeChunks[0]).toContain(fence)
      }
    }
  })

  it('still splits a fence indented by 4 spaces', () => {
    const fence = `    \`\`\`\n${'const value = 1\n'.repeat(400)}    \`\`\``
    expect(fence.length).toBeGreaterThan(SLACK_CHAT_UPDATE_TEXT_LIMIT)
    const chunks = splitSlackText(fence, SLACK_CHAT_UPDATE_TEXT_LIMIT)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(fence)
  })

  it.each([SLACK_SECTION_TEXT_LIMIT, SLACK_CHAT_UPDATE_TEXT_LIMIT, SLACK_CHAT_POST_TEXT_LIMIT])(
    'keeps text just under %i in one piece and splits text just over it',
    limit => {
      const under = `para ${'a'.repeat(limit - 6)}`
      expect(under.length).toBeLessThanOrEqual(limit)
      expect(splitSlackText(under, limit)).toEqual([under])

      const over = `${'a'.repeat(limit - 10)}\n\n${'b'.repeat(40)}`
      expect(over.length).toBeGreaterThan(limit)
      const chunks = assertIntact(over, limit)
      expect(chunks.length).toBeGreaterThan(1)
      expect(chunks[0]?.endsWith('a')).toBe(true)
      expect(chunks.at(-1)).toContain('b')
    }
  )
})

describe('planSlackReply', () => {
  it('edits the first chunk and posts the rest for a long answer', () => {
    const text = essay(5_000)
    const plan = planSlackReply(text)
    expect(plan.acknowledgement.length).toBeLessThanOrEqual(SLACK_CHAT_UPDATE_TEXT_LIMIT)
    expect(plan.acknowledgementIsPlaceholder).toBe(false)
    const followUps = plan.followUps.map(part => (part.kind === 'message' ? part.text : part.text))
    expect([plan.acknowledgement, ...followUps].join('')).toBe(text)
    expect(plan.followUps.every(part => part.kind === 'message' && part.text.length <= 4000)).toBe(
      true
    )
  })

  it('does not emit a blank piece between two long fences', () => {
    const fence = (label: string) => '```\n' + label.repeat(5_400) + '\n```'
    const text = `${fence('x')}\n\n${fence('y')}`
    const parts = splitSlackText(text, SLACK_CHAT_UPDATE_TEXT_LIMIT)
    expect(parts.every(part => part.trim().length > 0)).toBe(true)
    expect(parts.join('')).toBe(text)
    const plan = planSlackReply(text)
    expect(plan.followUps.every(part => part.text.trim().length > 0)).toBe(true)
    expect(plan.followUps.filter(part => part.kind === 'message')).toEqual([])
  })

  it('keeps a trailing blank line on the previous piece', () => {
    const text = `${'a'.repeat(3_999)}\n\n\n`
    const parts = splitSlackText(text, SLACK_CHAT_UPDATE_TEXT_LIMIT)
    expect(parts.some(part => part.trim().length === 0)).toBe(false)
    expect(parts.join('')).toBe(text)
  })

  it('uploads a code block that cannot fit in an edit', () => {
    const fence = '```\n' + 'x'.repeat(5_000) + '\n```'
    const plan = planSlackReply(`Intro\n\n${fence}`)
    expect(plan.acknowledgement.startsWith('Intro')).toBe(true)
    expect(plan.acknowledgement.length).toBeLessThanOrEqual(SLACK_CHAT_UPDATE_TEXT_LIMIT)
    expect(plan.acknowledgement).not.toContain(fence)
    expect(plan.acknowledgement).not.toContain('x'.repeat(20))
    expect(plan.followUps).toEqual([{ kind: 'snippet', filename: 'reply-part-2.txt', text: fence }])
  })

  it('does not close a fence on an info-string line', () => {
    const text = '```\nexample\n```python\nprint(1)\n```\n'
    const parts = splitSlackText(text, 20)
    expect(parts.join('')).toBe(text)
    const body = parts.find(part => part.includes('print(1)'))
    expect(body?.startsWith('```')).toBe(true)
    expect(body).toContain('```python')
  })

  it('closes a three-backtick fence with a longer fence line', () => {
    const text = '```\ncode\n````\n'
    const parts = splitSlackText(text, 4)
    expect(parts.join('')).toBe(text)
    expect(parts.filter(part => part.includes('code')).length).toBe(1)
  })

  it('does not split a surrogate pair', () => {
    const emoji = '😀'
    expect(emoji.length).toBe(2)
    const text = `${'a'.repeat(3_999)}${emoji}${'b'.repeat(20)}`
    const parts = splitSlackText(text, SLACK_CHAT_UPDATE_TEXT_LIMIT)
    expect(parts.join('')).toBe(text)
    expect(parts.some(part => part.includes('\uFFFD'))).toBe(false)
    expect(parts.some(part => part.endsWith('\uD83D') && !part.endsWith(emoji))).toBe(false)
  })

  it('uploads the tail once follow-up messages pass the cap', () => {
    const paragraph = 'a'.repeat(3_990)
    const text = Array.from({ length: 12 }, () => paragraph).join('\n\n')
    const plan = planSlackReply(text)
    const messages = plan.followUps.filter(part => part.kind === 'message')
    expect(messages.length).toBeLessThanOrEqual(8)
    expect(
      plan.followUps.some(part => part.kind === 'snippet' && part.filename === 'reply-rest.txt')
    ).toBe(true)
    const restored = [plan.acknowledgement, ...plan.followUps.map(part => part.text)].join('')
    expect(restored).toBe(text)
  })
})
