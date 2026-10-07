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
 *     reaches the model inline (#678). C16 additionally fits each emitted
 *     page — after JSON escaping and the sanitized wrapper — into the
 *     current-turn page/turn budgets, shrinking by whole code points with
 *     measurement only; the tool is never re-executed to fit.
 *     Redaction ranges are computed once over the whole decoded text and
 *     every page masks the part of each range it holds before it is
 *     measured, so a secret split by `maxBytes`, by the budget fit or by a
 *     model-chosen `offset` is masked on both sides (jozer-rami M2). The
 *     loop's per-page sanitizer still runs on the result.
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
import { AttachmentReadLedger, attachmentReadBudgets } from '../attachments/attachmentReadBudget'
import type {
  ExecutionContext,
  Tool,
  ToolEmissionContext,
  ToolTraceDescriptor,
} from '../interfaces'
import type { RedactionRange } from '../safety/safety'
import type { ToolOutput, ToolResult } from '../types'

export type AttachmentReadErrorCode =
  | 'attachment_not_found'
  | 'range_invalid'
  | 'measurement_unavailable'

export interface AttachmentReadToolOptions {
  /** Positive safe integer; the ledger derives page/turn budgets from it. */
  contextWindowTokens: number
  /** Turn-owned ledger; the registry wires one per turn. */
  ledger: AttachmentReadLedger
  /** The tool-output redaction rules, applied to the whole decoded text. */
  redactor: AttachmentReadRedactor
}

export interface AttachmentReadRedactor {
  toolOutputRedactionRanges(toolName: string, content: string): RedactionRange[]
}

export type AttachmentReadLimit = 'max_bytes' | 'page_budget' | 'turn_budget'

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
      limit?: AttachmentReadLimit
      nextOffset?: number
      text: string
    }
  | {
      attachmentId: string
      referenceId: FileReferenceV1['id']
      kind: 'binary'
      reader: 'none'
      reason: 'no_reader_for_class' | 'text_decode_rejected' | 'bytes_unavailable_after_restart'
    }
  | {
      attachmentId: string
      referenceId?: FileReferenceV1['id']
      kind: 'read_budget_exhausted'
      resumeOffset: number
      message: string
    }

const ERROR_MESSAGES: Record<AttachmentReadErrorCode, string> = {
  attachment_not_found: 'No file with this attachmentId is attached to the current message.',
  range_invalid:
    'offset must be an integer within the file on a character boundary, and maxBytes an integer from 1 to the per-call limit that covers at least one character.',
  measurement_unavailable:
    'The runtime did not provide the exact output measurement this bounded reader requires.',
}

function isUtf8Continuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80
}

/** A byte range of the decoded file that every overlapping page replaces. */
interface ByteRedaction {
  start: number
  end: number
  replacement: string
}

// The replacement `applyRedactionRanges` uses when overlapping ranges carry
// different replacements.
const MIXED_REDACTION = '[REDACTED]'

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

// True when UTF-16 index `i` falls between the two halves of one code point.
function splitsSurrogatePair(text: string, i: number): boolean {
  return (
    i > 0 &&
    i < text.length &&
    isLowSurrogate(text.charCodeAt(i)) &&
    isHighSurrogate(text.charCodeAt(i - 1))
  )
}

/**
 * Turns UTF-16 redaction ranges over `text` into sorted, disjoint byte ranges
 * of its UTF-8 encoding. Each range is widened to whole code points, and
 * overlapping ranges are merged as `applyRedactionRanges` merges them.
 */
function toByteRedactions(text: string, ranges: RedactionRange[]): ByteRedaction[] {
  const widened = ranges
    .map(range => ({
      start: splitsSurrogatePair(text, range.start) ? range.start - 1 : range.start,
      end: splitsSurrogatePair(text, range.end) ? range.end + 1 : range.end,
      replacement: range.replacement,
    }))
    .filter(range => range.end > range.start)
    .sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: ByteRedaction[] = []
  for (const range of widened) {
    const last = merged[merged.length - 1]
    if (last && range.start < last.end) {
      if (range.end > last.end) last.end = range.end
      if (range.replacement !== last.replacement) last.replacement = MIXED_REDACTION
      continue
    }
    merged.push({ ...range })
  }
  // The bounds are now ascending, so one pass maps every index to its byte.
  let index = 0
  let byte = 0
  const toByte = (target: number): number => {
    byte += Buffer.byteLength(text.slice(index, target), 'utf8')
    index = target
    return byte
  }
  return merged.map(range => ({
    start: toByte(range.start),
    end: toByte(range.end),
    replacement: range.replacement,
  }))
}

const EXHAUSTED_MESSAGE =
  'The current-turn attachment read budget is exhausted. Reattach the file in a new message to resume at the reported offset; earlier pages are not stored for re-reading.'

/** Execute-time reservation consumed exactly once by finalizeResult. */
interface PendingEmission {
  attachmentId: string
  referenceId?: FileReferenceV1['id']
  offset: number
  fileBytes: number
  bytesRead: number
  reservedCost: number | null
}

export class AttachmentReadTool implements Tool {
  /**
   * Decoded bytes and the whole-file text check, per attachmentId, plus the
   * byte redaction ranges of a text file once a page needs them.
   */
  private readonly decoded = new Map<
    string,
    { bytes: Buffer; isText: boolean; redactions?: ByteRedaction[] }
  >()

  /** @param maxBytesPerCall the per-call ceiling and the default page. */
  constructor(
    private readonly sourceMessage: IncomingMessage,
    private readonly maxBytesPerCall: number,
    options: AttachmentReadToolOptions
  ) {
    if (!options || typeof options !== 'object') {
      throw new Error('Attachment read options are required')
    }
    // Reuses the ledger's validation: positive safe integer or throw here,
    // before any read can execute.
    attachmentReadBudgets(options.contextWindowTokens)
    if (typeof options.redactor?.toolOutputRedactionRanges !== 'function') {
      throw new Error('Attachment read options require a redactor')
    }
    this.contextWindowTokens = options.contextWindowTokens
    this.ledger = options.ledger
    this.redactor = options.redactor
  }

  private readonly contextWindowTokens: number
  private readonly ledger: AttachmentReadLedger
  private readonly redactor: AttachmentReadRedactor
  private pending: PendingEmission | null = null

  name(): string {
    return 'clerum__attachment_read'
  }

  description(): string {
    return (
      'Read a file attached to the current message, by the attachmentId listed as attached_file in the turn context. ' +
      'Files with reader=text return UTF-8 text; read further pages with offset when truncated is true. ' +
      `A page holds at most maxBytes (default ${this.maxBytesPerCall} bytes) and ends earlier when the page or turn budget binds; ` +
      'when truncated is true, limit names the bound that ended the page and nextOffset is where the next page starts. ' +
      'Pass a smaller maxBytes to read less at a time. ' +
      'Files the native UTF-8 reader cannot interpret return a binary result without content; ' +
      'say this tool cannot read the file instead of guessing its content. ' +
      'Reading is current-turn only: page and turn budgets bound each response, and when they are exhausted ' +
      'you must reattach the file in a new message to continue from the reported offset.'
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

  async execute(params: Record<string, unknown>, context?: ExecutionContext): Promise<ToolOutput> {
    const start = Date.now()
    const attachment = this.sourceMessage.attachments?.find(
      candidate =>
        candidate.kind === 'file' &&
        candidate.id === params.attachmentId &&
        candidate.fileReference !== undefined
    )
    const reference = attachment?.fileReference
    if (!attachment || !reference) {
      if (!this.ledger.beginRead())
        return this.beginReadExhausted(attachment?.id, undefined, params)
      return this.error('attachment_not_found', start, {
        attachmentId: typeof params.attachmentId === 'string' ? params.attachmentId : '',
        offset: 0,
        fileBytes: 0,
      })
    }
    const identity = { attachmentId: attachment.id, referenceId: reference.id }

    if (!this.ledger.beginRead())
      return this.beginReadExhausted(identity.attachmentId, identity.referenceId, params)

    // #666 R4-M2 — a cold restart persists attachment metadata but never the
    // inline bytes, so the tool answers honestly instead of crashing on
    // Buffer.from(undefined).
    if (typeof attachment.dataBase64 !== 'string') {
      return this.ok(
        { ...identity, kind: 'binary', reader: 'none', reason: 'bytes_unavailable_after_restart' },
        start,
        { identity, offset: 0, fileBytes: 0, unavailableReason: 'bytes_unavailable_after_restart' }
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
      return this.error('range_invalid', start, {
        identity,
        offset: 0,
        fileBytes: this.cachedBytes(attachment.id, attachment.dataBase64),
      })
    }

    if (reference.reader === 'none') {
      return this.ok(
        { ...identity, kind: 'binary', reader: 'none', reason: 'no_reader_for_class' },
        start,
        {
          identity,
          offset,
          fileBytes: this.cachedBytes(attachment.id, attachment.dataBase64),
          unavailableReason: 'no_reader_for_class',
        }
      )
    }

    const { bytes, isText } = this.decode(attachment.id, attachment.dataBase64)
    if (!isText) {
      return this.ok(
        { ...identity, kind: 'binary', reader: 'none', reason: 'text_decode_rejected' },
        start,
        { identity, offset, fileBytes: bytes.length, unavailableReason: 'text_decode_rejected' }
      )
    }
    if (offset > bytes.length) {
      return this.error('range_invalid', start, { identity, offset, fileBytes: bytes.length })
    }
    if (offset < bytes.length && isUtf8Continuation(bytes[offset]!)) {
      return this.error('range_invalid', start, { identity, offset, fileBytes: bytes.length })
    }
    let end = Math.min(offset + maxBytes, bytes.length)
    while (end < bytes.length && isUtf8Continuation(bytes[end]!)) end -= 1
    if (end === offset && offset < bytes.length) {
      return this.error('range_invalid', start, { identity, offset, fileBytes: bytes.length })
    }

    const measure = context?.measureResult
    if (typeof measure !== 'function') {
      return this.error('measurement_unavailable', start, {
        identity,
        offset,
        fileBytes: bytes.length,
      })
    }

    const notice = this.exhaustedResult(identity.attachmentId, identity.referenceId, offset)
    const noticeCost = measure(JSON.stringify(notice))
    const allowance = this.ledger.pageAllowance(this.contextWindowTokens, noticeCost)
    let binding: AttachmentReadLimit | null = end < bytes.length ? 'max_bytes' : null
    const serialized = this.serializePage(bytes, identity, offset, end, end < bytes.length, binding)
    if (measure(serialized) > allowance) {
      // Binary-search the largest codepoint-aligned end that still fits. The
      // whole file is already decoded in memory; only serialization and the
      // pure measurement run per probe.
      // Advance from a boundary past the full codepoint that starts there;
      // `boundary + 1` alone lands inside a multi-byte character.
      const nextBoundary = (from: number): number => {
        let boundary = from
        while (boundary < bytes.length && isUtf8Continuation(bytes[boundary]!)) boundary += 1
        let next = boundary + 1
        while (next < bytes.length && isUtf8Continuation(bytes[next]!)) next += 1
        return next
      }
      let lo = nextBoundary(offset)
      let hi = end
      let best = -1
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2)
        let aligned = mid
        while (aligned > lo && isUtf8Continuation(bytes[aligned]!)) aligned -= 1
        const cost = measure(
          this.serializePage(
            bytes,
            identity,
            offset,
            aligned,
            aligned < bytes.length,
            'page_budget'
          )
        )
        if (cost <= allowance) {
          best = aligned
          lo = nextBoundary(aligned)
        } else {
          hi = aligned - 1
        }
      }
      if (best < 0) {
        return this.ok(notice, start, {
          identity,
          offset,
          fileBytes: bytes.length,
          reservedCost: noticeCost,
          exhausted: true,
        })
      }
      end = best
      binding =
        allowance < attachmentReadBudgets(this.contextWindowTokens).pageTokens
          ? 'turn_budget'
          : 'page_budget'
    }

    return this.ok(
      this.pageResult(bytes, identity, offset, end, end < bytes.length, binding),
      start,
      {
        identity,
        offset,
        fileBytes: bytes.length,
        bytesRead: end - offset,
        reservedCost: measure(
          this.serializePage(bytes, identity, offset, end, end < bytes.length, binding)
        ),
      }
    )
  }

  /**
   * Final budget fence. Runs once per executed read after safety, spillover
   * and any result transform. If the final message outgrew the reservation,
   * replace it with the trusted exhausted notice at the ORIGINAL offset. A
   * notice that no longer fits the turn is charged to the bounded notice
   * overdraft; once that is spent too, throw so publication stops without a
   * rerun.
   */
  finalizeResult(result: ToolResult, context: ToolEmissionContext): ToolResult {
    const pending = this.pending
    if (!pending) throw new Error('AttachmentReadTool finalize called without a pending read')
    this.pending = null

    const actualCost = result.emittedMessageCost ?? context.measureContent(result.content)
    if (!Number.isSafeInteger(actualCost) || actualCost < 0) {
      throw new Error('Attachment read emission cost is not a safe non-negative integer')
    }
    const overran = pending.reservedCost !== null && actualCost > pending.reservedCost
    if (!overran && this.ledger.canEmit(this.contextWindowTokens, actualCost)) {
      this.ledger.debit(this.contextWindowTokens, actualCost, pending.bytesRead)
      return { ...result, emittedMessageCost: actualCost }
    }

    const noticeRaw = JSON.stringify(
      this.exhaustedResult(pending.attachmentId, pending.referenceId, pending.offset)
    )
    const noticeContent = context.renderContent(noticeRaw)
    const noticeCost = context.measureContent(noticeContent)
    if (this.ledger.canEmit(this.contextWindowTokens, noticeCost)) {
      this.ledger.debit(this.contextWindowTokens, noticeCost, 0)
    } else {
      // Throws once the notice overdraft is spent, which stops the turn.
      this.ledger.debitNotice(this.contextWindowTokens, noticeCost)
    }
    return {
      ...result,
      content: noticeContent,
      rawContent: noticeRaw,
      is_error: false,
      emittedMessageCost: noticeCost,
      metadata: {
        attachmentRead: {
          origin: pending.offset === 0 ? 'current' : 'current_resumed',
          offset: pending.offset,
          length: 0,
          fileBytes: pending.fileBytes,
          truncated: true,
          paused: true,
        },
      },
    }
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

  // Computed once per text attachment, over the whole decoded text.
  private redactions(attachmentId: string): ByteRedaction[] {
    const entry = this.decoded.get(attachmentId)
    if (!entry?.isText) {
      throw new Error('Attachment redactions requested before the text was decoded')
    }
    if (entry.redactions) return entry.redactions
    // `ignoreBOM: true` keeps a leading U+FEFF, so every UTF-16 index of the
    // text maps to a byte of the file.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(entry.bytes)
    entry.redactions = toByteRedactions(
      text,
      this.redactor.toolOutputRedactionRanges(this.name(), text)
    )
    return entry.redactions
  }

  /**
   * The text of bytes `[offset, end)` with the part of every redaction range
   * that falls inside it replaced. Range and page bounds are code point
   * boundaries, so every decoded segment is whole UTF-8.
   */
  private pageText(bytes: Buffer, attachmentId: string, offset: number, end: number): string {
    const redactions = this.redactions(attachmentId)
    // A byte order mark is dropped only at the start of the file; further in,
    // U+FEFF is file content and stays.
    const decode = (from: number, to: number): string =>
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: from > 0 }).decode(
        bytes.subarray(from, to)
      )
    let lo = 0
    let hi = redactions.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (redactions[mid]!.end <= offset) lo = mid + 1
      else hi = mid
    }
    const parts: string[] = []
    let cursor = offset
    for (let i = lo; i < redactions.length; i++) {
      const range = redactions[i]!
      const from = Math.max(range.start, offset)
      const to = Math.min(range.end, end)
      if (from >= to) break
      parts.push(decode(cursor, from), range.replacement)
      cursor = to
    }
    parts.push(decode(cursor, end))
    return parts.join('')
  }

  private ok(
    result: AttachmentReadResult,
    start: number,
    pending: {
      identity: { attachmentId: string; referenceId: FileReferenceV1['id'] }
      offset: number
      fileBytes: number
      bytesRead?: number
      reservedCost?: number
      exhausted?: boolean
      unavailableReason?:
        | 'no_reader_for_class'
        | 'text_decode_rejected'
        | 'bytes_unavailable_after_restart'
    }
  ): ToolOutput {
    const content = JSON.stringify(result)
    const truncated =
      result.kind === 'text' ? result.truncated : result.kind === 'read_budget_exhausted'
    const limit = result.kind === 'text' ? result.limit : undefined
    this.pending = {
      attachmentId: pending.identity.attachmentId,
      referenceId: pending.identity.referenceId,
      offset: pending.offset,
      fileBytes: pending.fileBytes,
      bytesRead: pending.bytesRead ?? 0,
      reservedCost: pending.reservedCost ?? null,
    }
    return {
      content,
      duration_ms: Date.now() - start,
      is_error: false,
      metadata: {
        attachmentRead: {
          origin: pending.offset === 0 ? 'current' : 'current_resumed',
          offset: pending.offset,
          length: pending.bytesRead ?? 0,
          fileBytes: pending.fileBytes,
          ...(truncated ? { truncated: true } : { truncated: false }),
          ...(limit ? { limit } : {}),
          ...(pending.exhausted ? { paused: true } : { paused: false }),
          ...(pending.unavailableReason ? { unavailableReason: pending.unavailableReason } : {}),
        },
      },
    }
  }

  private error(
    code: AttachmentReadErrorCode,
    start: number,
    pending: {
      identity?: { attachmentId: string; referenceId?: FileReferenceV1['id'] }
      attachmentId?: string
      offset: number
      fileBytes: number
    }
  ): ToolOutput {
    this.pending = {
      attachmentId: pending.identity?.attachmentId ?? pending.attachmentId ?? '',
      referenceId: pending.identity?.referenceId,
      offset: pending.offset,
      fileBytes: pending.fileBytes,
      bytesRead: 0,
      reservedCost: null,
    }
    return {
      content: JSON.stringify({ error: code, message: ERROR_MESSAGES[code] }),
      duration_ms: Date.now() - start,
      is_error: true,
    }
  }

  private beginReadExhausted(
    attachmentId: string | undefined,
    referenceId: FileReferenceV1['id'] | undefined,
    params: Record<string, unknown>
  ): ToolOutput {
    const offset =
      typeof params.offset === 'number' && Number.isSafeInteger(params.offset) && params.offset >= 0
        ? params.offset
        : 0
    const result = this.exhaustedResult(attachmentId ?? '', referenceId, offset)
    this.pending = {
      attachmentId: attachmentId ?? '',
      referenceId,
      offset,
      fileBytes: 0,
      bytesRead: 0,
      reservedCost: null,
    }
    return {
      content: JSON.stringify(result),
      duration_ms: 0,
      is_error: false,
      metadata: {
        attachmentRead: {
          origin: offset === 0 ? 'current' : 'current_resumed',
          offset,
          length: 0,
          fileBytes: 0,
          truncated: true,
          paused: true,
        },
      },
    }
  }

  private exhaustedResult(
    attachmentId: string,
    referenceId: FileReferenceV1['id'] | undefined,
    resumeOffset: number
  ): AttachmentReadResult {
    return {
      attachmentId,
      ...(referenceId !== undefined ? { referenceId } : {}),
      kind: 'read_budget_exhausted',
      resumeOffset,
      message: EXHAUSTED_MESSAGE,
    }
  }

  private pageResult(
    bytes: Buffer,
    identity: { attachmentId: string; referenceId: FileReferenceV1['id'] },
    offset: number,
    end: number,
    truncated: boolean,
    limit: AttachmentReadLimit | null
  ): AttachmentReadResult {
    const text = this.pageText(bytes, identity.attachmentId, offset, end)
    return {
      attachmentId: identity.attachmentId,
      referenceId: identity.referenceId,
      kind: 'text',
      byteRange: { offset, length: end - offset },
      truncated,
      ...(truncated && limit ? { limit } : {}),
      ...(truncated ? { nextOffset: end } : {}),
      text,
    }
  }

  private serializePage(
    bytes: Buffer,
    identity: { attachmentId: string; referenceId: FileReferenceV1['id'] },
    offset: number,
    end: number,
    truncated: boolean,
    limit: AttachmentReadLimit | null
  ): string {
    return JSON.stringify(this.pageResult(bytes, identity, offset, end, truncated, limit))
  }

  private cachedBytes(attachmentId: string, dataBase64: string): number {
    return this.decode(attachmentId, dataBase64).bytes.length
  }
}
