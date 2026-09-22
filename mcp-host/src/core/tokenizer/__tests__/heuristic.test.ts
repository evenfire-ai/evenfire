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
    // '' → ceil(0/4)=0, +4 = 4. The framing overhead is all that remains, and
    // the `tool_calls` payload is still uncounted here — A2 (#731, step 3) is
    // what adds it.
    expect(heuristicCount(msgs)).toBe(4)
  })

  it('T-A1 counts minified JSON by characters, not by whitespace-separated words', () => {
    // #731 — a tool result carrying dense minified JSON is the payload shape
    // that breaks a word count. `heuristicCountTools` already applies
    // `ceil(chars / 4)` for exactly this reason (see its comment); messages,
    // where tool RESULTS live, never got the same correction.
    const content = minifiedMcpResult(1, 33_000)
    const msg: ChatMessage = {
      role: 'tool',
      content,
      tool_call_id: 'call_1',
      name: 'crm_search_contacts',
    }
    expect(heuristicCount([msg])).toBeGreaterThanOrEqual(Math.ceil(content.length / 4))
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
})
