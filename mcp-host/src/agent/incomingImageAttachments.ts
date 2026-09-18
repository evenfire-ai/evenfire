import type { Attachment } from '../core/types'
import {
  type ImageAttachmentMimeType,
  isCanonicalBase64Shape,
  isImageAttachmentMime,
} from '../llm/imageInput'
import type { TaskError } from '../queue/types'

/**
 * Images accepted in one incoming message. Kept separate from
 * `CLERUM_ATTACHMENT_MAX_COUNT`, which caps the attachments a response returns.
 * Must match COMPOSER_MAX_IMAGE_ATTACHMENTS in desktop-app/ui/src/constants/attachments.ts.
 * The combined size is bounded by the 10 MB JSON body limit of rpc-proxy and
 * the host server, which carry the images inline.
 */
export const INCOMING_IMAGE_MAX_COUNT = 20

export type IncomingImageValidation =
  | { ok: true; attachments: Attachment[] | undefined }
  | { ok: false; error: TaskError }

/**
 * First bytes every accepted encoding must start with. The declared media type
 * decides how the provider serializes the image, so a declaration the bytes
 * contradict is rejected here rather than forwarded upstream (CWE-345).
 */
const MIME_SIGNATURES: Readonly<Record<ImageAttachmentMimeType, Buffer>> = {
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff]),
}

function bytesMatchDeclaredMime(bytes: Buffer, mimeType: ImageAttachmentMimeType): boolean {
  const signature = MIME_SIGNATURES[mimeType]
  return bytes.length >= signature.length && bytes.subarray(0, signature.length).equals(signature)
}

/** Reject the whole visual input rather than silently sending only its text. */
export function validateIncomingImageAttachments(
  raw: unknown,
  limits: { maxCount: number; maxBytes: number }
): IncomingImageValidation {
  const reject = (message: string): IncomingImageValidation => ({
    ok: false,
    error: { code: 'LLM_INVALID_ATTACHMENT', message, retryable: false, provider: 'unknown' },
  })
  if (raw == null) return { ok: true, attachments: undefined }
  if (!Array.isArray(raw)) return reject('Image attachments must be a list.')
  if (!raw.length) return { ok: true, attachments: undefined }
  if (raw.length > limits.maxCount)
    return reject('Too many image attachments. Remove an image and try again.')
  const attachments: Attachment[] = []
  for (const item of raw) {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      item.kind !== 'image' ||
      !isImageAttachmentMime(item.mimeType) ||
      item.encoding !== 'base64' ||
      typeof item.dataBase64 !== 'string' ||
      typeof item.id !== 'string' ||
      !item.id.trim()
    ) {
      return reject('Only PNG or JPEG images encoded as base64 are supported.')
    }
    const data = item.dataBase64
    // Check length before decoding so validation cannot allocate an oversized
    // binary buffer. Canonical base64 avoids ambiguous/partially decoded input.
    if (data.length > Math.ceil(limits.maxBytes / 3) * 4)
      return reject('An image exceeds the attachment size limit.')
    if (!isCanonicalBase64Shape(data)) {
      return reject('An image has invalid base64 data. Attach the original file again.')
    }
    const bytes = Buffer.from(data, 'base64')
    if (bytes.length > limits.maxBytes) return reject('An image exceeds the attachment size limit.')
    if (bytes.toString('base64') !== data)
      return reject('An image has invalid base64 data. Attach the original file again.')
    if (!bytesMatchDeclaredMime(bytes, item.mimeType))
      return reject('An image does not match its declared type. Attach the original file again.')
    attachments.push({
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
    })
  }
  return { ok: true, attachments }
}
