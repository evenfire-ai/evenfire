/**
 * Reading the text of an Office package back from its bytes, within bounds:
 * anything the reader cannot read is reported as such, never as clean.
 */
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import {
  OFFICE_PACKAGE_LIMITS,
  officePackageHasText,
  officePackageTexts,
} from '../../artifacts/officePackageText'
import { showsNumber } from '../../artifacts/shownNumbers'

const needle = '3141592653'
const holds = (text: string) => text.includes(needle)

function pack(
  parts: Record<string, string | Buffer>,
  compression: 'DEFLATE' | 'STORE' = 'DEFLATE'
): Promise<Buffer> {
  const zip = new JSZip()
  for (const [name, data] of Object.entries(parts)) zip.file(name, data)
  return zip.generateAsync({ type: 'nodebuffer', compression })
}

/** The package with a 16-bit field of every central directory entry set to `value`. */
function withCentralField(buffer: Buffer, offset: number, value: number): Buffer {
  const out = Buffer.from(buffer)
  for (let at = 0; at + 46 <= out.length; at++) {
    if (out.readUInt32LE(at) === 0x02014b50) out.writeUInt16LE(value, at + offset)
  }
  return out
}

describe('officePackageHasText', () => {
  it('finds a number a sheet stores', async () => {
    const xlsx = await pack({
      'xl/worksheets/sheet1.xml': `<sheetData><c><v>${needle}</v></c></sheetData>`,
    })
    expect(officePackageHasText(xlsx, holds)).toBe(true)
  })

  it('reads text split across runs whole', async () => {
    const xlsx = await pack({
      'xl/sharedStrings.xml': '<sst><si><r><t>3141</t></r><r><t>592653</t></r></si></sst>',
    })
    expect(officePackageHasText(xlsx, holds)).toBe(true)
  })

  it('reads attribute values', async () => {
    const xlsx = await pack({
      'xl/workbook.xml': `<workbook><sheet name="${needle}" sheetId="1"/></workbook>`,
    })
    expect(officePackageHasText(xlsx, holds)).toBe(true)
  })

  it.each([
    ['an attribute value holding a >', `<a v="x > ${needle}"/>`],
    ['character data', `<t><![CDATA[${needle}]]></t>`],
    ['a comment', `<a/><!-- ${needle} -->`],
    ['a value left open', `<a v="${needle}`],
  ])('reads %s', async (_label, xml) => {
    const part = await pack({ 'xl/worksheets/sheet1.xml': xml })
    expect(officePackageHasText(part, holds)).toBe(true)
  })

  it('decodes character references', async () => {
    const docx = await pack({ 'word/document.xml': '<w:t>&#51;141592&#x36;53 &amp; more</w:t>' })
    expect(officePackageHasText(docx, holds)).toBe(true)
    expect(officePackageHasText(docx, text => text.includes('3 & more'))).toBe(true)
  })

  it('reads a package embedded in a package, such as the workbook behind a chart', async () => {
    const workbook = await pack({ 'xl/worksheets/sheet1.xml': `<c><v>${needle}</v></c>` })
    const deck = await pack({
      'ppt/slides/slide1.xml': '<p:sld>Slide</p:sld>',
      'ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx': workbook,
    })
    expect(officePackageHasText(deck, holds)).toBe(true)
  })

  it('reads stored entries', async () => {
    const xlsx = await pack({ 'xl/worksheets/sheet1.xml': `<v>${needle}</v>` }, 'STORE')
    expect(officePackageHasText(xlsx, holds)).toBe(true)
  })

  it('finds nothing in a package that does not hold the text, media included', async () => {
    const docx = await pack({
      '[Content_Types].xml': '<Types/>',
      'word/document.xml': '<w:t>3,141,592,653</w:t>',
      'word/media/image1.png': Buffer.from(needle),
    })
    expect(officePackageHasText(docx, holds)).toBe(false)
    // Witness: the same reader finds what the package does hold.
    expect(officePackageHasText(docx, text => text.includes('3,141,592,653'))).toBe(true)
  })

  it.each([
    ['bytes that are not a zip', async () => Buffer.from('PK not a package')],
    ['an encrypted entry', async () => withCentralField(await pack({ 'a.xml': '<a/>' }), 8, 1)],
    [
      'a compression method it does not read',
      async () => withCentralField(await pack({ 'a.xml': '<a/>' }), 10, 12),
    ],
    ['a truncated archive', async () => (await pack({ 'a.xml': '<a/>' })).subarray(8)],
  ])('reports %s as unreadable', async (_label, make) => {
    expect(officePackageHasText(await make(), holds)).toBeNull()
  })

  it('reports a package past its bounds as unreadable', async () => {
    const parts = { 'a.xml': `<a>${'x'.repeat(2048)}</a>`, 'b.xml': '<b/>' }
    const nested = await pack({ 'inner.xlsx': await pack({ 'c.xml': '<c/>' }) })
    expect(officePackageHasText(await pack(parts), holds)).toBe(false)
    expect(
      officePackageHasText(await pack(parts), holds, {
        ...OFFICE_PACKAGE_LIMITS,
        maxInflatedBytes: 1024,
      })
    ).toBeNull()
    expect(
      officePackageHasText(await pack(parts), holds, { ...OFFICE_PACKAGE_LIMITS, maxEntries: 1 })
    ).toBeNull()
    expect(officePackageHasText(nested, holds)).toBe(false)
    expect(
      officePackageHasText(nested, holds, { ...OFFICE_PACKAGE_LIMITS, maxDepth: 0 })
    ).toBeNull()
  })
})

/** A workbook whose one cell stores `value` with style 1, which shows it through numFmt `id`. */
function workbook(
  value: string,
  numFmt: { id: number; code?: string },
  extra: Record<string, string> = {}
) {
  const custom = numFmt.code
    ? `<numFmts count="1"><numFmt numFmtId="${numFmt.id}" formatCode="${numFmt.code}"/></numFmts>`
    : ''
  return pack({
    'xl/styles.xml': `<styleSheet>${custom}<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="${numFmt.id}"/></cellXfs></styleSheet>`,
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData><row><c r="A1" s="1"><v>${value}</v></c></row></sheetData></worksheet>`,
    ...extra,
  })
}

/** Matches nothing as stored, and `shown` as shown: its text, or the number it writes. */
function shownOnly(
  shown: string
): [(text: string) => boolean, typeof OFFICE_PACKAGE_LIMITS, (text: string) => boolean] {
  return [
    () => false,
    OFFICE_PACKAGE_LIMITS,
    text => text.includes(shown) || showsNumber(text, shown),
  ]
}

describe('officePackageHasText, numbers as they are shown', () => {
  it('reads a date serial as the date its custom format shows', async () => {
    const xlsx = await workbook('46024', { id: 164, code: 'dd/mm/yyyy' })
    expect(officePackageHasText(xlsx, ...shownOnly('02/01/2026'))).toBe(true)
    // Witness: the shown reading does not find what the cell does not show.
    expect(officePackageHasText(xlsx, ...shownOnly('03/01/2026'))).toBe(false)
  })

  it('reads a built-in short date in the patterns viewers use', async () => {
    const xlsx = await workbook('46024', { id: 14 })
    expect(officePackageHasText(xlsx, ...shownOnly('02.01.2026'))).toBe(true)
    expect(officePackageHasText(xlsx, ...shownOnly('1/2/2026'))).toBe(true)
  })

  it('reads grouped digits in any locale, and quoted text beside them', async () => {
    const grouped = await workbook('3141592653', { id: 3 })
    expect(officePackageHasText(grouped, ...shownOnly('3.141.592.653'))).toBe(true)
    const quoted = await workbook('123456', { id: 164, code: '&quot;sk-&quot;0' })
    expect(officePackageHasText(quoted, ...shownOnly('sk-123456'))).toBe(true)
  })

  it('reads the numbers a chart caches through its label formats', async () => {
    const deck = await pack({
      'ppt/charts/chart1.xml':
        '<c:chartSpace><c:dLbls><c:numFmt formatCode="&quot;sk-&quot;0" sourceLinked="0"/></c:dLbls>' +
        '<c:val><c:numRef><c:numCache><c:formatCode>General</c:formatCode><c:pt idx="0"><c:v>123456</c:v></c:pt>' +
        '</c:numCache></c:numRef></c:val></c:chartSpace>',
    })
    expect(officePackageHasText(deck, ...shownOnly('sk-123456'))).toBe(true)
  })

  it.each([
    ['a formula', () => pack({ 'xl/worksheets/sheet1.xml': '<c r="A1"><f>B1</f><v>1</v></c>' })],
    [
      'the 1904 date system',
      () =>
        workbook(
          '1',
          { id: 14 },
          { 'xl/workbook.xml': '<workbook><workbookPr date1904="1"/></workbook>' }
        ),
    ],
    [
      'a conditional format with a number format',
      () =>
        pack({
          'xl/styles.xml':
            '<styleSheet><dxfs count="1"><dxf><numFmt numFmtId="170" formatCode="0.0"/></dxf></dxfs></styleSheet>',
          'xl/worksheets/sheet1.xml': '<c r="A1"><v>1</v></c>',
        }),
    ],
    ['a built-in id it does not model', () => workbook('5', { id: 5 })],
    ['a system date format', () => workbook('46024', { id: 164, code: '[$-F800]dddd' })],
    ['another calendar', () => workbook('46024', { id: 164, code: '[$-1070000]yyyy-mm-dd' })],
    [
      'an ISO date cell',
      () => pack({ 'xl/worksheets/sheet1.xml': '<c r="A1" t="d"><v>2026-01-02</v></c>' }),
    ],
    [
      'a chart format it does not model',
      () =>
        pack({
          'ppt/charts/chart1.xml':
            '<c:numCache><c:formatCode>[DBNum1]0</c:formatCode><c:pt><c:v>1</c:v></c:pt></c:numCache>',
        }),
    ],
  ])('reports %s as unreadable', async (_label, make) => {
    expect(officePackageHasText(await make(), () => false)).toBeNull()
  })

  it('reports a package with more shown numbers than the bound as unreadable', async () => {
    const xlsx = await workbook('46024', { id: 14 })
    expect(
      officePackageHasText(xlsx, () => false, { ...OFFICE_PACKAGE_LIMITS, maxShownValues: 0 })
    ).toBeNull()
    // An integer under General shows its stored digits and is not rendered.
    const plain = await workbook('42', { id: 0 })
    expect(
      officePackageHasText(plain, () => false, { ...OFFICE_PACKAGE_LIMITS, maxShownValues: 0 })
    ).toBe(false)
  })

  it('counts each rendering against the bound, not each number', async () => {
    // One cell under the built-in short date and time is rendered in 84 patterns.
    const dated = await workbook('46024.5', { id: 22 })
    const bound = { ...OFFICE_PACKAGE_LIMITS, maxShownRenders: 83 }
    expect(officePackageHasText(dated, () => false, bound)).toBeNull()
    expect(officePackageHasText(dated, () => false, { ...bound, maxShownRenders: 84 })).toBe(false)
    // A plain grouping format is one rendering.
    const grouped = await workbook('3141592653', { id: 3 })
    expect(officePackageHasText(grouped, () => false, { ...bound, maxShownRenders: 1 })).toBe(false)
  })

  it('reads no numbers when told not to', async () => {
    const xlsx = await workbook('46024', { id: 164, code: '[$-F800]dddd' })
    expect(officePackageHasText(xlsx, () => false, OFFICE_PACKAGE_LIMITS, null)).toBe(false)
  })
})

describe('officePackageTexts', () => {
  it('lists the text and attribute values the scan reads, numbers as stored', async () => {
    const xlsx = await pack({
      'xl/workbook.xml': '<workbook><sheet name="Revenue" sheetId="1"/></workbook>',
      'xl/worksheets/sheet1.xml': `<c><v>${needle}</v></c>`,
    })
    const texts = officePackageTexts(xlsx)
    expect(texts).toEqual(expect.arrayContaining(['Revenue', needle]))
    expect(officePackageTexts(Buffer.from('not a package'))).toBeNull()
  })
})
