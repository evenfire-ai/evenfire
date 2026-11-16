import { describe, expect, it } from 'vitest'
import {
  TOOL_APPROVAL_MAX_PARTS,
  TOOL_APPROVAL_PART_LIMIT,
  splitToolApprovalText,
} from '../src/toolApprovalParts'

const telegram = TOOL_APPROVAL_PART_LIMIT.telegram!
const slack = TOOL_APPROVAL_PART_LIMIT.slack!
const teams = TOOL_APPROVAL_PART_LIMIT.teams!

describe('splitToolApprovalText', () => {
  it('returns the content as one part when it is exactly at the limit', () => {
    const oneLine = 'a'.repeat(4096)
    expect(splitToolApprovalText(oneLine, telegram)).toEqual([oneLine])

    const lines = ['b'.repeat(2000), 'c'.repeat(2095)].join('\n')
    expect(lines.length).toBe(4096)
    expect(splitToolApprovalText(lines, telegram)).toEqual([lines])
  })

  it('packs whole lines into parts and splits only between them', () => {
    const content = Array.from({ length: 30 }, (_, i) => `line ${i} ${'x'.repeat(400)}`).join('\n')
    const parts = splitToolApprovalText(content, telegram)!
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.join('\n')).toBe(content)
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(4096)

    // a + 1 + b at the limit is one part; one more character makes two.
    const a = 'd'.repeat(2000)
    const fits = `${a}\n${'e'.repeat(4096 - 2000 - 1)}`
    expect(fits.length).toBe(4096)
    expect(splitToolApprovalText(fits, telegram)).toEqual([fits])
    const over = `${a}\n${'e'.repeat(4096 - 2000)}`
    expect(over.length).toBe(4097)
    expect(splitToolApprovalText(over, telegram)).toEqual([a, 'e'.repeat(4096 - 2000)])
  })

  it('returns null when one line is longer than the limit', () => {
    expect(splitToolApprovalText('f'.repeat(4097), telegram)).toBeNull()
    expect(splitToolApprovalText(['short', 'g'.repeat(3001), 'short'].join('\n'), slack)).toBeNull()
  })

  it('never splits inside an entity, a surrogate pair or an escape', () => {
    const head = 'x'.repeat(2998)
    const cases = [
      { token: '&amp;', witness: (cut: string) => cut.endsWith('&') },
      {
        token: '\u{1F600}',
        witness: (cut: string) => {
          const last = cut.charCodeAt(cut.length - 1)
          return last >= 0xd800 && last <= 0xdbff
        },
      },
      { token: String.raw`\u{E0001}`, witness: (cut: string) => cut.endsWith('\\') },
    ]
    for (const { token, witness } of cases) {
      const content = `${head}\n${token.repeat(10)}\n${'y'.repeat(20)}`
      // Witness: a cut at the limit would end inside the token.
      const naive = content.substring(0, 3000)
      expect(witness(naive)).toBe(true)
      expect(naive.endsWith(token)).toBe(false)

      const parts = splitToolApprovalText(content, slack)!
      expect(parts.length).toBeGreaterThan(1)
      expect(parts.flatMap(part => part.split('\n'))).toEqual(content.split('\n'))
    }
  })

  it('measures Telegram and Slack in UTF-16 units and Teams in JSON-encoded UTF-8 bytes', () => {
    expect(telegram.max).toBe(4096)
    expect(telegram.size('\u{1F600}')).toBe(2)
    expect(slack.max).toBe(3000)
    expect(slack.size('&amp;')).toBe(5)
    expect(teams.max).toBe(12_000)

    // 3,999 three-byte characters are 11,997 bytes, 11,999 with their quotes.
    const fits = '€'.repeat(3999)
    expect(teams.size(fits)).toBe(11_999)
    expect(splitToolApprovalText(fits, teams)).toEqual([fits])
    // 4,000 are 12,002 bytes, while 4,000 UTF-16 units are under every character limit.
    const over = '€'.repeat(4000)
    expect(over.length).toBe(4000)
    expect(teams.size(over)).toBe(12_002)
    expect(splitToolApprovalText(over, teams)).toBeNull()

    expect(TOOL_APPROVAL_PART_LIMIT.email).toBeUndefined()
  })

  it('returns null when a part would have no visible text', () => {
    expect(splitToolApprovalText(`${'h'.repeat(4096)}\n   `, telegram)).toBeNull()
    expect(splitToolApprovalText('', telegram)).toBeNull()
    // Witness: the same content with visible text in that part is split.
    expect(splitToolApprovalText(`${'h'.repeat(4096)}\n  i`, telegram)).toEqual([
      'h'.repeat(4096),
      '  i',
    ])
  })

  it('allows at most TOOL_APPROVAL_MAX_PARTS parts', () => {
    expect(TOOL_APPROVAL_MAX_PARTS).toBe(24)
    const fullLine = (i: number) => `${String(i).padStart(2, '0')}${'j'.repeat(4094)}`
    const twentyFour = Array.from({ length: 24 }, (_, i) => fullLine(i)).join('\n')
    const parts = splitToolApprovalText(twentyFour, telegram)!
    expect(parts).toHaveLength(24)
    expect(parts.join('\n')).toBe(twentyFour)

    const twentyFive = Array.from({ length: 25 }, (_, i) => fullLine(i)).join('\n')
    expect(splitToolApprovalText(twentyFive, telegram)).toBeNull()
  })
})
