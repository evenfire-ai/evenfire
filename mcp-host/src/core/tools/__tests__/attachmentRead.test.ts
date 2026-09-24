/**
 * #666 — `clerum__attachment_read`. Attachments are built by the real admission
 * validator, so every `FileReferenceV1` here is one the host would produce.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { validateIncomingAttachments } from '../../../agent/incomingAttachments'
import { decodeTextContent } from '../../../internalTools/textContent'
import type { IncomingMessage } from '../../../server'
import type { Attachment } from '../../types'
import { AttachmentReadTool } from '../attachmentRead'

// Pass-through spy: the whole-file text check keeps its real behaviour, and
// the paging test counts how often it runs.
vi.mock('../../../internalTools/textContent', async importOriginal => {
  const original = await importOriginal<typeof import('../../../internalTools/textContent')>()
  return { ...original, decodeTextContent: vi.fn(original.decodeTextContent) }
})

afterEach(() => {
  vi.mocked(decodeTextContent).mockClear()
})

const READ_LIMIT = 262_144
const SPILLOVER_THRESHOLD = 8192
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function rawFile(id: string, filename: string, mimeType: string, bytes: Buffer) {
  return {
    id,
    kind: 'file',
    mimeType,
    detectedMediaType: mimeType,
    encoding: 'base64',
    dataBase64: bytes.toString('base64'),
    filename,
    sizeBytes: bytes.length,
    digest: { algorithm: 'sha256', hex: createHash('sha256').update(bytes).digest('hex') },
  }
}

function admitted(raw: unknown[]): Attachment[] {
  const result = validateIncomingAttachments(raw, {
    maxCount: 20,
    maxBytes: 1_000_000,
    maxFileBytes: 3_145_728,
    messageId: 'message-1',
  })
  if (!result.ok) throw new Error(`fixture rejected: ${result.error.code}`)
  return result.attachments!
}

function toolFor(
  attachments: Attachment[],
  limit = READ_LIMIT,
  spilloverThresholdBytes: number | null = SPILLOVER_THRESHOLD
): AttachmentReadTool {
  const message: IncomingMessage = {
    content: 'Analyze the attached file',
    channelType: 'rpc',
    channelId: 'agent-1',
    sender: 'user-1',
    timestamp: '2026-09-24T10:00:00Z',
    messageId: 'message-1',
    hostRef: 'host-1',
    attachments,
  }
  return new AttachmentReadTool(message, limit, spilloverThresholdBytes)
}

async function read(tool: AttachmentReadTool, params: Record<string, unknown>) {
  const output = await tool.execute(params)
  return { output, body: JSON.parse(output.content) as Record<string, unknown> }
}

const SENTINEL = 'SENTINEL-666-alpha'

describe('clerum__attachment_read', () => {
  it('declares a sanitized, approval-free tool bounded by the per-call limit', () => {
    const tool = toolFor([])
    expect(tool.name()).toBe('clerum__attachment_read')
    expect(tool.requiresSanitization()).toBe(true)
    expect(tool.requiresApproval()).toBe(false)
    expect(tool.parametersSchema()).toMatchObject({
      required: ['attachmentId'],
      properties: { maxBytes: { minimum: 1, maximum: READ_LIMIT } },
    })
  })

  it('returns the whole text of a small text file with its identity', async () => {
    const [file] = admitted([
      rawFile('file-1', 'notes.txt', 'text/plain', Buffer.from(`hello ${SENTINEL}\n`)),
    ])
    const { output, body } = await read(toolFor([file!]), { attachmentId: 'file-1' })
    expect(output.is_error).toBe(false)
    expect(body).toEqual({
      attachmentId: 'file-1',
      referenceId: file!.fileReference!.id,
      kind: 'text',
      text: `hello ${SENTINEL}\n`,
      byteRange: { offset: 0, length: Buffer.byteLength(`hello ${SENTINEL}\n`) },
      truncated: false,
    })
    // The file name stays on the attached_file line; the page does not repeat it.
    // Witness: the page text is in the same output.
    expect(output.content).toContain(SENTINEL)
    expect(output.content).not.toContain('notes.txt')
  })

  it('returns a typed binary result for a reader=none file without decoding it', async () => {
    const pdf = Buffer.from(`%PDF-1.7\n${SENTINEL}\n%%EOF\n`)
    const [file] = admitted([rawFile('file-1', 'report.pdf', 'application/pdf', pdf)])
    expect(file!.fileReference!.reader).toBe('none')
    const { output, body } = await read(toolFor([file!]), { attachmentId: 'file-1' })
    expect(output.is_error).toBe(false)
    expect(body).toEqual({
      attachmentId: 'file-1',
      referenceId: file!.fileReference!.id,
      kind: 'binary',
      reader: 'none',
      reason: 'no_reader_for_class',
    })
    expect(output.content).not.toContain(SENTINEL)
  })

  it('reads a PNG sent as kind:file as binary, never as image input', async () => {
    const [file] = admitted([rawFile('file-1', 'photo.png', 'image/png', PNG_SIGNATURE)])
    const { body } = await read(toolFor([file!]), { attachmentId: 'file-1' })
    expect(body).toMatchObject({ kind: 'binary', reason: 'no_reader_for_class' })
  })

  it.each([
    ['a DEL control byte', Buffer.from(`notes\u007f${SENTINEL}`)],
    ['a GIF signature prefix', Buffer.from(`GIF89a notes ${SENTINEL}`)],
  ])('answers binary for a reader=text file with %s', async (_label, bytes) => {
    const [file] = admitted([rawFile('file-1', 'notes.txt', 'text/plain', bytes)])
    // Witness: the classifier admitted it as readable text.
    expect(file!.fileReference!.reader).toBe('text')
    const { output, body } = await read(toolFor([file!]), { attachmentId: 'file-1' })
    expect(output.is_error).toBe(false)
    expect(body).toEqual({
      attachmentId: 'file-1',
      referenceId: file!.fileReference!.id,
      kind: 'binary',
      reader: 'none',
      reason: 'text_decode_rejected',
    })
    expect(output.content).not.toContain(SENTINEL)
  })

  it('returns an empty page for a zero-byte text file', async () => {
    const [file] = admitted([rawFile('file-1', 'empty.txt', 'text/plain', Buffer.alloc(0))])
    const { output, body } = await read(toolFor([file!]), { attachmentId: 'file-1' })
    expect(output.is_error).toBe(false)
    expect(body).toMatchObject({
      kind: 'text',
      text: '',
      byteRange: { offset: 0, length: 0 },
      truncated: false,
    })
  })

  it('pages a text over the per-call limit without splitting a code point', async () => {
    // 'é' is two bytes; an odd prefix byte puts every page boundary mid-character.
    const original = `x${'é'.repeat(150_000)}${SENTINEL}`
    const bytes = Buffer.from(original)
    expect(bytes.length).toBeGreaterThan(READ_LIMIT)
    const [file] = admitted([rawFile('file-1', 'long.txt', 'text/plain', bytes)])
    const tool = toolFor([file!])

    const pages: string[] = []
    let offset = 0
    let truncated = true
    let calls = 0
    while (truncated) {
      const { output, body } = await read(tool, { attachmentId: 'file-1', offset })
      expect(output.is_error).toBe(false)
      const range = body.byteRange as { offset: number; length: number }
      expect(range.offset).toBe(offset)
      expect(range.length).toBeGreaterThan(0)
      expect(range.length).toBeLessThanOrEqual(READ_LIMIT)
      pages.push(body.text as string)
      offset += range.length
      truncated = body.truncated as boolean
      calls += 1
    }
    expect(calls).toBe(2)
    // Witness: text came back, and none of it is a replacement character.
    expect(pages[0]!.length).toBeGreaterThan(0)
    expect(pages.join('')).toBe(original)
    expect(pages.join('')).not.toContain('�')
    expect(offset).toBe(bytes.length)
  })

  it('runs the whole-file text check once and decodes only the page on later calls', async () => {
    const [file] = admitted([
      rawFile('file-1', 'notes.txt', 'text/plain', Buffer.from(`abcdef${SENTINEL}`)),
    ])
    const tool = toolFor([file!])
    const first = await read(tool, { attachmentId: 'file-1', maxBytes: 3 })
    const second = await read(tool, { attachmentId: 'file-1', offset: 3, maxBytes: 3 })
    // Witness: both pages came back from the same file.
    expect(first.body.text).toBe('abc')
    expect(second.body.text).toBe('def')
    expect(decodeTextContent).toHaveBeenCalledTimes(1)
  })

  it('ends a page before a 4-byte character that does not fit', async () => {
    // 'a😀b' = 61 F0 9F 98 80 62: a 4-byte page from offset 0 ends inside the emoji.
    const [file] = admitted([rawFile('file-1', 'emoji.txt', 'text/plain', Buffer.from('a😀b'))])
    const tool = toolFor([file!])
    const first = await read(tool, { attachmentId: 'file-1', maxBytes: 4 })
    expect(first.body).toMatchObject({
      text: 'a',
      byteRange: { offset: 0, length: 1 },
      truncated: true,
    })
    const second = await read(tool, { attachmentId: 'file-1', offset: 1, maxBytes: 4 })
    expect(second.body).toMatchObject({
      text: '😀',
      byteRange: { offset: 1, length: 4 },
      truncated: true,
    })
    const narrow = await read(tool, { attachmentId: 'file-1', offset: 1, maxBytes: 3 })
    expect(narrow.body.error).toBe('range_invalid')
  })

  it('orders a text result so the text comes after the page fields', async () => {
    const [file] = admitted([rawFile('file-1', 'notes.txt', 'text/plain', Buffer.from(SENTINEL))])
    const { output } = await read(toolFor([file!]), { attachmentId: 'file-1' })
    expect(Object.keys(JSON.parse(output.content))).toEqual([
      'attachmentId',
      'referenceId',
      'kind',
      'byteRange',
      'truncated',
      'text',
    ])
  })

  it('states the spillover threshold in its description when results can spill', () => {
    const description = toolFor([], READ_LIMIT, SPILLOVER_THRESHOLD).description()
    expect(description).toContain(
      `A page whose result reaches the tool-output spillover threshold (${SPILLOVER_THRESHOLD} bytes) is returned as a spillover summary.`
    )
    expect(description).toContain('clerum__spillover_read')
  })

  it('does not mention spillover when this execution has no spillover storage', () => {
    const description = toolFor([], READ_LIMIT, null).description()
    // Witness: the description is the tool's full text.
    expect(description).toContain('Files with reader=text return UTF-8 text')
    expect(description).not.toContain('spillover')
  })

  it('drops a byte order mark only at the start of the file', async () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('ab'),
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('cd'),
    ])
    const [file] = admitted([rawFile('file-1', 'bom.txt', 'text/plain', bytes)])
    const tool = toolFor([file!])
    const whole = await read(tool, { attachmentId: 'file-1' })
    expect(whole.body).toMatchObject({ text: 'ab﻿cd', byteRange: { offset: 0, length: 10 } })
    const inner = await read(tool, { attachmentId: 'file-1', offset: 5 })
    expect(inner.body).toMatchObject({ text: '﻿cd', byteRange: { offset: 5, length: 5 } })
  })

  it('answers attachment_not_found for an unknown id or an image id', async () => {
    const [image, file] = admitted([
      {
        id: 'image-1',
        kind: 'image',
        mimeType: 'image/png',
        encoding: 'base64',
        dataBase64: PNG_SIGNATURE.toString('base64'),
      },
      rawFile('file-1', 'notes.txt', 'text/plain', Buffer.from(SENTINEL)),
    ])
    const tool = toolFor([image!, file!])
    // Control: the listed file is readable through the same tool.
    expect((await read(tool, { attachmentId: 'file-1' })).body.text).toBe(SENTINEL)
    for (const attachmentId of ['file-2', 'image-1', undefined, 42]) {
      const { output, body } = await read(tool, { attachmentId })
      expect(output.is_error).toBe(true)
      expect(body.error).toBe('attachment_not_found')
    }
  })

  it.each([
    ['offset past the end', { offset: 100 }],
    ['negative offset', { offset: -1 }],
    ['fractional offset', { offset: 1.5 }],
    ['string offset', { offset: '0' }],
    ['offset inside a character', { offset: 2 }],
    ['maxBytes zero', { maxBytes: 0 }],
    ['maxBytes over the per-call limit', { maxBytes: READ_LIMIT + 1 }],
    ['maxBytes smaller than the character at offset', { offset: 1, maxBytes: 1 }],
  ])('answers range_invalid for %s', async (_label, range) => {
    // 'aé!' = 61 C3 A9 21: offset 2 is a continuation byte.
    const [file] = admitted([rawFile('file-1', 'notes.txt', 'text/plain', Buffer.from('aé!'))])
    const tool = toolFor([file!])
    // Control: a valid page of the same file succeeds.
    expect((await read(tool, { attachmentId: 'file-1', offset: 1, maxBytes: 2 })).body.text).toBe(
      'é'
    )
    const { output, body } = await read(tool, { attachmentId: 'file-1', ...range })
    expect(output.is_error).toBe(true)
    expect(body.error).toBe('range_invalid')
  })

  it('reads the end of the file as an empty, untruncated page', async () => {
    const [file] = admitted([rawFile('file-1', 'notes.txt', 'text/plain', Buffer.from('abc'))])
    const { body } = await read(toolFor([file!]), { attachmentId: 'file-1', offset: 3 })
    expect(body).toMatchObject({ text: '', byteRange: { offset: 3, length: 0 }, truncated: false })
  })
})
