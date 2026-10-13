/**
 * Reading the text of an Office package back from its bytes, within bounds:
 * anything the reader cannot read is reported as such, never as clean.
 */
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { OFFICE_PACKAGE_LIMITS, officePackageHasText } from '../../artifacts/officePackageText'

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
