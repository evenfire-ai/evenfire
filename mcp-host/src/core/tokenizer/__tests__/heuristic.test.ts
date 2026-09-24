import { describe, expect, it } from 'vitest'
import { minifiedMcpResult } from '../../../__tests__/fixtures/minifiedMcpResult'
import type { ChatMessage, ToolDefinition } from '../../types'
import { heuristicCount, heuristicCountTools } from '../heuristic'

describe('heuristicCount', () => {
  it('returns 0 for empty array', () => {
    expect(heuristicCount([])).toBe(0)
  })

  it('counts ceil(chars/4)+4 per message', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'one two three four five' }, // 23 chars → ceil(23/4)=6, +4 = 10
      { role: 'assistant', content: 'a b' }, // 3 chars → ceil(3/4)=1, +4 = 5
    ]
    expect(heuristicCount(msgs)).toBe(15)
  })

  it('treats missing content as empty string', () => {
    const msgs: ChatMessage[] = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'x', name: 'y', arguments: {} }] },
    ]
    // '' → ceil(0/4)=0, +4 = 4, plus the empty arguments object: `JSON.stringify({})`
    // is '{}', 2 chars → ceil(2/4) = 1. The 1 is the whole point — it is the
    // smallest observable contribution of the `tool_calls` walk A2 added, so
    // this pin doubles as the witness that the walk runs on every message and
    // not only on the large payload T-A2 feeds it.
    expect(heuristicCount(msgs)).toBe(5)
  })

  it('T-A1 counts minified JSON by characters, not by whitespace-separated words', () => {
    // #731 — a tool result carrying dense minified JSON is the payload shape
    // that breaks a word count. `heuristicCountTools` applied `ceil(chars / 4)`
    // for exactly this reason before #731; messages, where tool RESULTS live,
    // counted words until #731 gave them the same measure.
    const content = minifiedMcpResult(1, 33_000)
    const msg: ChatMessage = {
      role: 'tool',
      content,
      tool_call_id: 'call_1',
      name: 'crm_search_contacts',
    }
    expect(heuristicCount([msg])).toBeGreaterThanOrEqual(Math.ceil(content.length / 4))
  })

  it('T-A2 counts assistant tool_calls arguments', () => {
    // #731 — the other half of the undercount. An assistant message that issues
    // a tool call carries its payload in `tool_calls[].arguments`, never in
    // `content`, so a count that reads `content` alone bills the whole call at
    // the 4-token framing overhead. `openaiTokenCounter.ts:58-62` already walks
    // `tool_calls`; the heuristic did not.
    const args = JSON.parse(minifiedMcpResult(7, 4_000)) as Record<string, unknown>
    const msg: ChatMessage = {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_7', name: 'crm_bulk_update', arguments: args }],
    }
    // `content` is empty, so everything above the framing overhead comes from
    // the arguments: ~4,000 chars → ~1,000 tokens.
    expect(heuristicCount([msg])).toBeGreaterThanOrEqual(1_000)
  })

  // The provider attempt contract measures `Buffer.byteLength(JSON.stringify(request))`:
  // UTF-8 bytes of the JSON-escaped text. A count of UTF-16 code units under-reads
  // everything that is not plain ASCII, so the gauge sat below 0.8 while the
  // request was already over the cap (review r2, M2).
  const wireBytes = (s: string): number => Buffer.byteLength(JSON.stringify(s), 'utf8') - 2

  it('T-R2-1a counts CJK content by its UTF-8 bytes', () => {
    const content = '漢'.repeat(1_000) // 1,000 code units, 3,000 UTF-8 bytes
    expect(wireBytes(content)).toBe(3_000)
    expect(heuristicCount([{ role: 'tool', content, tool_call_id: 'c' }])).toBe(750 + 4)
  })

  it('T-R2-1b counts control characters by their JSON escapes', () => {
    const content = '\u0001'.repeat(1_000) // each serializes as `\u0001`, 6 bytes
    expect(wireBytes(content)).toBe(6_000)
    expect(heuristicCount([{ role: 'tool', content, tool_call_id: 'c' }])).toBe(1_500 + 4)
  })

  it('T-R2-1c counts the escaped quotes of minified JSON carried as a string', () => {
    const content = minifiedMcpResult(2, 8_000)
    // Witness that the payload has escapes at all, so the assertion below is not
    // satisfied by a plain length count.
    expect(wireBytes(content)).toBeGreaterThan(content.length)
    expect(heuristicCount([{ role: 'tool', content, tool_call_id: 'c' }])).toBe(
      Math.ceil(wireBytes(content) / 4) + 4
    )
  })

  it('T-R2-1d counts tool_calls arguments by their UTF-8 bytes', () => {
    const args = { q: '漢'.repeat(1_000) }
    const bytes = Buffer.byteLength(JSON.stringify(args), 'utf8') // 3,008
    expect(
      heuristicCount([
        { role: 'assistant', content: '', tool_calls: [{ id: 'x', name: 'y', arguments: args }] },
      ])
    ).toBe(4 + Math.ceil(bytes / 4))
  })
})

describe('heuristicCountTools', () => {
  it('returns 0 for empty array', () => {
    expect(heuristicCountTools([])).toBe(0)
  })

  it('counts ceil(chars/4)+4 per tool over name+description+serialized parameters', () => {
    const tools: ToolDefinition[] = [
      // text = 'a\nd\n{"type":"object"}' → 21 chars → ceil(21/4)+4 = 6 + 4 = 10
      { name: 'a', description: 'd', parameters: { type: 'object' } },
    ]
    expect(heuristicCountTools(tools)).toBe(10)
  })

  it('treats missing parameters as empty object', () => {
    // text = 'a\nd\n{}' → 6 chars → ceil(6/4)+4 = 2 + 4 = 6
    const tools = [{ name: 'a', description: 'd' } as ToolDefinition]
    expect(heuristicCountTools(tools)).toBe(6)
  })

  it('is monotonic — a larger schema yields a higher count', () => {
    const small: ToolDefinition[] = [
      { name: 'a', description: 'd', parameters: { type: 'object' } },
    ]
    const large: ToolDefinition[] = [
      {
        name: 'a',
        description: 'd',
        parameters: {
          type: 'object',
          properties: { q: { type: 'string' }, limit: { type: 'number' } },
        },
      },
    ]
    expect(heuristicCountTools(large)).toBeGreaterThan(heuristicCountTools(small))
  })

  it('T-R2-1e counts a non-ASCII description by its UTF-8 bytes', () => {
    // name 1 + '\n' 1 + description 3,000 bytes + '\n' 1 + '{}' 2 = 3,005 → ceil/4 = 752, +4
    const tools = [{ name: 'a', description: '漢'.repeat(1_000) } as ToolDefinition]
    expect(heuristicCountTools(tools)).toBe(752 + 4)
  })
})
