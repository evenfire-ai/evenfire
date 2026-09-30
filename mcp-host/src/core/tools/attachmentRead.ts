/**
 * #666 — `clerum__attachment_read` native tool.
 *
 * Reads a `kind:'file'` attachment of the message that started this turn. The
 * turn context lists those files (`attached_file: id="…" … reader=…`); the content
 * never reaches the model up front, only through this tool, and its output is
 * sanitized like any other untrusted tool result.
 *
 *   - `reader:'text'`: strict UTF-8 text, paged by byte `offset` and `maxBytes`
 *     (at most `attachmentTextReadMaxBytes` per call). A page never splits a
 *     code point, so the text never carries U+FFFD. The caller bounds the
 *     page, so the tool is exempt from tool-output spillover and every page
 *     reaches the model inline (#678); `attachmentTextReadMaxBytes` is sized
 *     against the context budget for that reason.
 *   - `reader:'none'`: a typed binary result; the bytes are never decoded.
 *
 * The text-or-binary rule is the one `clerum__gfs_read` applies
 * (`decodeTextContent`), and it has the last word: the portable classifier
 * accepts a few inputs it rejects (DEL, a `GIF8`/`RIFF` text prefix), which
 * come back as `reason:'text_decode_rejected'`. The tool logs nothing:
 * neither the name nor the text.
 */
import type { FileReferenceV1 } from '@clerum/gfs-interaction-policy'
import { decodeTextContent } from '../../internalTools/textContent'
import type { IncomingMessage } from '../../server'
import type { Tool, ToolTraceDescriptor } from '../interfaces'
import type { ToolOutput } from '../types'

export type AttachmentReadErrorCode = 'attachment_not_found' | 'range_invalid'

// The result names the file by `attachmentId` (what the model passes to read
// again) and `referenceId` (the FileReferenceV1 id, which pins the bytes by
// digest). Name, class, size and reader are already on the file's
// `attached_file` line, so they are not repeated on every page.
//
// Key order is part of the contract: the paging fields come first and the
// text last, so any reader that sees only the start of the serialized result
// (a preview, a truncated log line) still sees `byteRange` and `truncated`.
export type AttachmentReadResult =
  | {
      attachmentId: string
      referenceId: FileReferenceV1['id']
      kind: 'text'
      byteRange: { offset: number; length: number }
      truncated: boolean
      text: string
    }
  | {
      attachmentId: string
      referenceId: FileReferenceV1['id']
      kind: 'binary'
      reader: 'none'
      reason: 'no_reader_for_class' | 'text_decode_rejected' | 'bytes_unavailable_after_restart'
    }

const ERROR_MESSAGES: Record<AttachmentReadErrorCode, string> = {
  attachment_not_found: 'No file with this attachmentId is attached to the current message.',
  range_invalid:
    'offset must be an integer within the file on a character boundary, and maxBytes an integer from 1 to the per-call limit that covers at least one character.',
}

function isUtf8Continuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80
}

export class AttachmentReadTool implements Tool {
  /** Decoded bytes and the whole-file text check, per attachmentId. */
  private readonly decoded = new Map<string, { bytes: Buffer; isText: boolean }>()

  /** @param maxBytesPerCall the per-call ceiling and the default page. */
  constructor(
    private readonly sourceMessage: IncomingMessage,
    private readonly maxBytesPerCall: number
  ) {}

  name(): string {
    return 'clerum__attachment_read'
  }

  description(): string {
    return (
      'Read a file attached to the current message, by the attachmentId listed as attached_file in the turn context. ' +
      'Files with reader=text return UTF-8 text; read further pages with offset when truncated is true. ' +
      `A page is returned whole, up to maxBytes (default ${this.maxBytesPerCall} bytes); pass a smaller maxBytes to read less at a time. ` +
      'Files with reader=none return a binary result without content. ' +
      'A reader=text file whose bytes fail the text check also returns a binary result; ' +
      'say the file cannot be read instead of guessing its content.'
    )
  }

  parametersSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        attachmentId: {
          type: 'string',
          description: 'The id of an attached_file line in the turn context.',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          default: 0,
          description:
            'Byte offset to start reading from (byteRange.offset + byteRange.length of the previous page).',
        },
        maxBytes: {
          type: 'integer',
          minimum: 1,
          maximum: this.maxBytesPerCall,
          default: this.maxBytesPerCall,
          description: 'Maximum bytes to read in this call.',
        },
      },
      required: ['attachmentId'],
    }
  }

  requiresSanitization(): boolean {
    return true
  }

  requiresApproval(): boolean {
    return false
  }

  spilloverExempt(): boolean {
    // The caller bounds the page with `maxBytes`; replacing it with a
    // spillover summary would make the model ask for the same bytes twice.
    return true
  }

  traceDescriptor(): ToolTraceDescriptor {
    return { kind: 'internal_tool', sourceRef: 'mcp-host' }
  }

  async execute(params: Record<string, unknown>): Promise<ToolOutput> {
    const start = Date.now()
    const attachment = this.sourceMessage.attachments?.find(
      candidate =>
        candidate.kind === 'file' &&
        candidate.id === params.attachmentId &&
        candidate.fileReference !== undefined
    )
    const reference = attachment?.fileReference
    if (!attachment || !reference) return this.error('attachment_not_found', start)
    const identity = { attachmentId: attachment.id, referenceId: reference.id }

    // #666 R4-M2 — a cold restart persists attachment metadata but never the
    // inline bytes, so the tool answers honestly instead of crashing on
    // Buffer.from(undefined).
    if (typeof attachment.dataBase64 !== 'string') {
      return this.ok(
        { ...identity, kind: 'binary', reader: 'none', reason: 'bytes_unavailable_after_restart' },
        start
      )
    }

    const offset = params.offset ?? 0
    const maxBytes = params.maxBytes ?? this.maxBytesPerCall
    if (
      typeof offset !== 'number' ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      typeof maxBytes !== 'number' ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > this.maxBytesPerCall
    ) {
      return this.error('range_invalid', start)
    }

    if (reference.reader === 'none') {
      return this.ok(
        { ...identity, kind: 'binary', reader: 'none', reason: 'no_reader_for_class' },
        start
      )
    }

    const { bytes, isText } = this.decode(attachment.id, attachment.dataBase64)
    if (!isText) {
      return this.ok(
        { ...identity, kind: 'binary', reader: 'none', reason: 'text_decode_rejected' },
        start
      )
    }
    if (offset > bytes.length) return this.error('range_invalid', start)
    if (offset < bytes.length && isUtf8Continuation(bytes[offset]!)) {
      return this.error('range_invalid', start)
    }
    let end = Math.min(offset + maxBytes, bytes.length)
    while (end < bytes.length && isUtf8Continuation(bytes[end]!)) end -= 1
    if (end === offset && offset < bytes.length) return this.error('range_invalid', start)

    // A byte order mark is dropped only at the start of the file; further in,
    // U+FEFF is file content and stays.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: offset > 0 }).decode(
      bytes.subarray(offset, end)
    )
    return this.ok(
      {
        ...identity,
        kind: 'text',
        byteRange: { offset, length: end - offset },
        truncated: end < bytes.length,
        text,
      },
      start
    )
  }

  // The whole-file text check runs once per attachment; each page then
  // decodes only its own slice.
  private decode(attachmentId: string, dataBase64: string): { bytes: Buffer; isText: boolean } {
    const cached = this.decoded.get(attachmentId)
    if (cached) return cached
    const bytes = Buffer.from(dataBase64, 'base64')
    const entry = { bytes, isText: decodeTextContent(bytes) !== null }
    this.decoded.set(attachmentId, entry)
    return entry
  }

  private ok(result: AttachmentReadResult, start: number): ToolOutput {
    return { content: JSON.stringify(result), duration_ms: Date.now() - start, is_error: false }
  }

  private error(code: AttachmentReadErrorCode, start: number): ToolOutput {
    return {
      content: JSON.stringify({ error: code, message: ERROR_MESSAGES[code] }),
      duration_ms: Date.now() - start,
      is_error: true,
    }
  }
}
