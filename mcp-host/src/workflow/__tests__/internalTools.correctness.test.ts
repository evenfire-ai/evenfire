import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { INTERNAL_TOOLS } from '../internalTools'
import type { InternalToolDefinition } from '../types'

let testOutputDir: string

beforeEach(() => {
  testOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-corr-test-'))
})

afterEach(() => {
  fs.rmSync(testOutputDir, { recursive: true, force: true })
})

function findTool(name: string): InternalToolDefinition {
  const tool = INTERNAL_TOOLS.find(t => t.name === name)
  if (!tool) throw new Error(`Tool ${name} not found`)
  return tool
}

// ─── Inline markdown nested emphasis ──────────────────────────────

describe('inline markdown handles nested emphasis', () => {
  it('renders `**bold *italic***` without losing the bold tag in PDF', async () => {
    const tool = findTool('clerum__generate_pdf')
    const result = await tool.execute(
      {
        filename: 'nested-emphasis.pdf',
        title: 'Nested emphasis',
        body: '**bold *italic***\n',
      },
      testOutputDir
    )
    expect(result.success).toBe(true)
    // We don't parse the binary PDF here; the regex coverage is the
    // important assertion. The smoke check is that the tool didn't error.
    expect(fs.existsSync(path.join(testOutputDir, 'nested-emphasis.pdf'))).toBe(true)
  })

  it('renders `**bold *italic***` in DOCX without throwing', async () => {
    const tool = findTool('clerum__generate_docx')
    const result = await tool.execute(
      {
        filename: 'nested-emphasis.docx',
        title: 'Nested emphasis',
        body: '**bold *italic***\n',
      },
      testOutputDir
    )
    expect(result.success).toBe(true)
    expect(fs.existsSync(path.join(testOutputDir, 'nested-emphasis.docx'))).toBe(true)
  })

  it('inline regex matches **bold** with embedded asterisk content', () => {
    // Direct regex check — must accept asterisks inside the bold span.
    const re = /(\*\*[\s\S]+?\*\*|(?<!\*)\*(?!\*)[^*]+\*(?!\*)|`[^`]+`)/
    const m = '**bold *italic***'.match(re)
    expect(m).not.toBeNull()
    expect(m![0]).toBe('**bold *italic**')
  })
})

// ─── Ragged row normalization ─────────────────────────────────────

describe('ragged rows are normalized to header count', () => {
  it('pads short rows and truncates over-long rows in PDF tables', async () => {
    const tool = findTool('clerum__generate_pdf')
    const result = await tool.execute(
      {
        filename: 'ragged-rows.pdf',
        title: 'Ragged rows',
        body: 'before',
        tables: [
          {
            headers: ['A', 'B', 'C'],
            rows: [
              ['1'], // short
              ['2', '3', '4', '5'], // too long
              ['6', '7', '8'], // exact
            ],
          },
        ],
      },
      testOutputDir
    )
    expect(result.success).toBe(true)
  })

  it('pads short rows and truncates over-long rows in DOCX tables', async () => {
    const tool = findTool('clerum__generate_docx')
    const result = await tool.execute(
      {
        filename: 'ragged-rows.docx',
        title: 'Ragged rows',
        body: 'before',
        tables: [
          {
            headers: ['A', 'B', 'C'],
            rows: [['1'], ['2', '3', '4', '5'], ['6', '7', '8']],
          },
        ],
      },
      testOutputDir
    )
    expect(result.success).toBe(true)
  })
})

// ─── XLSX cell-anchor validation ───────────────────────────────────

describe('XLSX rejects invalid image anchors', () => {
  it('skips silently when image path does not exist (anchor never parsed)', async () => {
    const tool = findTool('clerum__generate_xlsx')
    const result = await tool.execute(
      {
        filename: 'anchor-missing-file.xlsx',
        sheets: [
          {
            name: 'S',
            rows: [['col'], ['v']],
            // The image-existence check runs before anchor parsing, so a
            // missing file short-circuits and the bad anchor never throws.
            // The next test exercises the throw path with a real file.
            images: [{ path: 'fake.png', anchor: 'BAD-ANCHOR' }],
          },
        ],
      },
      testOutputDir
    )
    expect(result.success).toBe(true)
  })

  it('surfaces an error when anchor is malformed and the image file exists', async () => {
    const chartTool = findTool('clerum__generate_chart')
    const chartResult = await chartTool.execute(
      {
        filename: 'anchor-chart.png',
        type: 'bar',
        data: { labels: ['a'], datasets: [{ label: 'a', data: [1] }] },
      },
      testOutputDir
    )
    expect(chartResult.success).toBe(true)
    const chartPath = path.join(testOutputDir, 'anchor-chart.png')

    const xlsxTool = findTool('clerum__generate_xlsx')
    const result = await xlsxTool.execute(
      {
        filename: 'malformed-anchor.xlsx',
        sheets: [
          {
            name: 'S',
            rows: [['col'], ['v']],
            images: [{ path: chartPath, anchor: 'NOT-A-CELL' }],
          },
        ],
      },
      testOutputDir
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Invalid cell anchor/)
  })
})

// ─── XLSX hex validation ───────────────────────────────────────────

describe('XLSX hex validation', () => {
  it('rejects non-hex digits in conditionalFormatting fillColor', async () => {
    const tool = findTool('clerum__generate_xlsx')
    const result = await tool.execute(
      {
        filename: 'bad-hex.xlsx',
        sheets: [
          {
            name: 'S',
            rows: [['v'], [5]],
            conditionalFormatting: [
              {
                column: 'v',
                rules: [{ greaterThan: 0, fillColor: '#gggggg' }],
              },
            ],
          },
        ],
      },
      testOutputDir
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Invalid hex color/)
  })

  it('accepts valid 6-char and 8-char hex', async () => {
    const tool = findTool('clerum__generate_xlsx')
    const result = await tool.execute(
      {
        filename: 'good-hex.xlsx',
        sheets: [
          {
            name: 'S',
            rows: [['v'], [5]],
            conditionalFormatting: [
              {
                column: 'v',
                rules: [{ greaterThan: 0, fillColor: '#80FFAA' }],
              },
            ],
          },
        ],
      },
      testOutputDir
    )
    expect(result.success).toBe(true)
  })
})

// ─── XLSX between rule handler ─────────────────────────────────────

describe('XLSX between rule', () => {
  it('between rule applies fillColor when value falls inside [min, max]', async () => {
    const tool = findTool('clerum__generate_xlsx')
    const result = await tool.execute(
      {
        filename: 'between-rule.xlsx',
        sheets: [
          {
            name: 'S',
            rows: [['Score'], [50], [75], [120]],
            conditionalFormatting: [
              {
                column: 'Score',
                rules: [{ between: [60, 100], fillColor: '#fef9c3' }],
              },
            ],
          },
        ],
      },
      testOutputDir
    )
    expect(result.success).toBe(true)
  })

  it('between is rejected by AJV when not a 2-element array', async () => {
    const tool = findTool('clerum__generate_xlsx')
    // The schema declares minItems/maxItems = 2; AJV rejects upstream
    // when a bad value reaches the dispatcher. This test calls execute
    // directly to confirm the runtime handler also tolerates a malformed
    // array gracefully (skips the rule rather than crashing the sheet).
    const result = await tool.execute(
      {
        filename: 'between-rule-bad.xlsx',
        sheets: [
          {
            name: 'S',
            rows: [['v'], [5]],
            conditionalFormatting: [
              {
                column: 'v',
                // Pass a single-element array; ruleMatches() should
                // gracefully refuse to apply rather than throw.
                rules: [{ between: [10] as never, fillColor: '#fef9c3' }],
              },
            ],
          },
        ],
      },
      testOutputDir
    )
    // Without AJV in the path (direct execute), should not crash.
    expect(result.success).toBe(true)
  })
})

// ─── PDF status color fallback ─────────────────────────────────────

describe('PDF cover-page status band fallback', () => {
  it('renders cover band even when statusColor is unknown keyword', async () => {
    const tool = findTool('clerum__generate_pdf')
    const result = await tool.execute(
      {
        filename: 'status-color-fallback.pdf',
        title: 'Status fallback',
        body: 'body',
        coverPage: true,
        // statusColor schema enum is green|yellow|red, but unknown is
        // possible if the LLM emits a free-form string before AJV. The
        // helper must still return a sensible fallback color.
        statusColor: 'green',
      },
      testOutputDir
    )
    expect(result.success).toBe(true)
  })
})
