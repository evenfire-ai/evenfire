import { createHash } from 'node:crypto'
import {
  type FileReferenceV1,
  buildAttachmentFileReference,
  classifyBytes,
} from '@clerum/gfs-interaction-policy'
import { FileAttachmentErrorCode } from '../core/errors'
import type { Attachment } from '../core/types'
import {
  type ImageAttachmentMimeType,
  isCanonicalBase64Shape,
  isImageAttachmentMime,
} from '../llm/imageInput'
import type { TaskError } from '../queue/types'

/**
 * Attachments (images and files together) accepted in one incoming message.
 * Kept separate from `CLERUM_ATTACHMENT_MAX_COUNT`, which caps the attachments
 * a response returns.
 * Must match COMPOSER_MAX_IMAGE_ATTACHMENTS in desktop-app/ui/src/constants/attachments.ts.
 * Per-image bytes stay on the channel `attachmentMaxBytes` (issue #654 / PR
 * #669) — this module must not clamp general inbound traffic to the Codex
 * `VISUAL_LIMITS`. The Codex chat hop is a separate 24 MiB parser with a
 * 16 MiB credited image budget. Per-file bytes use `attachmentFileMaxBytes`
 * (issue #666). This count is the fail-loud admission cap.
 */
export const INCOMING_ATTACHMENT_MAX_COUNT = 20

export type IncomingAttachmentValidation =
  | { ok: true; attachments: Attachment[] | undefined; fileReferences: FileReferenceV1[] }
  | { ok: false; error: TaskError }

export interface IncomingAttachmentLimits {
  maxCount: number
  /** Decoded bytes per `kind:'image'` attachment. */
  maxBytes: number
  /** Decoded bytes per `kind:'file'` attachment. */
  maxFileBytes: number
  /** The message the attachments arrived with; part of each file reference id. */
  messageId: string
}

/**
 * First bytes every accepted encoding must start with. The declared media type
 * decides how the provider serializes the image, so a declaration the bytes
 * contradict is rejected here rather than forwarded upstream (CWE-345).
 */
const MIME_SIGNATURES: Readonly<Record<ImageAttachmentMimeType, Buffer>> = {
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff]),
}

const SHA256_HEX = /^[0-9a-f]{64}$/

function bytesMatchDeclaredMime(bytes: Buffer, mimeType: ImageAttachmentMimeType): boolean {
  const signature = MIME_SIGNATURES[mimeType]
  return bytes.length >= signature.length && bytes.subarray(0, signature.length).equals(signature)
}

type ItemResult = { ok: true; attachment: Attachment } | { ok: false; error: TaskError }

function taskError(code: string, message: string): { ok: false; error: TaskError } {
  return { ok: false, error: { code, message, retryable: false, provider: 'unknown' } }
}

const rejectImage = (message: string) => taskError('LLM_INVALID_ATTACHMENT', message)

// The image branch is the #669 contract, unchanged: same checks, same order,
// same code and messages.
function validateImage(item: Record<string, unknown>, maxBytes: number): ItemResult {
  if (
    !isImageAttachmentMime(item.mimeType) ||
    item.encoding !== 'base64' ||
    typeof item.dataBase64 !== 'string' ||
    typeof item.id !== 'string' ||
    !item.id.trim()
  ) {
    return rejectImage('Only PNG or JPEG images encoded as base64 are supported.')
  }
  const data = item.dataBase64
  // Check length before decoding so validation cannot allocate an oversized
  // binary buffer. Canonical base64 avoids ambiguous/partially decoded input.
  if (data.length > Math.ceil(maxBytes / 3) * 4)
    return rejectImage('An image exceeds the attachment size limit.')
  if (!isCanonicalBase64Shape(data)) {
    return rejectImage('An image has invalid base64 data. Attach the original file again.')
  }
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length > maxBytes) return rejectImage('An image exceeds the attachment size limit.')
  if (bytes.toString('base64') !== data)
    return rejectImage('An image has invalid base64 data. Attach the original file again.')
  if (!bytesMatchDeclaredMime(bytes, item.mimeType))
    return rejectImage('An image does not match its declared type. Attach the original file again.')
  return {
    ok: true,
    attachment: {
      id: item.id,
      kind: 'image',
      mimeType: item.mimeType,
      encoding: 'base64',
      dataBase64: data,
      ...(typeof item.filename === 'string' ? { filename: item.filename } : {}),
      ...(typeof item.width === 'number' && Number.isFinite(item.width) && item.width > 0
        ? { width: item.width }
        : {}),
      ...(typeof item.height === 'number' && Number.isFinite(item.height) && item.height > 0
        ? { height: item.height }
        : {}),
    },
  }
}

const rejectFile = (message: string) => taskError(FileAttachmentErrorCode.Invalid, message)

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Any file type is admitted (D14). Only an invalid shape, an oversized file or
 * a digest the bytes contradict is rejected; the class and reader are derived
 * from the whole file and never from the caller's declaration.
 */
function validateFile(item: Record<string, unknown>, limits: IncomingAttachmentLimits): ItemResult {
  const digest = item.digest
  if (
    typeof item.id !== 'string' ||
    !item.id.trim() ||
    typeof item.filename !== 'string' ||
    typeof item.mimeType !== 'string' ||
    typeof item.detectedMediaType !== 'string' ||
    item.encoding !== 'base64' ||
    typeof item.dataBase64 !== 'string' ||
    typeof item.sizeBytes !== 'number' ||
    !Number.isSafeInteger(item.sizeBytes) ||
    item.sizeBytes < 0 ||
    !isPlainRecord(digest) ||
    digest.algorithm !== 'sha256' ||
    typeof digest.hex !== 'string' ||
    !SHA256_HEX.test(digest.hex)
  ) {
    return rejectFile('A file attachment is malformed. Attach the original file again.')
  }
  const data = item.dataBase64
  const tooLarge = taskError(
    FileAttachmentErrorCode.TooLarge,
    'A file exceeds the attachment size limit.'
  )
  // Same pre-decode bound as the image branch: never allocate an oversized buffer.
  if (item.sizeBytes > limits.maxFileBytes || data.length > Math.ceil(limits.maxFileBytes / 3) * 4)
    return tooLarge
  // A zero-byte file is a file; its canonical base64 is the empty string.
  if (data !== '' && !isCanonicalBase64Shape(data)) {
    return rejectFile('A file has invalid base64 data. Attach the original file again.')
  }
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length > limits.maxFileBytes) return tooLarge
  if (bytes.toString('base64') !== data)
    return rejectFile('A file has invalid base64 data. Attach the original file again.')
  if (bytes.length !== item.sizeBytes)
    return rejectFile('A file does not match its declared size. Attach the original file again.')
  const hex = createHash('sha256').update(bytes).digest('hex')
  if (hex !== digest.hex) {
    return taskError(
      FileAttachmentErrorCode.DigestMismatch,
      'A file does not match its declared digest. Attach the original file again.'
    )
  }

  const declaredMediaType = item.mimeType === '' ? null : item.mimeType
  // The Host's classification is the only one used: `mismatch` compares the
  // declared type with the bytes, never with the client's own detection.
  const classification = classifyBytes({
    bytes,
    totalByteLength: bytes.length,
    declaredMediaType,
    filename: item.filename,
  })
  const reference = buildAttachmentFileReference({
    attachmentId: item.id,
    messageId: limits.messageId,
    name: item.filename,
    declaredMediaType,
    byteLength: bytes.length,
    digestHex: hex,
    classification,
  })
  if (!reference.ok) {
    // Every name problem the contract reports starts with "name "; any other
    // failure is not something the user can fix by renaming the file.
    return reference.message.startsWith('name ')
      ? rejectFile('A file attachment has an invalid name. Rename the file and attach it again.')
      : rejectFile(`A file attachment is invalid: ${reference.message}`)
  }
  return {
    ok: true,
    attachment: {
      id: item.id,
      kind: 'file',
      mimeType: item.mimeType,
      encoding: 'base64',
      dataBase64: data,
      filename: reference.value.name,
      sizeBytes: bytes.length,
      detectedMediaType: classification.detectedMediaType,
      digest: { algorithm: 'sha256', hex },
      fileReference: reference.value,
    },
  }
}

/** Reject the whole message rather than silently sending only part of it. */
export function validateIncomingAttachments(
  raw: unknown,
  limits: IncomingAttachmentLimits
): IncomingAttachmentValidation {
  if (raw == null) return { ok: true, attachments: undefined, fileReferences: [] }
  if (!Array.isArray(raw)) return rejectImage('Attachments must be a list.')
  if (!raw.length) return { ok: true, attachments: undefined, fileReferences: [] }
  // One ceiling over images and files together, checked before either branch.
  if (raw.length > limits.maxCount) {
    const carriesFiles = raw.some(item => isPlainRecord(item) && item.kind === 'file')
    return rejectImage(
      carriesFiles
        ? 'Too many attachments. Remove an attachment and try again.'
        : 'Too many image attachments. Remove an image and try again.'
    )
  }
  const attachments: Attachment[] = []
  const fileReferences: FileReferenceV1[] = []
  const ids = new Set<string>()
  for (const item of raw) {
    const result = !isPlainRecord(item)
      ? rejectImage('Only PNG or JPEG images encoded as base64 are supported.')
      : item.kind === 'file'
        ? validateFile(item, limits)
        : item.kind === 'image'
          ? validateImage(item, limits.maxBytes)
          : rejectImage('Only PNG or JPEG images encoded as base64 are supported.')
    if (!result.ok) return result
    // Ids name attachments in the ack and in tool calls, across both kinds.
    if (ids.has(result.attachment.id)) return rejectImage('Each attachment id must appear once.')
    ids.add(result.attachment.id)
    attachments.push(result.attachment)
    if (result.attachment.fileReference) fileReferences.push(result.attachment.fileReference)
  }
  return { ok: true, attachments, fileReferences }
}
