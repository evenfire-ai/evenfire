/**
 * The PDF embeds real fonts, so text above U+00FF such as "≥" is drawn as
 * written, and wide images fit the printable width.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { INTERNAL_TOOLS } from '../internalTools'
import type { InternalToolDefinition } from '../types'
import { readPdf } from './support/pdfText'

/** Widths, in points, of the images drawn in the PDF `file`. */
async function drawnWidths(file: string): Promise<number[]> {
  return (await readPdf(file)).flatMap(page => page.images.map(box => box.x1 - box.x0))
}

function findTool(name: string): InternalToolDefinition {
  const tool = INTERNAL_TOOLS.find(t => t.name === name)
  if (!tool) throw new Error(`tool ${name} not registered`)
  return tool
}

let outputDir: string

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clerum-pdf-text-'))
})

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

/**
 * pdfmake writes the embedded font's name into the PDF; a standard-14 name
 * means Latin-1 only.
 */
function namesACoreFont(file: string): boolean {
  const raw = fs.readFileSync(file).toString('latin1')
  return /\/BaseFont\s*\/(Helvetica|Times|Courier)(-|\s|>)/.test(raw)
}

describe('generate_pdf text fidelity', () => {
  it('embeds a font instead of naming a standard-14 one', async () => {
    const tool = findTool('clerum__generate_pdf')
    const r = await tool.execute(
      { filename: 'fonts.pdf', title: 'Font check', body: 'Plain body text.' },
      outputDir
    )
    expect(r.success).toBe(true)
    expect(namesACoreFont(path.join(outputDir, 'fonts.pdf'))).toBe(false)
  })

  it('renders the symbols and scripts a core font silently replaced', async () => {
    const tool = findTool('clerum__generate_pdf')
    const r = await tool.execute(
      {
        filename: 'unicode.pdf',
        title: 'Unicode',
        body: [
          'Arrow: A → B. Approx: ≈ 50%. GreaterEq: N ≥ 5. LessEq: ≤ 3.',
          'Check: ✓ done, ✗ failed. Bullet: • item. Dash: em — dash.',
          'Greek: α β λ. Cyrillic: привет. Accents: café naïve señor.',
          'Currency: €100 £200 ¥300. Math: ± 5% × 3 ÷ 2.',
        ].join('\n'),
      },
      outputDir
    )
    expect(r.success).toBe(true)
    const size = fs.statSync(path.join(outputDir, 'unicode.pdf')).size
    expect(size).toBeGreaterThan(1000)
  })

  it('does not fail on text in a script no available font covers', async () => {
    const tool = findTool('clerum__generate_pdf')
    const r = await tool.execute(
      { filename: 'cjk.pdf', title: 'CJK', body: '中文测试 テスト 한국어' },
      outputDir
    )
    // Characters with no glyph are dropped rather than written out as a
    // different one; the document must still be produced.
    expect(r.success).toBe(true)
  })

  it('keeps a wide chart inside the page margins', async () => {
    const chart = findTool('clerum__generate_chart')
    const pdf = findTool('clerum__generate_pdf')

    const c = await chart.execute(
      {
        filename: 'wide.png',
        type: 'bar',
        title: 'Wide',
        width: 1200,
        height: 500,
        data: { labels: ['a', 'b'], datasets: [{ label: 's', data: [1, 2] }] },
      },
      outputDir
    )
    expect(c.success).toBe(true)

    const r = await pdf.execute(
      { filename: 'withchart.pdf', title: 'Report', body: 'Body.', images: [{ path: 'wide.png' }] },
      outputDir
    )
    expect(r.success).toBe(true)

    // A 2400px-wide PNG is fitted to the printable width: the drawn box, not
    // the stored pixels, is what the page shows.
    const drawn = await drawnWidths(path.join(outputDir, 'withchart.pdf'))
    expect(drawn).toHaveLength(1)
    expect(drawn[0]).toBeLessThanOrEqual(516)
  })

  it('caps an explicit width at the printable width', async () => {
    const chart = findTool('clerum__generate_chart')
    const pdf = findTool('clerum__generate_pdf')
    await chart.execute(
      {
        filename: 'c.png',
        type: 'bar',
        data: { labels: ['a'], datasets: [{ label: 's', data: [1] }] },
      },
      outputDir
    )
    const r = await pdf.execute(
      {
        filename: 'capped.pdf',
        title: 'Report',
        body: 'Body.',
        images: [{ path: 'c.png', width: 2000 }],
      },
      outputDir
    )
    expect(r.success).toBe(true)
    const drawn = await drawnWidths(path.join(outputDir, 'capped.pdf'))
    expect(drawn).toHaveLength(1)
    expect(drawn[0]).toBeLessThanOrEqual(516)
  })
})
