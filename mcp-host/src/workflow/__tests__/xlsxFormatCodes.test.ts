// The number formats the sheet writer emits must be ones the attachment check
// reads as shown, or every workbook using them would be withheld.
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import * as os from 'os'
import { officePackageHasText } from '../../artifacts/officePackageText'
import { builtinFormatCode, isModelledFormatCode } from '../../artifacts/shownNumbers'
import { buildXlsxWorkbook } from '../xlsxWorkbook'

async function build(rows: unknown[][], columnFormats?: Record<string, string>) {
  const warnings: string[] = []
  const built = await buildXlsxWorkbook(
    { sheets: [{ name: 'S', rows, ...(columnFormats ? { columnFormats } : {}) }] },
    os.tmpdir(),
    { width: 640, height: 400 },
    warnings
  )
  if (!built.ok) throw new Error(built.error)
  return { buffer: built.buffer, warnings }
}

/** Every format code the workbook's cell styles use, custom or built in. */
async function formatCodes(buffer: Buffer): Promise<string[]> {
  const styles = await (await JSZip.loadAsync(buffer)).file('xl/styles.xml')!.async('string')
  const custom = new Map(
    [...styles.matchAll(/<numFmt numFmtId="(\d+)" formatCode="([^"]*)"/g)].map(m => [
      Number(m[1]),
      m[2]
        .replace(/&quot;/g, '"')
        .replace(/&gt;/g, '>')
        .replace(/&lt;/g, '<')
        .replace(/&amp;/g, '&'),
    ])
  )
  const cellXfs = styles.slice(styles.indexOf('<cellXfs'), styles.indexOf('</cellXfs>'))
  const ids = [...cellXfs.matchAll(/numFmtId="(\d+)"/g)].map(m => Number(m[1]))
  return ids.map(id => custom.get(id) ?? builtinFormatCode(id) ?? `unmodelled id ${id}`)
}

describe('number formats the sheet writer emits', () => {
  const rows = [
    ['Plain', 'Money', 'Pct', 'Red', 'Text', 'Cond', 'Day', 'When', 'Euro'],
    ['+5', '+$1,200', '+45%', '+5', '+5', '+1500', '2026-01-02', '2026-01-02T15:04:05Z', '+€3'],
    ['-3', '-$5', '-5%', '-3', 'x', '-2000', '2026-01-03', '2026-01-02T10:00:00Z', '4'],
    [7, 12.5, 0.25, 8, 'y', 900, '2026-01-04', '2026-01-02T10:00:30Z', '5,5'],
  ]
  const formats = {
    Plain: 'integer',
    Money: 'currencyUsd',
    Pct: 'percent',
    Red: '[Red]#,##0',
    Text: '"Total: "@',
    Cond: '[Red][>=1000]#,##0',
    Day: 'dd/mm/yyyy',
    When: 'datetime',
    Euro: 'currency:EUR',
  }

  it('writes only codes the attachment check reads as shown, signed cells included', async () => {
    const { buffer } = await build(rows, formats)
    const codes = await formatCodes(buffer)
    // Witness: the signed and tagged codes are among them.
    expect(codes).toContain('[Red]+#,##0;[Red]-#,##0;[Red]#,##0')
    for (const code of codes) expect(isModelledFormatCode(code), code).toBe(true)
    expect(officePackageHasText(buffer, () => false)).toBe(false)
  })

  it('keeps a text or conditional format as it is when a cell is signed', async () => {
    const codes = await formatCodes((await build(rows, formats)).buffer)
    expect(codes).toContain('"Total: "@')
    expect(codes).toContain('[Red][>=1000]#,##0')
    expect(codes.some(code => code.startsWith('+"Total') || code.startsWith('+[Red][>='))).toBe(
      false
    )
  })

  it.each([
    ['a system date', '[$-F800]dddd'],
    ['native digits', '[DBNum1]0'],
    ['a code over 255 characters', `"${'x'.repeat(260)}"0`],
  ])('does not write %s, which the attachment check cannot read', async (_label, code) => {
    const { buffer, warnings } = await build(
      [
        ['V', 'W'],
        [46024, 1],
      ],
      { V: code }
    )
    expect(warnings.join(' ')).toContain('is not a format')
    expect(await formatCodes(buffer)).not.toContain(code)
    expect(officePackageHasText(buffer, () => false)).toBe(false)
  })
})
