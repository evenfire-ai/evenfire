/**
 * #666 — `clerum__attachment_read` native tool.
 *
 * Reads a `kind:'file'` attachment of the message that started this turn. The
 * turn context lists those files (`attached_file: id=… reader=…`); the content
 * never reaches the model up front, only through this tool, and its output is
 * sanitized like any other untrusted tool result.
 *
 *   - `reader:'text'`: strict UTF-8 text, paged by byte `offset` and `maxBytes`
 *     (at most `attachmentTextReadMaxBytes` per call). A page never splits a
 *     code point, so the text never carries U+FFFD.
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

export type AttachmentReadResult =
  | {
      reference: FileReferenceV1
      kind: 'text'
      text: string
      byteRange: { offset: number; length: number }
      truncated: boolean
    }
  | { reference: FileReferenceV1; kind: 'binary'; reader: 'none'; reason: string }

const ERROR_MESSAGES: Record<AttachmentReadErrorCode, string> = {
  attachment_not_found: 'No file with this attachmentId is attached to the current message.',
  range_invalid:
    'offset must be an integer within the file on a character boundary, and maxBytes an integer from 1 to the per-call limit that covers at least one character.',
}

function isUtf8Continuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80
}

export class AttachmentReadTool implements Tool {
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
        { reference, kind: 'binary', reader: 'none', reason: 'no_reader_for_class' },
        start
      )
    }

    const bytes = Buffer.from(attachment.dataBase64, 'base64')
    if (decodeTextContent(bytes) === null) {
      return this.ok(
        { reference, kind: 'binary', reader: 'none', reason: 'text_decode_rejected' },
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
        reference,
        kind: 'text',
        text,
        byteRange: { offset, length: end - offset },
        truncated: end < bytes.length,
      },
      start
    )
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
