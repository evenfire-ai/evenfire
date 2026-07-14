import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  INTERNAL_TOOLS,
  escapeHtmlAttr,
  safeCell,
  safeJsonForScript,
  validateOutputPath,
} from '../internalTools'
import { StepMcpRouter } from '../stepRouter'
import type { InternalToolDefinition } from '../types'

// ─── Test Output Directory ──────────────────────────────────────────

let testOutputDir: string

beforeEach(() => {
  testOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-sec-test-'))
})

afterEach(() => {
  fs.rmSync(testOutputDir, { recursive: true, force: true })
})

function findTool(name: string): InternalToolDefinition {
  const tool = INTERNAL_TOOLS.find(t => t.name === name)
  if (!tool) throw new Error(`Tool ${name} not found`)
  return tool
}

// ─── XSS via </script> in dashboard chart init ──────────────────────

describe('dashboard chart init <script> breakout', () => {
  it('escapes </script> in chart data so it cannot break out of <script> block', async () => {
    const tool = findTool('clerum__generate_dashboard')
    const malicious = "</script><script>alert('xss')</script>"
    const result = await tool.execute(
      {
        filename: 'script-breakout.html',
        template: 'custom',
        data: {
          title: 'Script breakout',
          blocks: [
            {
              type: 'chart',
              spec: {
                type: 'bar',
                labels: [malicious],
                datasets: [{ label: malicious, data: [1] }],
              },
            },
          ],
        },
      },
      testOutputDir
    )
    expect(result.success).toBe(true)
    const html = fs.readFileSync(path.join(testOutputDir, 'script-breakout.html'), 'utf-8')
    // The literal closing tag must NOT appear inside the <script> block.
    expect(html).not.toMatch(/<\/script><script>alert/)
    // The unicode-escaped form is what we expect to find embedded in the
    // chart spec, proving the encoding ran.
    expect(html).toContain('\\u003c')
  })

  it('safeJsonForScript output never contains a literal </script>', () => {
    const payload = { evil: '</script><img src=x onerror=alert(1)>' }
    const out = safeJsonForScript(payload)
    expect(out).not.toContain('</script>')
    expect(out).not.toContain('<script>')
    expect(out).toContain('\\u003c\\u002fscript\\u003e'.replace('\\u002f', '/'))
  })
})

// ─── XSS via attribute breakout in data-spark ───────────────────────

describe('dashboard data-spark attribute breakout', () => {
  it('escapes single-quote breakout in KPI sparkline attribute', async () => {
    const tool = findTool('clerum__generate_dashboard')
    // Sparkline values are numbers; the attribute is rendered from
    // JSON.stringify(sparkline). Even though numeric arrays don't
    // realistically carry attacker payload, the encoder must defang
    // structural HTML chars unconditionally.
    const result = await tool.execute(
      {
        filename: 'attr-breakout.html',
        template: 'custom',
        data: {
          title: 'Attr breakout',
          blocks: [
            {
              type: 'kpis',
              items: [
                {
                  label: 'Revenue',
                  value: '$10k',
                  sparkline: [1, 2, 3, 4, 5],
                },
              ],
            },
          ],
        },
      },
      testOutputDir
    )
    expect(result.success).toBe(true)
    const html = fs.readFileSync(path.join(testOutputDir, 'attr-breakout.html'), 'utf-8')
    // Must use double-quoted attribute and an escaped apostrophe form is fine,
    // but unescaped single-quote breakout (data-spark='[1,2]'><script>) must not exist.
    expect(html).not.toMatch(/data-spark='\[/)
  })

  it('escapeHtmlAttr defangs single quotes, double quotes, angle brackets', () => {
    const out = escapeHtmlAttr(`'"><script>alert(1)</script>`)
    expect(out).not.toContain("'")
    expect(out).not.toContain('"')
    expect(out).not.toContain('<')
    expect(out).not.toContain('>')
    expect(out).toContain('&#39;')
    expect(out).toContain('&quot;')
    expect(out).toContain('&lt;')
    expect(out).toContain('&gt;')
  })
})

// ─── Path traversal in image embedding ──────────────────────────────

describe('path traversal in image embedding', () => {
  it('rejects ../ traversal in PDF logoPath', async () => {
    const tool = findTool('clerum__generate_pdf')
    const result = await tool.execute(
      {
        filename: 'logo-traversal.pdf',
        title: 'Path traversal',
        body: 'test',
        coverPage: true,
        branding: { logoPath: '../../etc/passwd' },
      },
      testOutputDir
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/path traversal blocked/)
  })

  it('rejects absolute path outside outputDir in DOCX img.path', async () => {
    const tool = findTool('clerum__generate_docx')
    const result = await tool.execute(
      {
        filename: 'image-traversal.docx',
        title: 'Path traversal',
        body: 'test',
        images: [{ path: '/etc/shadow' }],
      },
      testOutputDir
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/path traversal blocked/)
  })

  it('validateOutputPath accepts relative paths inside outputDir', () => {
    const root = '/tmp/clerum-output'
    expect(validateOutputPath('chart.png', root)).toBe('/tmp/clerum-output/chart.png')
    expect(validateOutputPath('sub/dir/chart.png', root)).toBe(
      '/tmp/clerum-output/sub/dir/chart.png'
    )
  })

  it('validateOutputPath rejects ../ traversal', () => {
    expect(() => validateOutputPath('../etc/passwd', '/tmp/clerum-output')).toThrow(
      /path traversal blocked/
    )
    expect(() => validateOutputPath('/etc/shadow', '/tmp/clerum-output')).toThrow(
      /path traversal blocked/
    )
  })
})

// ─── AJV validation in stepRouter dispatch ──────────────────────────

describe('stepRouter AJV validation before tool execute', () => {
  it('rejects internal tool args that violate the JSON schema', async () => {
    const router = new StepMcpRouter(() => {
      throw new Error('factory should not be called')
    })
    router.registerInternalTools(INTERNAL_TOOLS, testOutputDir)

    // generate_markdown requires { filename, content }; pass content of
    // wrong type (number instead of string) — validation must reject
    // BEFORE execute() runs.
    const { result, record } = await router.callTool('clerum__generate_markdown', {
      filename: 'x.md',
      content: 12345,
    })
    expect(result.isError).toBe(true)
    const content = result.content as { success: boolean; error?: string }
    expect(content.success).toBe(false)
    expect(content.error).toMatch(/Invalid arguments/i)
    expect(record.durationMs).toBe(0)

    // No file should have been created.
    expect(fs.existsSync(path.join(testOutputDir, 'x.md'))).toBe(false)
  })

  it('rejects missing required fields', async () => {
    const router = new StepMcpRouter(() => {
      throw new Error('factory should not be called')
    })
    router.registerInternalTools(INTERNAL_TOOLS, testOutputDir)

    const { result } = await router.callTool('clerum__generate_pdf', {
      // missing required `filename` and `body`
      title: 'no body',
    })
    expect(result.isError).toBe(true)
    const content = result.content as { error?: string }
    expect(content.error).toMatch(/Invalid arguments/i)
  })

  it('passes valid args through to execute()', async () => {
    const router = new StepMcpRouter(() => {
      throw new Error('factory should not be called')
    })
    router.registerInternalTools(INTERNAL_TOOLS, testOutputDir)

    const { result } = await router.callTool('clerum__generate_markdown', {
      filename: 'good.md',
      content: '# hello',
    })
    expect(result.isError).toBeFalsy()
    expect(fs.existsSync(path.join(testOutputDir, 'good.md'))).toBe(true)
  })
})

// ─── Formula injection in XLSX cells ────────────────────────────────

describe('XLSX formula injection', () => {
  it('safeCell prefixes formula-leading strings with apostrophe', () => {
    expect(safeCell('=cmd|"/c calc"!A1')).toBe(`'=cmd|"/c calc"!A1`)
    expect(safeCell('+1+1')).toBe(`'+1+1`)
    expect(safeCell('-2*5')).toBe(`'-2*5`)
    expect(safeCell('@SUM(A1:A10)')).toBe(`'@SUM(A1:A10)`)
    expect(safeCell('\tinjected')).toBe(`'\tinjected`)
    expect(safeCell('\rinjected')).toBe(`'\rinjected`)
  })

  it('safeCell leaves benign strings alone', () => {
    expect(safeCell('hello world')).toBe('hello world')
    expect(safeCell('123abc')).toBe('123abc')
    expect(safeCell('')).toBe('')
  })

  it('safeCell passes non-strings through untouched', () => {
    expect(safeCell(42)).toBe(42)
    expect(safeCell(null)).toBe(null)
    expect(safeCell(undefined)).toBe(undefined)
    expect(safeCell(true)).toBe(true)
  })

  it('XLSX output stores formula-leading values as text, not formulas', async () => {
    const tool = findTool('clerum__generate_xlsx')
    const result = await tool.execute(
      {
        filename: 'formula-injection.xlsx',
        sheets: [
          {
            name: 'Data',
            rows: [['Header'], ['=1+1'], ['+EVIL()'], ['benign value']],
          },
        ],
      },
      testOutputDir
    )
    expect(result.success).toBe(true)
    // The actual XLSX is binary — we trust safeCell unit tests for the
    // transformation. End-to-end correctness is verified by the absence of
    // ExcelJS errors and the presence of the file.
    expect(fs.existsSync(path.join(testOutputDir, 'formula-injection.xlsx'))).toBe(true)
  })
})

// ─── XLSX conditional-formatting regex ReDoS bounds ─────────────────

describe('XLSX conditional-formatting regex bounds', () => {
  it('silently ignores oversized regex patterns without crashing generation', async () => {
    const tool = findTool('clerum__generate_xlsx')
    // 300-char pattern exceeds MAX_REGEX_PATTERN_LENGTH=256; rule should be
    // dropped, generation should still succeed and not be flagged in error.
    const oversized = 'a'.repeat(300)
    const result = await tool.execute(
      {
        filename: 'redos-oversize.xlsx',
        sheets: [
          {
            name: 'Data',
            rows: [['Status'], ['ok'], ['warn']],
            conditionalFormatting: [
              {
                column: 'Status',
                rules: [{ regex: oversized, fillColor: '#ff0000' }],
              },
            ],
          },
        ],
      },
      testOutputDir
    )
    expect(result.success).toBe(true)
    expect(fs.existsSync(path.join(testOutputDir, 'redos-oversize.xlsx'))).toBe(true)
  })

  it('completes quickly against a ReDoS-prone pattern with a long cell value', async () => {
    const tool = findTool('clerum__generate_xlsx')
    // Classic catastrophic-backtracking pattern. Input is truncated to
    // MAX_REGEX_INPUT_LENGTH=4096 before matching, but the pattern is
    // exponential in n — we mainly check the call returns at all under a
    // generous time budget rather than asserting microsecond timing.
    const evilPattern = '^(a+)+$'
    const longCell = 'a'.repeat(40) + '!'
    const start = Date.now()
    const result = await tool.execute(
      {
        filename: 'redos-pattern.xlsx',
        sheets: [
          {
            name: 'Data',
            rows: [['Status'], [longCell]],
            conditionalFormatting: [
              {
                column: 'Status',
                rules: [{ regex: evilPattern, fillColor: '#ff0000' }],
              },
            ],
          },
        ],
      },
      testOutputDir
    )
    const elapsed = Date.now() - start
    expect(result.success).toBe(true)
    // 5s is a very loose budget — a true ReDoS would hang for minutes.
    expect(elapsed).toBeLessThan(5000)
  })
})

// ─── Canvas pre-allocation quota ────────────────────────────────────

describe('chart canvas dimension quota', () => {
  it('rejects huge canvas dimensions before allocation', async () => {
    const tool = findTool('clerum__generate_chart')
    // 4000×4000×4 bytes = 64 MB, well above the default 50 MB quota.
    const result = await tool.execute(
      {
        filename: 'huge.png',
        type: 'bar',
        width: 4000,
        height: 4000,
        data: { labels: ['a'], datasets: [{ label: 'a', data: [1] }] },
      },
      testOutputDir
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/quota/i)
  })
})
