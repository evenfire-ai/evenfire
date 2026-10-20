import { createCanvas } from '@napi-rs/canvas'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { createHash, randomUUID } from 'node:crypto'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { validateIncomingAttachments } from '../../../../agent/incomingAttachments'
import type { Attachment } from '../../../types'
import { DEFAULT_DOCUMENT_READ_LIMITS, type DocumentReadLimits } from '../types'

export function witnessCode(): string {
  return `DOC-${randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase()}`
}

export function documentLimits(overrides: Partial<DocumentReadLimits> = {}): DocumentReadLimits {
  return { ...DEFAULT_DOCUMENT_READ_LIMITS, ...overrides }
}

export function admittedFile(id: string, bytes: Buffer, mimeType: string): Attachment {
  const result = validateIncomingAttachments(
    [
      {
        id,
        kind: 'file',
        mimeType,
        detectedMediaType: mimeType,
        encoding: 'base64',
        dataBase64: bytes.toString('base64'),
        filename: 'document',
        sizeBytes: bytes.length,
        digest: { algorithm: 'sha256', hex: createHash('sha256').update(bytes).digest('hex') },
      },
    ],
    {
      maxCount: 20,
      maxBytes: 24_000_000,
      maxFileBytes: 24_000_000,
      messageId: 'document-read-tests',
    }
  )
  if (!result.ok) throw new Error(`Test fixture was rejected: ${result.error.code}`)
  const attachment = result.attachments?.[0]
  if (!attachment) throw new Error('Test fixture produced no attachment')
  return attachment
}

/** A cursor position as the tool issues it for `file`: bound to its content digest. */
export function boundCursor(position: string, file: Attachment): string {
  const digest = /@sha256:([0-9a-f]{64})$/.exec(file.fileReference?.id ?? '')
  if (!digest) throw new Error('Test fixture has no content-addressed reference')
  return `${position}.${digest[1]!.slice(0, 12)}`
}

export async function textPdf(pageCodes: string[]): Promise<Buffer> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (const code of pageCodes) {
    const page = document.addPage([420, 180])
    page.drawText(`${code} content`, { x: 32, y: 112, size: 20, font })
  }
  return Buffer.from(await document.save())
}

const STANDARD_PADDING = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
])

function rc4(key: Buffer, input: Buffer): Buffer {
  const state = Array.from({ length: 256 }, (_, index) => index)
  let j = 0
  for (let i = 0; i < 256; i += 1) {
    j = (j + state[i]! + key[i % key.length]!) % 256
    ;[state[i], state[j]] = [state[j]!, state[i]!]
  }
  const output = Buffer.alloc(input.length)
  let i = 0
  j = 0
  for (let index = 0; index < input.length; index += 1) {
    i = (i + 1) % 256
    j = (j + state[i]!) % 256
    ;[state[i], state[j]] = [state[j]!, state[i]!]
    output[index] = input[index]! ^ state[(state[i]! + state[j]!) % 256]!
  }
  return output
}

function pdfObject(number: number, body: string | Buffer): { body: Buffer } {
  const value = typeof body === 'string' ? Buffer.from(body, 'latin1') : body
  const prefix = Buffer.from(`${number} 0 obj\n`, 'latin1')
  const suffix = Buffer.from('\nendobj\n', 'latin1')
  return { body: Buffer.concat([prefix, value, suffix]) }
}

function hexadecimal(value: Buffer): string {
  return [...value].map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join('')
}

/**
 * Builds a standards-shaped revision-2 standard-security PDF. The encryption
 * dictionary is valid for an empty user password; pdfjs raises its typed
 * PasswordException while establishing decryption, before decoding content.
 */
export async function encryptedPdf(code: string): Promise<Buffer> {
  const fileId = randomUUID().replace(/-/g, '').slice(0, 32)
  const fileIdBytes = Buffer.from(fileId, 'hex')
  const ownerHash = createHash('md5').update(STANDARD_PADDING).digest().subarray(0, 5)
  const owner = rc4(ownerHash, STANDARD_PADDING)
  const permissions = Buffer.from([0xf0, 0xff, 0xff, 0xff])
  const key = createHash('md5')
    .update(Buffer.concat([STANDARD_PADDING, owner, permissions, fileIdBytes]))
    .digest()
    .subarray(0, 5)
  const user = rc4(key, STANDARD_PADDING)

  const content = `BT /F1 18 Tf 32 100 Td (${code}) Tj ET`
  const encryption = [
    '<< /Filter /Standard /V 1 /R 2 /Length 40',
    `/O <${hexadecimal(owner)}>`,
    `/U <${hexadecimal(user)}>`,
    '/P -3904 >>',
  ].join(' ')
  const objects = [
    pdfObject(1, '<< /Type /Catalog /Pages 2 0 R >>'),
    pdfObject(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    pdfObject(
      3,
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 120] ' +
        '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
    ),
    pdfObject(
      4,
      Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`, 'latin1')
    ),
    pdfObject(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    pdfObject(6, encryption),
  ]
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%', 'latin1')]
  const offsets: number[] = []
  for (const object of objects) {
    offsets.push(chunks.reduce((total, chunk) => total + chunk.length, 0))
    chunks.push(object.body)
  }
  const xrefOffset = chunks.reduce((total, chunk) => total + chunk.length, 0)
  let xref = 'xref\n0 7\n0000000000 65535 f \n'
  for (const offset of offsets) {
    xref += `${offset.toString(10).padStart(10, '0')} 00000 n \n`
  }
  chunks.push(
    Buffer.from(
      `${xref}trailer\n<< /Size 7 /Root 1 0 R /Encrypt 6 0 R ` +
        `/ID [<${fileId}><${fileId}>] >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
      'latin1'
    )
  )
  return Buffer.concat(chunks)
}

export async function imageOnlyPdf(code: string): Promise<Buffer> {
  const side = 128
  const canvas = createCanvas(side, side)
  const context = canvas.getContext('2d')
  context.fillStyle = 'white'
  context.fillRect(0, 0, side, side)
  const bits = createHash('sha256').update(code).digest()
  context.fillStyle = 'black'
  for (let index = 0; index < 64; index += 1) {
    if ((bits[Math.floor(index / 8)]! & (1 << (index % 8))) !== 0) {
      const x = (index % 8) * 16
      const y = Math.floor(index / 8) * 16
      context.fillRect(x + 2, y + 2, 12, 12)
    }
  }
  const document = await PDFDocument.create()
  const embedded = await document.embedPng(await canvas.encode('png'))
  const page = document.addPage([side, side])
  page.drawImage(embedded, { x: 0, y: 0, width: side, height: side })
  return Buffer.from(await document.save())
}

/** One page with nothing drawn on it: no text layer and no visible content. */
export async function blankPdf(): Promise<Buffer> {
  const document = await PDFDocument.create()
  document.addPage([420, 180])
  return Buffer.from(await document.save())
}

export async function emptyPdf(): Promise<Buffer> {
  const objects = [
    pdfObject(1, '<< /Type /Catalog /Pages 2 0 R >>'),
    pdfObject(2, '<< /Type /Pages /Kids [] /Count 0 >>'),
  ]
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%', 'latin1')]
  const offsets: number[] = []
  for (const object of objects) {
    offsets.push(chunks.reduce((total, chunk) => total + chunk.length, 0))
    chunks.push(object.body)
  }
  const xrefOffset = chunks.reduce((total, chunk) => total + chunk.length, 0)
  let xref = 'xref\n0 3\n0000000000 65535 f \n'
  for (const offset of offsets) {
    xref += `${offset.toString(10).padStart(10, '0')} 00000 n \n`
  }
  chunks.push(
    Buffer.from(
      `${xref}trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
      'latin1'
    )
  )
  return Buffer.concat(chunks)
}

export async function malformedPdf(kind: 'truncated' | 'garbage', code: string): Promise<Buffer> {
  if (kind === 'garbage') return Buffer.from(`%PDF-1.7 not a pdf ${code}\n`)
  const complete = await textPdf([code])
  return complete.subarray(0, Math.max(1, Math.floor(complete.length * 0.58)))
}

export async function valuesWorkbook(code: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Values')
  sheet.addRow([code, 42, true])
  sheet.addRow(['formula-zero', { formula: '0', result: 0 }, { formula: 'FALSE()', result: false }])
  sheet.addRow([new Date(Date.UTC(2026, 0, 2, 3, 4, 5))])
  sheet.addRow([{ richText: [{ text: 'rich ' }, { text: 'text' }] }])
  sheet.addRow([{ text: 'Example', hyperlink: 'https://example.invalid/page' }])
  sheet.addRow([{ formula: '1/0', result: '#DIV/0!' }])
  sheet.addRow([])
  sheet.addRow(['tail'])
  const hidden = workbook.addWorksheet('Hidden')
  hidden.getCell('A1').value = 'hidden cell'
  hidden.state = 'hidden'
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

/**
 * Row 1: `A1:C1` merged, value on the master only. Row 2: the same merge
 * followed by a value in `D2`, so the merged span is an interior gap.
 */
export async function mergedWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Merged')
  sheet.mergeCells('A1:C1')
  sheet.getCell('A1').value = 'merged value'
  sheet.mergeCells('A2:C2')
  sheet.getCell('A2').value = 'merged master'
  sheet.getCell('D2').value = 'after merge'
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

/** A hyperlink whose display text is partly bold, so it is stored as rich text. */
export async function richHyperlinkWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Links')
  sheet.getCell('A1').value = {
    text: { richText: [{ font: { bold: true }, text: 'bold ' }, { text: 'label' }] },
    hyperlink: 'https://example.invalid/page',
  } as unknown as ExcelJS.CellHyperlinkValue
  sheet.getCell('B1').value = 'after link'
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

const EMPTY_RESULT = 'EMPTY_RESULT'
const NO_RESULT = 'NO_RESULT'

/**
 * `Data!A1:D1` holds a label, `=""` with an empty cached result, `=1+1` with
 * no cached result and `="x"` cached as `x`; `A2:A4` hold `=""` with empty
 * cached results below the data. ExcelJS cannot write an empty `<v>`, so the
 * sheet XML is rewritten after writing; `rewrite` edits it further.
 */
export async function cachedFormulaWorkbook(
  rewrite: (sheetXml: string) => string = xml => xml
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Data')
  sheet.getCell('A1').value = 'label'
  sheet.getCell('B1').value = { formula: '""', result: EMPTY_RESULT }
  sheet.getCell('C1').value = { formula: '1+1', result: NO_RESULT }
  sheet.getCell('D1').value = { formula: '"x"', result: 'x' }
  for (const address of ['A2', 'A3', 'A4']) {
    sheet.getCell(address).value = { formula: '""', result: EMPTY_RESULT }
  }
  const zip = await JSZip.loadAsync(await workbook.xlsx.writeBuffer())
  const path = 'xl/worksheets/sheet1.xml'
  const written = await zip.file(path)!.async('string')
  const empty = `<v>${EMPTY_RESULT}</v>`
  const absent = `<v>${NO_RESULT}</v>`
  if (written.split(empty).length !== 5 || written.split(absent).length !== 2) {
    throw new Error('Unexpected cached formula XML')
  }
  zip.file(path, rewrite(written.replaceAll(empty, '<v></v>').replace(absent, '')))
  return zip.generateAsync({ type: 'nodebuffer' })
}

/** `1e20` in A1, with a date format when `dateFormatted` (an Invalid Date). */
export async function outOfRangeNumberWorkbook(dateFormatted: boolean): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Dates')
  const cell = sheet.getCell('A1')
  cell.value = 1e20
  if (dateFormatted) cell.numFmt = 'yyyy-mm-dd'
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

export async function emptyWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  workbook.addWorksheet('Empty')
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

export async function emptySelectionWorkbook(code: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  workbook.addWorksheet('Values').addRow([code])
  workbook.addWorksheet('Empty')
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

export async function sheetlessWorkbook(): Promise<Buffer> {
  return Buffer.from(await new ExcelJS.Workbook().xlsx.writeBuffer())
}

export async function continuationWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const alpha = workbook.addWorksheet('Alpha')
  for (let row = 1; row <= 4; row += 1) alpha.addRow([`alpha-${row}`])
  const beta = workbook.addWorksheet('Beta')
  for (let row = 1; row <= 3; row += 1) beta.addRow([`beta-${row}`])
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

export async function wideWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Wide')
  sheet.addRow(Array.from({ length: 10 }, (_, index) => `first-${index}`))
  sheet.addRow(Array.from({ length: 10 }, (_, index) => `second-${index}`))
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

export async function surrogateWorkbook(value: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Characters')
  sheet.addRow([value])
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

export async function longRunningWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('LongRunning')
  // 5000 × 80 cells exercise loading and continuation limits in a real child.
  for (let row = 0; row < 5_000; row += 1) {
    sheet.addRow(
      Array.from({ length: 80 }, (_, column) => `r${row}-c${column}-${(row * 7919) % 100_000}`)
    )
  }
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

export function cfbBytes(): Buffer {
  return Buffer.from([
    0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ])
}
