/**
 * #656 / #1093 — `clerum__document_read` is registered through the real
 * attachment admission path and reads a real message attachment through the
 * real parser worker. The random body token is never present in the file name
 * or prompt, so a matching result proves the document bytes arrived here.
 */
import { describe, expect, it } from 'vitest'
import { Workbook } from 'exceljs'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { validateIncomingAttachments } from '../../../agent/incomingAttachments'
import type { IncomingMessage } from '../../../server'
import { AttachmentReadLedger } from '../../attachments/attachmentReadBudget'
import type { NativeToolConfig } from '../../interfaces'
import { BasicSafety } from '../../safety/safety'
import type { Attachment } from '../../types'
import { NativeToolRegistry } from '../nativeToolRegistry'

const config: NativeToolConfig = {
  workspacePath: '/tmp',
  shellTimeout: 5000,
  toolTimeout: 60_000,
  toolProgressInterval: 30_000,
  httpAllowlist: [],
  envAllowlist: ['PATH'],
  memoryMaxSize: 1_048_576,
  attachmentTextReadMaxBytes: 65_536,
}

const bodyToken = () => `DOCUMENT_READ_CODE:${randomBytes(12).toString('hex')}`

async function pdfWithText(text: string): Promise<Buffer> {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  const page = document.addPage([540, 240])
  page.drawText(text, { x: 36, y: 180, size: 12, font })
  return Buffer.from(await document.save())
}

async function xlsxWithRows(rows: Array<Array<string | number>>): Promise<Buffer> {
  const workbook = new Workbook()
  const sheet = workbook.addWorksheet('Report')
  for (const row of rows) sheet.addRow(row)
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

async function fileAttachment(
  id: string,
  fileName: string,
  mimeType: string,
  bytes: Buffer
): Promise<Attachment> {
  const result = validateIncomingAttachments(
    [
      {
        id,
        kind: 'file',
        mimeType,
        detectedMediaType: mimeType,
        encoding: 'base64',
        dataBase64: bytes.toString('base64'),
        filename: fileName,
        sizeBytes: bytes.length,
        digest: { algorithm: 'sha256', hex: createHash('sha256').update(bytes).digest('hex') },
      },
    ],
    {
      maxCount: 4,
      maxBytes: 2_000_000,
      maxFileBytes: 1_000_000,
      messageId: 'message-1',
    }
  )
  if (!result.ok) throw new Error(`fixture rejected: ${result.error.code}`)
  const attachment = result.attachments![0]!
  expect(attachment.kind).toBe('file')
  return attachment
}

function message(attachment?: Attachment): IncomingMessage {
  return {
    content: 'Summarize the attached file.',
    channelType: 'rpc',
    channelId: 'agent-1',
    sender: 'user-1',
    timestamp: '2026-10-13T10:00:00Z',
    messageId: 'message-1',
    hostRef: 'host-1',
    attachments: attachment ? [attachment] : [],
  }
}

function registryFor(attachment?: Attachment): NativeToolRegistry {
  return new NativeToolRegistry(
    config,
    'conversation-1',
    undefined,
    message(attachment),
    undefined,
    undefined,
    undefined,
    {
      maxBytes: 3_145_728,
      ledger: new AttachmentReadLedger(),
      contextWindowTokens: 100_000,
    }
  )
}

function executionContext(toolName: string) {
  const safety = new BasicSafety()
  return {
    onOutput: () => {},
    measureResult: (raw: string): number =>
      Math.ceil(Buffer.byteLength(safety.previewOutputForLlm(toolName, raw), 'utf8') / 4) + 4,
  }
}

describe('NativeToolRegistry — clerum__document_read (#656)', () => {
  it('omits document_read without a PDF/XLSX attachment and registers both document formats', async () => {
    const plain = await fileAttachment(
      'plain-text',
      'notes.txt',
      'text/plain',
      Buffer.from('notes')
    )
    expect(plain.fileReference?.reader).toBe('text')
    expect(registryFor().get('clerum__document_read')).toBeNull()
    expect(registryFor(plain).get('clerum__document_read')).toBeNull()
    const pdf = await fileAttachment(
      'pdf',
      'report.pdf',
      'application/pdf',
      await pdfWithText(bodyToken())
    )
    const xlsx = await fileAttachment(
      'xlsx',
      'report.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      await xlsxWithRows([['reader witness']])
    )
    expect(registryFor(pdf).get('clerum__document_read')?.name()).toBe('clerum__document_read')
    expect(registryFor(xlsx).get('clerum__document_read')?.name()).toBe('clerum__document_read')
  })
  it('rejects a foreign attachmentId and reads the current message attachment as the witness', async () => {
    const token = bodyToken()
    const attachment = await fileAttachment(
      'own-document',
      'report.pdf',
      'application/pdf',
      await pdfWithText(token)
    )
    const registry = registryFor(attachment)
    const tool = registry.get('clerum__document_read')
    expect(tool).not.toBeNull()

    const rejected = await tool!.execute(
      { attachmentId: 'another-user-or-chat-document' },
      executionContext('clerum__document_read')
    )
    expect(JSON.parse(rejected.content)).toEqual({
      error: 'attachment_not_found',
      message: 'No file with this attachmentId is attached to the current message.',
    })
    expect(rejected.is_error).toBe(true)

    const accepted = await tool!.execute(
      { attachmentId: attachment.id },
      executionContext('clerum__document_read')
    )
    const result = JSON.parse(accepted.content) as {
      status: string
      attachmentId: string
      referenceId: string
      format: string
      mode: string
      pageCount: number
      pages?: Array<{ text?: string }>
    }
    expect(result).toMatchObject({
      status: 'ok',
      attachmentId: attachment.id,
      referenceId: attachment.fileReference?.id,
      format: 'pdf',
      mode: 'text',
      pageCount: 1,
    })
    const deliveredText = result.pages?.map(page => page.text ?? '').join('\n') ?? ''
    expect(deliveredText).toContain('DOCUMENT_READ_CODE:')
    expect(createHash('sha256').update(deliveredText).digest('hex')).toBe(
      createHash('sha256').update(token).digest('hex')
    )
    expect(accepted.is_error).toBe(false)
  })

  it('returns contiguous XLSX rows, including an interior empty row', async () => {
    const token = bodyToken()
    const attachment = await fileAttachment(
      'own-sheet',
      'report.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      await xlsxWithRows([['token'], [token], [], ['after-the-gap']])
    )
    expect(attachment.fileReference?.reader).toBe('xlsx')
    const registry = registryFor(attachment)
    const tool = registry.get('clerum__document_read')
    expect(tool).not.toBeNull()

    const output = await tool!.execute(
      { attachmentId: attachment.id },
      executionContext('clerum__document_read')
    )
    const result = JSON.parse(output.content) as {
      status: string
      format: string
      sheetNames: string[]
      sheets: Array<{
        name: string
        startRow: number
        truncated: boolean
        rows: Array<Array<string | number>>
      }>
    }
    expect(result).toMatchObject({ status: 'ok', format: 'xlsx', sheetNames: ['Report'] })
    expect(result.sheets).toHaveLength(1)
    expect(result.sheets[0]).toMatchObject({ name: 'Report', startRow: 1, truncated: false })
    expect(result.sheets[0]?.rows).toHaveLength(4)
    expect(
      result.sheets[0]?.rows[1]?.length === 1 && result.sheets[0]?.rows[1]?.[0] === token
    ).toBe(true)
    expect(result.sheets[0]?.rows[2]).toEqual([])
    expect(output.is_error).toBe(false)
  })

  it('reports a password-protected XLSX as encrypted through the real reader', async () => {
    // A real msoffcrypto-tool output: a CFB container, not a zip.
    const bytes = readFileSync(
      join(
        __dirname,
        '../../../../../packages/gfs-interaction-policy/fixtures/encrypted-workbook.xlsx'
      )
    )
    const attachment = await fileAttachment(
      'locked-sheet',
      'locked.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      bytes
    )
    expect(attachment.fileReference).toMatchObject({ reader: 'xlsx', mismatch: false })
    const tool = registryFor(attachment).get('clerum__document_read')
    expect(tool).not.toBeNull()

    const output = await tool!.execute(
      { attachmentId: attachment.id },
      executionContext('clerum__document_read')
    )
    expect(JSON.parse(output.content)).toMatchObject({
      status: 'error',
      attachmentId: attachment.id,
      reason: 'document_encrypted',
      message: 'The document is password-protected and cannot be read.',
    })
    expect(output.is_error).toBe(true)
  })
})
