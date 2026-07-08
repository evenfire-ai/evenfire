import { describe, expect, it } from 'vitest'
import { ToolTrace, buildToolTraces, truncate } from '../../../src/observability/toolTracer'

describe('truncate', () => {
  it('returns string unchanged if below limit', () => {
    expect(truncate('short', 1024)).toBe('short')
  })

  it('truncates at exactly maxChars with suffix', () => {
    const input = 'a'.repeat(2000)
    const result = truncate(input, 1024)
    expect(result.startsWith('a'.repeat(1024))).toBe(true)
    expect(result).toContain('...[truncated 976 chars]')
  })

  it('serializes non-string values with JSON.stringify', () => {
    const obj = { key: 'value' }
    expect(truncate(obj)).toBe(JSON.stringify(obj))
  })

  it('handles null without throwing', () => {
    expect(truncate(null)).toBe('null')
  })

  it('handles undefined without throwing', () => {
    expect(truncate(undefined)).toBe('undefined')
  })

  it('handles unicode correctly (counts chars, not bytes)', () => {
    const emoji = '\u{1F600}'.repeat(600) // 600 emoji chars
    const result = truncate(emoji, 500)
    expect(result.length).toBeGreaterThan(500)
    expect(result).toContain('...[truncated')
  })

  it('suffix includes exact count of truncated chars', () => {
    const input = 'x'.repeat(1030)
    const result = truncate(input, 1024)
    expect(result).toContain('...[truncated 6 chars]')
  })

  it('custom maxChars parameter is respected', () => {
    const input = 'abcdefghij'
    const result = truncate(input, 5)
    expect(result.startsWith('abcde')).toBe(true)
    expect(result).toContain('...[truncated 5 chars]')
  })

  it('on empty string returns empty string', () => {
    expect(truncate('')).toBe('')
  })
})

describe('buildToolTraces', () => {
  const makeTrace = (i: number): ToolTrace => ({
    toolName: `tool-${i}`,
    calledAt: new Date().toISOString(),
    durationMs: 100,
    inputSummary: 'input',
    outputSummary: 'output',
    success: true,
  })

  it('passes through traces under 50 limit', () => {
    const raw = Array.from({ length: 10 }, (_, i) => makeTrace(i))
    const { traces, truncated } = buildToolTraces(raw)
    expect(traces).toHaveLength(10)
    expect(truncated).toBe(false)
  })

  it('caps at 50 entries and sets truncated flag', () => {
    const raw = Array.from({ length: 60 }, (_, i) => makeTrace(i))
    const { traces, truncated } = buildToolTraces(raw)
    expect(traces).toHaveLength(50)
    expect(truncated).toBe(true)
  })

  it('truncates inputSummary and outputSummary in returned traces', () => {
    const raw: ToolTrace[] = [
      {
        toolName: 'big',
        calledAt: new Date().toISOString(),
        durationMs: 50,
        inputSummary: 'x'.repeat(2000),
        outputSummary: 'y'.repeat(2000),
        success: true,
      },
    ]
    const { traces } = buildToolTraces(raw)
    expect(traces[0].inputSummary.length).toBeLessThan(2000)
    expect(traces[0].outputSummary.length).toBeLessThan(2000)
    expect(traces[0].inputSummary).toContain('...[truncated')
  })
})
