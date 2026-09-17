import type { ChatMessage } from '../core/types'
import { VISUAL_INPUT_LIMITS, VisualInputError } from './policy'

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
