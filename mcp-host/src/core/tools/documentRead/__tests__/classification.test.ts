/**
 * The Host classifies every attached file from its full bytes
 * (`incomingAttachments.ts`), and that class decides which reader is offered.
 * These cases use files written by real tools, so a classifier rule that is
 * too loose (an ordinary archive offered to the XLSX reader) or too strict (a
 * real workbook refused) fails here, not later as a reader error.
 */
import { describe, expect, it } from 'vitest'
import { Document, Packer, Paragraph } from 'docx'
import JSZip from 'jszip'
import { classifyBytes } from '@clerum/gfs-interaction-policy'
import { textPdf, valuesWorkbook, witnessCode } from './fixtures'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

function classify(bytes: Buffer, filename: string, declaredMediaType: string | null) {
  return classifyBytes({
    bytes: new Uint8Array(bytes),
    totalByteLength: bytes.length,
    declaredMediaType,
    filename,
  })
}

async function archiveWithXlFolder(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file('readme.txt', 'backup')
  zip.file('xl/notes.txt', 'not a workbook')
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function wordDocument(): Promise<Buffer> {
  const document = new Document({ sections: [{ children: [new Paragraph('letter')] }] })
  return Packer.toBuffer(document)
}

describe('Host classification of files written by real tools', () => {
  it('offers the XLSX reader for a workbook written by ExcelJS', async () => {
    expect(classify(await valuesWorkbook(witnessCode()), 'sheet.xlsx', XLSX_MIME)).toMatchObject({
      class: 'xlsx',
      reader: 'xlsx',
      detection: 'magic',
      mismatch: false,
    })
  })

  it('offers the PDF reader for a PDF', async () => {
    expect(classify(await textPdf([witnessCode()]), 'report.pdf', 'application/pdf')).toMatchObject(
      { class: 'pdf', reader: 'pdf', detection: 'magic', mismatch: false }
    )
  })

  it('classifies a Word document as docx, which has no reader', async () => {
    expect(classify(await wordDocument(), 'letter.docx', DOCX_MIME)).toMatchObject({
      class: 'docx',
      reader: 'none',
      detection: 'magic',
    })
  })

  it('never offers the XLSX reader for an ordinary archive with an xl folder', async () => {
    const archive = await archiveWithXlFolder()
    expect(classify(archive, 'backup.zip', 'application/zip')).toMatchObject({
      class: 'binary_unsupported',
      reader: 'none',
      detectedMediaType: 'application/zip',
      mismatch: false,
    })
    // Named and declared as a spreadsheet, it is still not one.
    expect(classify(archive, 'report.xlsx', XLSX_MIME)).toMatchObject({
      class: 'binary_unsupported',
      reader: 'none',
      mismatch: true,
    })
  })

  it('opens a file by its content when its name or type says otherwise', async () => {
    // PDF and XLSX share a family, so `mismatch` stays false here
    // (fileClassifier.d.ts); the reader still follows the content.
    expect(
      classify(await valuesWorkbook(witnessCode()), 'report.pdf', 'application/pdf')
    ).toMatchObject({ class: 'xlsx', reader: 'xlsx' })
    expect(classify(await textPdf([witnessCode()]), 'notes.txt', 'text/plain')).toMatchObject({
      class: 'pdf',
      reader: 'pdf',
      mismatch: true,
    })
  })
})
