import type { Attachment } from '../core/types'
import type { TaskError } from '../queue/types'

export type IncomingImageValidation =
  | { ok: true; attachments: Attachment[] | undefined }
  | { ok: false; error: TaskError }

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
      !['image/jpeg', 'image/png'].includes(item.mimeType) ||
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
    if (
      !data.length ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
    ) {
      return reject('An image has invalid base64 data. Attach the original file again.')
    }
    const bytes = Buffer.from(data, 'base64')
    if (bytes.length > limits.maxBytes) return reject('An image exceeds the attachment size limit.')
    if (bytes.toString('base64') !== data)
      return reject('An image has invalid base64 data. Attach the original file again.')
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
