import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { deflateSync } from 'node:zlib'
import { valuesWorkbook, witnessCode } from './fixtures'

/** A valid workbook whose media entry is inflated even though it is unused. */
export async function inflatedWorkbook(uncompressedBytes: number): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await valuesWorkbook(witnessCode()))
  zip.file('xl/media/large.bin', Buffer.alloc(uncompressedBytes, 0x41))
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

export async function aggregateWorkbook(entryBytes: number): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await valuesWorkbook(witnessCode()))
  zip.file('xl/media/first.bin', Buffer.alloc(entryBytes, 0x41))
  zip.file('xl/media/second.bin', Buffer.alloc(entryBytes, 0x41))
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

/** A dishonest size is not allowed to disable the parent's independent RSS cap. */
export async function underdeclaredWorkbook(uncompressedBytes: number): Promise<Buffer> {
  const bytes = await inflatedWorkbook(uncompressedBytes)
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  for (let entry = bytes.readUInt32LE(end + 16); entry < end; ) {
    const nameLength = bytes.readUInt16LE(entry + 28)
    const extraLength = bytes.readUInt16LE(entry + 30)
    const commentLength = bytes.readUInt16LE(entry + 32)
    const name = bytes.toString('utf8', entry + 46, entry + 46 + nameLength)
    if (name === 'xl/media/large.bin') {
      bytes.writeUInt32LE(1_024, entry + 24)
      bytes.writeUInt32LE(1_024, bytes.readUInt32LE(entry + 42) + 22)
      return bytes
    }
    entry += 46 + nameLength + extraLength + commentLength
  }
  throw new Error('Media fixture has no central entry')
}

/** Exercise ZIP64's unsigned size field, including values above safe JS integers. */
export async function zip64Workbook(uncompressedBytes: bigint): Promise<Buffer> {
  const bytes = await inflatedWorkbook(1_024)
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  for (let entry = bytes.readUInt32LE(end + 16); entry < end; ) {
    const nameLength = bytes.readUInt16LE(entry + 28)
    const extraLength = bytes.readUInt16LE(entry + 30)
    const commentLength = bytes.readUInt16LE(entry + 32)
    const name = bytes.toString('utf8', entry + 46, entry + 46 + nameLength)
    if (name === 'xl/media/large.bin') {
      const extra = Buffer.alloc(12)
      extra.writeUInt16LE(1, 0)
      extra.writeUInt16LE(8, 2)
      extra.writeBigUInt64LE(uncompressedBytes, 4)
      const at = entry + 46 + nameLength
      const result = Buffer.concat([bytes.subarray(0, at), extra, bytes.subarray(at)])
      result.writeUInt32LE(0xffff_ffff, entry + 24)
      result.writeUInt16LE(extraLength + extra.length, entry + 30)
      result.writeUInt32LE(bytes.readUInt32LE(end + 12) + extra.length, end + extra.length + 12)
      return result
    }
    entry += 46 + nameLength + extraLength + commentLength
  }
  throw new Error('Media fixture has no central entry')
}

/** Every selected cell references the same long string; IPC must count every copy. */
export async function sharedStringWorkbook(cells: number, characters: number): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  workbook.addWorksheet('Values').addRow(['A'])
  const zip = await JSZip.loadAsync(await workbook.xlsx.writeBuffer())
  zip.file(
    'xl/sharedStrings.xml',
    '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      `count="${cells}" uniqueCount="1"><si><t>${'A'.repeat(characters)}</t></si></sst>`
  )
  const rows: string[] = []
  for (let row = 1; row <= Math.ceil(cells / 10); row += 1) {
    const values: string[] = []
    for (let column = 0; column < Math.min(10, cells - (row - 1) * 10); column += 1) {
      values.push(`<c r="${String.fromCharCode(65 + column)}${row}" t="s"><v>0</v></c>`)
    }
    rows.push(`<row r="${row}">${values.join('')}</row>`)
  }
  zip.file(
    'xl/worksheets/sheet1.xml',
    '<?xml version="1.0"?><worksheet ' +
      'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `<sheetData>${rows.join('')}</sheetData></worksheet>`
  )
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

function pdf(objects: Array<string | Buffer>): Buffer {
  const chunks = [Buffer.from('%PDF-1.4\n')]
  const offsets: number[] = []
  let length = chunks[0]!.length
  objects.forEach((body, index) => {
    offsets.push(length)
    const value = typeof body === 'string' ? Buffer.from(body) : body
    const object = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      value,
      Buffer.from('\nendobj\n'),
    ])
    chunks.push(object)
    length += object.length
  })
  const xref = [
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f `,
    ...offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n `),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`,
  ].join('\n')
  chunks.push(Buffer.from(xref))
  return Buffer.concat(chunks)
}

function flateStream(bytes: Buffer, dictionary = ''): Buffer {
  const compressed = deflateSync(bytes)
  return Buffer.concat([
    Buffer.from(`<< /Filter /FlateDecode /Length ${compressed.length} ${dictionary} >>\nstream\n`),
    compressed,
    Buffer.from('\nendstream'),
  ])
}

/** Whitespace expands in pdfjs FlateStream before a small, valid text operator. */
export function inflatedTextPdf(uncompressedBytes: number): Buffer {
  const content = Buffer.alloc(uncompressedBytes, 0x20)
  const text = `BT /F1 12 Tf 10 60 Td (${witnessCode()}) Tj ET`
  content.write(text, content.length - text.length)
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 128 128] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    flateStream(content),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ])
}

/** A compressed 300-dpi grayscale scan with matching image and page proportions. */
export function inflatedImagePdf(width: number, height = width): Buffer {
  const pageWidth = (width * 72) / 300
  const pageHeight = (height * 72) / 300
  return pdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
      '/Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>',
    flateStream(Buffer.from(`q ${pageWidth} 0 0 ${pageHeight} 0 0 cm /Im1 Do Q`)),
    flateStream(
      Buffer.alloc(width * height, 0x41),
      `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
        '/ColorSpace /DeviceGray /BitsPerComponent 8'
    ),
  ])
}

/**
 * Rewrites one entry's declared uncompressed size (central directory and
 * local header) while leaving its real inflated bytes untouched, so the
 * reader's own chunk counter is the only bound that can stop it.
 */
function underdeclareEntry(bytes: Buffer, name: string, declared: number): Buffer {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (end < 0) throw new Error('Fixture has no central directory')
  for (let entry = bytes.readUInt32LE(end + 16); entry < end; ) {
    const nameLength = bytes.readUInt16LE(entry + 28)
    const extraLength = bytes.readUInt16LE(entry + 30)
    const commentLength = bytes.readUInt16LE(entry + 32)
    const entryName = bytes.toString('utf8', entry + 46, entry + 46 + nameLength)
    if (entryName === name) {
      const local = bytes.readUInt32LE(entry + 42)
      bytes.writeUInt32LE(declared, entry + 24)
      bytes.writeUInt32LE(declared, local + 22)
      return bytes
    }
    entry += 46 + nameLength + extraLength + commentLength
  }
  throw new Error(`Fixture has no ${name} entry`)
}

/**
 * A workbook whose worksheet or shared-strings entry declares 1 KiB but
 * inflates to `characters` bytes of text, plus a valid sheet that uses it.
 */
export async function underdeclaredPartWorkbook(
  part: 'sheet' | 'sharedStrings',
  characters: number
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(await valuesWorkbook(witnessCode()))
  const name = part === 'sheet' ? 'xl/worksheets/sheet1.xml' : 'xl/sharedStrings.xml'
  const text = 'A'.repeat(characters)
  const xml =
    part === 'sheet'
      ? '<?xml version="1.0"?><worksheet ' +
        'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        `<row r="1"><c r="A1" t="inlineStr"><is><t>${text}</t></is></c></row>` +
        '</sheetData></worksheet>'
      : '<?xml version="1.0"?><sst ' +
        'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        `count="1" uniqueCount="1"><si><t>${text}</t></si></sst>`
  zip.file(name, xml)
  return underdeclareEntry(
    await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
    name,
    1_024
  )
}

/**
 * A 150k-row-class streaming fixture: six numeric cells per row and one
 * formula without a cached result in `F1`. Built directly as sheet XML so the
 * Host does not materialize an ExcelJS model to create it.
 */
export async function streamingWorkbook(rows: number): Promise<Buffer> {
  const chunks: string[] = [
    '<?xml version="1.0"?><worksheet ' +
      'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>',
  ]
  for (let row = 1; row <= rows; row += 1) {
    const cells: string[] = []
    for (let column = 0; column < 6; column += 1) {
      const ref = String.fromCharCode(65 + column) + row
      if (row === 1 && column === 5) {
        cells.push(`<c r="${ref}"><f>1+1</f></c>`)
      } else {
        cells.push(`<c r="${ref}"><v>${row * 10 + column}</v></c>`)
      }
    }
    chunks.push(`<row r="${row}">${cells.join('')}</row>`)
  }
  chunks.push('</sheetData></worksheet>')
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ' +
      'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ' +
      'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '</Types>'
  )
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" ' +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
      'Target="xl/workbook.xml"/></Relationships>'
  )
  zip.file(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Streaming" sheetId="1" r:id="rId1"/></sheets></workbook>'
  )
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" ' +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
      'Target="worksheets/sheet1.xml"/></Relationships>'
  )
  zip.file('xl/worksheets/sheet1.xml', chunks.join(''))
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
