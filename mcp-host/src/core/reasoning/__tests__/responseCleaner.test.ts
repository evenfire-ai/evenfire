import { describe, expect, it } from 'vitest'
import {
  cleanResponse,
  extractJson,
  stripReasoningPatterns,
  stripThinkingTags,
} from '../responseCleaner'

describe('stripThinkingTags', () => {
  it('should remove complete thinking tags', () => {
    expect(stripThinkingTags('<thinking>internal reasoning</thinking>The answer is 42')).toBe(
      'The answer is 42'
    )
  })

  it('should remove multiple thinking blocks', () => {
    expect(
      stripThinkingTags('<thinking>first</thinking>Hello <thinking>second</thinking>world')
    ).toBe('Hello world')
  })

  it('should handle unclosed thinking tags by truncating from opening tag (Risk 3.1)', () => {
    expect(stripThinkingTags('<thinking>partial reasoning')).toBe('')
  })

  it('should handle text before unclosed thinking tag', () => {
    expect(stripThinkingTags('Answer is 42.<thinking>let me verify')).toBe('Answer is 42.')
  })

  it('should return text unchanged when no thinking tags present', () => {
    expect(stripThinkingTags('no tags here')).toBe('no tags here')
  })

  it('should be case-insensitive', () => {
    expect(stripThinkingTags('<THINKING>uppercase</THINKING>result')).toBe('result')
  })

  it('should remove short think tags returned by reasoning models', () => {
    expect(stripThinkingTags('<think>internal trace</think>Visible answer')).toBe('Visible answer')
  })
})

describe('stripReasoningPatterns', () => {
  it('should remove preamble reasoning at start of string (Risk 3.2)', () => {
    expect(stripReasoningPatterns('Let me think about this. The answer is 42')).toBe(
      'The answer is 42'
    )
  })

  it('should preserve quoted reasoning mid-content (Risk 3.2)', () => {
    const text = 'He said "Let me think about this" before answering.'
    expect(stripReasoningPatterns(text)).toBe(text)
  })

  it('should handle multiple preamble patterns', () => {
    expect(stripReasoningPatterns('Let me analyze... Here are the results')).toBe(
      'Here are the results'
    )
  })
})

describe('extractJson', () => {
  it('should parse raw JSON string', () => {
    expect(extractJson('{"key": "value"}')).toEqual({ key: 'value' })
  })

  it('should extract JSON from markdown code block', () => {
    const text = 'Here is the result:\n```json\n{"success": true}\n```\nDone.'
    expect(extractJson(text)).toEqual({ success: true })
  })

  it('should return null when no valid JSON found', () => {
    expect(extractJson('no json here at all')).toBeNull()
  })
})

describe('cleanResponse', () => {
  it('should apply full pipeline: thinking tags + reasoning patterns + trim', () => {
    const input = '  <thinking>hmm</thinking>Let me think about this. The answer is 42  '
    expect(cleanResponse(input)).toBe('The answer is 42')
  })

  it('should be idempotent', () => {
    const input = '<thinking>x</thinking>Hello world'
    const first = cleanResponse(input)
    const second = cleanResponse(first)
    expect(first).toBe(second)
  })
})
