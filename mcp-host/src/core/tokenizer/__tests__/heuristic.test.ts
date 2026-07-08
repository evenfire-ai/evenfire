import { describe, expect, it } from 'vitest'
import type { ChatMessage, ToolDefinition } from '../../types'
import { heuristicCount, heuristicCountTools } from '../heuristic'

describe('heuristicCount', () => {
  it('returns 0 for empty array', () => {
    expect(heuristicCount([])).toBe(0)
  })

  it('counts floor(words*1.3)+4 per message', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'one two three four five' }, // 5 words → 6 + 4 = 10
      { role: 'assistant', content: 'a b' }, // 2 words → 2 + 4 = 6
    ]
    expect(heuristicCount(msgs)).toBe(16)
  })

  it('treats missing content as empty string', () => {
    const msgs: ChatMessage[] = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'x', name: 'y', arguments: {} }] },
    ]
    // '' splits into [''] (length 1) → floor(1.3)+4 = 5
    expect(heuristicCount(msgs)).toBe(5)
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
