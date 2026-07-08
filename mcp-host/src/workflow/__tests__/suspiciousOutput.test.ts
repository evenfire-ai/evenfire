/**
 * Tests for isSuspiciousOutput detection and corrective retry logic.
 *
 * Covers:
 * 1. Detection of XML-like tool call fragments
 * 2. Detection of short output after many tool calls
 * 3. Detection of raw URL outputs
 * 4. Acceptance of valid outputs
 * 5. Edge cases (empty, whitespace, unicode)
 * 6. Integration: corrective retry in executeStep flow
 */
import { describe, expect, it, vi } from 'vitest'
import { WorkflowService } from '../workflowService'

// Access private static method via bracket notation for testing
const isSuspicious = (content: string, toolCallCount: number): boolean => {
  return (WorkflowService as any).isSuspiciousOutput(content, toolCallCount)
}

describe('isSuspiciousOutput — Pattern 1: XML tool call fragments', () => {
  it('detects <arg_key> pattern', () => {
    expect(
      isSuspicious(
        'Tool call: web-search__fetchWebContent<arg_key>url</arg_key><arg_value>https://example.com</arg_value>',
        5
      )
    ).toBe(true)
  })

  it('detects <arg_value> pattern', () => {
    expect(isSuspicious('<arg_value>https://protofire.io/</arg_value>', 3)).toBe(true)
  })

  it('detects </tool_call> closing tag', () => {
    expect(isSuspicious('some text</tool_call>', 2)).toBe(true)
  })

  it("detects 'Tool call:' prefix", () => {
    expect(isSuspicious('Tool call: search', 4)).toBe(true)
  })

  it("detects 'Tool call:' with leading whitespace", () => {
    expect(isSuspicious('  Tool call: fetchWebContent', 4)).toBe(true)
  })

  it("does NOT flag normal text mentioning 'tool' in context (few tool calls)", () => {
    expect(
      isSuspicious(
        'I used the search tool to find information about competitors. Here are the results: ...',
        2
      )
    ).toBe(false)
  })

  it("DOES flag short text mentioning 'tool' with many tool calls", () => {
    // 87 chars after 5+ tool calls is legitimately suspicious
    expect(
      isSuspicious(
        'I used the search tool to find information about competitors. Here are the results: ...',
        5
      )
    ).toBe(true)
  })
})

describe('isSuspiciousOutput — Pattern 2: Short output after many tool calls', () => {
  it('flags < 100 chars with 5+ tool calls', () => {
    expect(isSuspicious('OK, here is a brief note.', 5)).toBe(true)
  })

  it('flags < 100 chars with 10 tool calls', () => {
    expect(isSuspicious('Results are available.', 10)).toBe(true)
  })

  it('does NOT flag < 100 chars with 0 tool calls (no tools = analysis step)', () => {
    expect(isSuspicious('Brief summary of analysis.', 0)).toBe(false)
  })

  it('does NOT flag < 100 chars with 4 tool calls (under threshold)', () => {
    expect(isSuspicious('Brief result from a few calls.', 4)).toBe(false)
  })

  it('does NOT flag 150 chars with 5+ tool calls (long enough)', () => {
    const content = 'A'.repeat(150)
    expect(isSuspicious(content, 5)).toBe(false)
  })

  it('does NOT flag exactly 100 chars with 5 tool calls', () => {
    const content = 'A'.repeat(100)
    expect(isSuspicious(content, 5)).toBe(false)
  })
})

describe('isSuspiciousOutput — Pattern 3: Raw URL output', () => {
  it('flags a bare HTTP URL', () => {
    expect(isSuspicious('https://protofire.io/services', 1)).toBe(true)
  })

  it('flags a bare HTTPS URL with path', () => {
    expect(isSuspicious('https://example.com/api/v1/data?key=123', 2)).toBe(true)
  })

  it('does NOT flag URL embedded in text', () => {
    expect(isSuspicious('Visit https://example.com for more info about the company.', 2)).toBe(
      false
    )
  })

  it('does NOT flag multiple URLs in analysis', () => {
    expect(isSuspicious('Sources: https://a.com and https://b.com were consulted.', 3)).toBe(false)
  })
})

describe('isSuspiciousOutput — Edge cases', () => {
  it('flags empty string', () => {
    expect(isSuspicious('', 0)).toBe(true)
  })

  it('flags null-like (empty after coercion)', () => {
    expect(isSuspicious('', 5)).toBe(true)
  })

  it('does NOT flag normal analysis with unicode', () => {
    expect(
      isSuspicious(
        '## Análisis de Competencia\n\nLos resultados muestran que Safe tiene 42% del mercado de multisig wallets. Protofire ofrece servicios de deployment especializados con precios competitivos.',
        4
      )
    ).toBe(false)
  })

  it('does NOT flag markdown tables', () => {
    const table =
      '| Competitor | Market Share | Pricing |\n|---|---|---|\n| Safe | 42% | Free tier + Enterprise |\n| Protofire | 15% | Custom pricing |\n| Others | 43% | Various |'
    expect(isSuspicious(table, 6)).toBe(false)
  })

  it('does NOT flag long research output', () => {
    const research =
      '## Competitor Research\n\n' +
      '### Safe Global\nSafe (formerly Gnosis Safe) is the leading multisig wallet platform...\n'.repeat(
        10
      )
    expect(isSuspicious(research, 8)).toBe(false)
  })
})

describe('isSuspiciousOutput — Real-world failure cases from logs', () => {
  it('detects the exact glm-4.7 failure pattern from 2026-03-25', () => {
    // This is the exact output that caused the cascade failure
    const brokenOutput =
      'Tool call: web-search__fetchWebContent<arg_key>url</arg_key><arg_value>https://protofire.io/</arg_value></tool_call>'
    expect(isSuspicious(brokenOutput, 6)).toBe(true)
  })

  it('detects another common glm pattern: bare tool invocation', () => {
    const brokenOutput = 'Tool call: search\n{"query": "safe wallet pricing"}'
    expect(isSuspicious(brokenOutput, 4)).toBe(true)
  })
})

describe('WorkflowService corrective retry integration', () => {
  it('workflowService.ts contains corrective prompt for suspicious outputs', () => {
    // Verify the retry logic exists in the source
    const fs = require('fs')
    const path = require('path')
    const content = fs.readFileSync(path.resolve(__dirname, '../workflowService.ts'), 'utf-8')
    // Must detect suspicious output
    expect(content).toContain('isSuspiciousOutput')
    // Must inject corrective prompt
    expect(content).toContain('malformed tool call')
    expect(content).toContain('produce a comprehensive final response')
    // Must NOT accept suspicious output as final (should continue loop)
    expect(content).toMatch(/continue\s*;?\s*\/\/ Retry with corrective prompt/)
  })

  it('corrective retry only fires if iterations remain', () => {
    const fs = require('fs')
    const path = require('path')
    const content = fs.readFileSync(path.resolve(__dirname, '../workflowService.ts'), 'utf-8')
    // Guard: only retry if not on last iteration
    expect(content).toMatch(/isSuspicious && i < MAX_ITERATIONS - 1/)
  })
})
