import type { ChatMessage, MessageContentPart } from '../core/types'
import { VISUAL_INPUT_LIMITS, VisualInputError } from './policy'

function referenceResource(part: MessageContentPart) {
  if (part.type !== 'image' || !part.source) return undefined
  const { kind, drive, resourceId, gfsUri, version, name } = part.source
  return { kind, drive, resourceId, gfsUri, version, name }
}

/** Replace image parts with references when the destination cannot take them. */
export function degradeUnverifiedImageInput(messages: ChatMessage[]): boolean {
  let changed = false
  for (const message of messages) {
    if (!message.contentParts?.some(part => part.type === 'image')) continue
    changed = true
    message.contentParts = message.contentParts.map(part => {
      if (part.type !== 'image') return part
      const resource = referenceResource(part)
      return {
        type: 'text' as const,
        text: JSON.stringify({
          delivery: 'reference_only',
          reason: 'image_input_not_verified_for_selected_model',
          ...(resource ? { resource } : {}),
        }),
      }
    })
    if (message.role === 'user') {
      message.content =
        'Image input was not verified for the selected model. Treat the listed resources as references only.'
    }
  }
  return changed
}

export function hasGfsImageInput(messages: readonly ChatMessage[]): boolean {
  return messages.some(message =>
    message.contentParts?.some(part => part.type === 'image' && part.source?.kind === 'gfs')
  )
}

/** Include all image origins when a new GFS image enters a request. */
export function assertVisualRequestFits(
  messages: readonly ChatMessage[],
  request: unknown,
  verificationRequired = false
): void {
  if (!verificationRequired && !hasGfsImageInput(messages)) return
  let count = 0
  for (const message of messages) {
    for (const part of message.contentParts ?? []) {
      if (part.type !== 'image') continue
      count++
      if (
        count > VISUAL_INPUT_LIMITS.imagesPerRequest ||
        (part.source?.kind === 'gfs' &&
          part.data.length > 4 * Math.ceil(VISUAL_INPUT_LIMITS.fileBytes / 3))
      )
        throw new VisualInputError('limit_exceeded')
    }
  }
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > VISUAL_INPUT_LIMITS.requestBytes)
    throw new VisualInputError('limit_exceeded')
}
