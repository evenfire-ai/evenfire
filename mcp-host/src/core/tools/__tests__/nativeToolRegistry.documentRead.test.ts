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
import {
  AttachmentReadLedger,
  MAX_ATTACHMENT_READS_PER_TURN,
} from '../../attachments/attachmentReadBudget'
import type { NativeToolConfig } from '../../interfaces'
import { BasicSafety, type SecretEntriesProvider } from '../../safety/safety'
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

function registryFor(
  attachment?: Attachment,
  turn: { ledger?: AttachmentReadLedger; secretEntriesProvider?: SecretEntriesProvider } = {}
): NativeToolRegistry {
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
      ledger: turn.ledger ?? new AttachmentReadLedger(),
      contextWindowTokens: 100_000,
      ...(turn.secretEntriesProvider ? { secretEntriesProvider: turn.secretEntriesProvider } : {}),
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

    // The same workbook named as a Word document: the media type picks the
    // reader, and the .docx name is reported as a mismatch.
    const named = await fileAttachment(
      'locked-sheet-named-docx',
      'locked.docx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      bytes
    )
    expect(named.fileReference).toMatchObject({ reader: 'xlsx', mismatch: false })
    const namedOutput = await registryFor(named)
      .get('clerum__document_read')!
      .execute({ attachmentId: named.id }, executionContext('clerum__document_read'))
    expect(JSON.parse(namedOutput.content)).toMatchObject({
      reason: 'document_encrypted',
      message:
        'The document is password-protected and cannot be read. The file name or declared media type does not match its detected content.',
    })
  })

  // The registry must hand document_read the redactor built from the turn's
  // ConfigStore secrets. The assertions read the tool's own output: the loop's
  // later sanitizer pass is left out on purpose, because it masks a whole
  // literal by itself and would hide a redactor that lacks the secrets.
  it('masks a ConfigStore secret in the document text with the turn secretEntriesProvider', async () => {
    const TOOL = 'clerum__document_read'
    const configLiteral = 'CfgDocumentSecretValue7c6b5a'
    const attachment = await fileAttachment(
      'secret-document',
      'report.pdf',
      'application/pdf',
      await pdfWithText(`before ${configLiteral} after`)
    )
    const read = async (secretEntriesProvider?: SecretEntriesProvider) => {
      const output = await registryFor(attachment, { secretEntriesProvider })
        .get(TOOL)!
        .execute({ attachmentId: attachment.id }, executionContext(TOOL))
      const result = JSON.parse(output.content) as {
        status: string
        pages?: Array<{ text?: string }>
      }
      expect(result.status).toBe('ok')
      expect(output.is_error).toBe(false)
      return {
        content: output.content,
        text: result.pages?.map(page => page.text ?? '').join('\n') ?? '',
      }
    }

    // Control: the literal matches no built-in secret pattern, so without the
    // turn's secrets it reaches the result in clear.
    const plain = await read()
    expect(plain.text).toContain(configLiteral)

    const masked = await read(() => [{ name: 'CFG_DOCUMENT_TOKEN', value: configLiteral }])
    expect(masked.content).not.toContain(configLiteral)
    expect(masked.text).toContain('[REDACTED:CFG_DOCUMENT_TOKEN]')
    // Liveness: the text around the secret is still delivered.
    expect(masked.text).toContain('before')
    expect(masked.text).toContain('after')
  })

  // The two attachment readers draw from one turn ledger, so neither can
  // spend reads the other already took.
  it('charges the turn ledger that clerum__attachment_read also draws from', async () => {
    const attachment = await fileAttachment(
      'shared-ledger',
      'report.pdf',
      'application/pdf',
      await pdfWithText(bodyToken())
    )
    const ledger = new AttachmentReadLedger()
    const registry = registryFor(attachment, { ledger })
    const attachmentRead = registry.get('clerum__attachment_read')!
    const documentRead = registry.get('clerum__document_read')!
    const call = async (tool: typeof documentRead) =>
      JSON.parse(
        (await tool.execute({ attachmentId: attachment.id }, executionContext(tool.name()))).content
      ) as Record<string, unknown>

    // attachment_read spends every read of the turn but the last one. It
    // points a PDF at document_read without decoding it, but still counts.
    for (let read = 1; read < MAX_ATTACHMENT_READS_PER_TURN; read += 1) {
      expect(await call(attachmentRead)).toMatchObject({
        kind: 'binary',
        reason: 'read_with_document_read',
      })
    }
    expect(ledger.snapshot().reads).toBe(MAX_ATTACHMENT_READS_PER_TURN - 1)

    // document_read takes the last read from the same ledger.
    expect(await call(documentRead)).toMatchObject({ status: 'ok', format: 'pdf' })
    expect(ledger.snapshot().reads).toBe(MAX_ATTACHMENT_READS_PER_TURN)

    // Each tool now sees the reads the other one spent.
    expect(await call(attachmentRead)).toMatchObject({ kind: 'read_budget_exhausted' })
    expect(await call(documentRead)).toMatchObject({ status: 'read_budget_exhausted' })
  })
})
