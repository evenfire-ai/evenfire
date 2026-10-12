import type { ChatMessage } from '../core/types'
import { type VisualDeliveryLimits, visualDimensionLimit } from './deliveryLimits'
import { VISUAL_INPUT_LIMITS, VisualInputError } from './policy'

export function hasGfsImageInput(messages: readonly ChatMessage[]): boolean {
  return messages.some(message =>
    message.contentParts?.some(part => part.type === 'image' && part.source?.kind === 'gfs')
  )
}

/** Shape profiles require positive integer dimensions measured by each producer. */
export function hasUnknownImageGeometry(
  messages: readonly ChatMessage[],
  limits: VisualDeliveryLimits
): boolean {
  if (
    limits.maxDimension === undefined &&
    limits.maxPixels === undefined &&
    limits.maxDimensionAboveImageCount === undefined
  )
    return false
  return messages.some(message =>
    message.contentParts?.some(
      part =>
        part.type === 'image' &&
        (typeof part.width !== 'number' ||
          !Number.isSafeInteger(part.width) ||
          part.width <= 0 ||
          typeof part.height !== 'number' ||
          !Number.isSafeInteger(part.height) ||
          part.height <= 0)
    )
  )
}

/** Include all image origins when a new GFS image enters a request. */
export function assertVisualRequestFits(
  messages: readonly ChatMessage[],
  request: unknown,
  verificationRequired = false,
  limits?: VisualDeliveryLimits | null
): void {
  const hasGfs = hasGfsImageInput(messages)
  if (!verificationRequired && !hasGfs) return
  const hasImages = messages.some(message =>
    message.contentParts?.some(part => part.type === 'image')
  )
  // Existing callers also request serialized-body verification for plain text.
  // Preserve that contract; this branch cannot authorize any pixels.
  if (!hasImages) {
    if (Buffer.byteLength(JSON.stringify(request), 'utf8') > VISUAL_INPUT_LIMITS.requestBytes)
      throw new VisualInputError('limit_exceeded')
    return
  }
  // The generic inline budget is not a provider delivery contract. An absent
  // attempt profile must never authorize GFS pixels, including small images.
  // verificationRequired preserves the GFS requirement after a local shaper
  // drops optional source metadata; it cannot fall back to a generic budget.
  if (!limits) throw new VisualInputError('unsupported_format')
  if (hasUnknownImageGeometry(messages, limits)) throw new VisualInputError('unsupported_format')
  const imageCount = messages.reduce(
    (total, message) =>
      total + (message.contentParts?.filter(part => part.type === 'image').length ?? 0),
    0
  )
  if (imageCount > limits.maxImages) throw new VisualInputError('limit_exceeded')
  const dimensionLimit = visualDimensionLimit(limits, imageCount)
  let totalImageBytes = 0
  for (const message of messages) {
    for (const part of message.contentParts ?? []) {
      if (part.type !== 'image') continue
      // Admission already validated canonical base64; sizing needs no decoded copy.
      const imageBytes = Buffer.byteLength(part.data, 'base64')
      totalImageBytes += imageBytes
      if (
        (limits.maxImageBytes !== undefined && imageBytes > limits.maxImageBytes) ||
        (limits.maxTotalImageBytes !== undefined && totalImageBytes > limits.maxTotalImageBytes) ||
        (limits.maxImageEncodedBytes !== undefined &&
          part.data.length > limits.maxImageEncodedBytes) ||
        (part.width !== undefined &&
          part.height !== undefined &&
          ((dimensionLimit !== undefined &&
            (part.width > dimensionLimit || part.height > dimensionLimit)) ||
            (limits.maxPixels !== undefined && part.width * part.height > limits.maxPixels)))
      )
        throw new VisualInputError('limit_exceeded')
    }
  }
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > limits.maxVisualRequestBytes)
    throw new VisualInputError('limit_exceeded')
}
