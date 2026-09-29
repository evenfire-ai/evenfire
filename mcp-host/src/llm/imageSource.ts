import type { MessageContentImageSource, MessageContentPart } from '../core/types'
import { CodexAuthorizeError } from './providerAttemptAuthorizer'

/** A pre-authorize refusal: known and non-retryable in both providers. */
export const IMAGE_SOURCE_INVALID = 'image_source_invalid'

function imageSourceError(detail: string): CodexAuthorizeError {
  return new CodexAuthorizeError(
    IMAGE_SOURCE_INVALID,
    `image part has no usable provenance source (${detail}); host producers must attach the attachment or tool call it came from`
  )
}

/**
 * Provenance for one image part, shared by the Codex and Grok providers. Both
 * contracts require a source on every V2 image and bound its id charset; this
 * checks only presence and shape, so each contract stays the single owner of
 * format and size limits.
 */
export function projectImageSource(
  part: Extract<MessageContentPart, { type: 'image' }>
): MessageContentImageSource {
  const source = part.source
  if (!source) throw imageSourceError('missing source')
  if (source.kind === 'attachment') {
    if (!source.attachmentId?.trim()) throw imageSourceError('empty attachmentId')
    if (!source.messageId?.trim()) throw imageSourceError('empty messageId')
    return {
      kind: 'attachment',
      attachmentId: source.attachmentId,
      messageId: source.messageId,
    }
  }
  if (source.kind === 'tool') {
    if (!source.attachmentId?.trim()) throw imageSourceError('empty attachmentId')
    if (!source.toolCallId?.trim()) throw imageSourceError('empty toolCallId')
    return { kind: 'tool', attachmentId: source.attachmentId, toolCallId: source.toolCallId }
  }
  // A GFS read (#670) is a tool result: both contracts name it by its read's
  // attachment and tool call.
  if (source.kind === 'gfs') {
    if (!source.attachmentId?.trim()) throw imageSourceError('empty attachmentId')
    if (!source.toolCallId?.trim()) throw imageSourceError('empty toolCallId')
    return { kind: 'tool', attachmentId: source.attachmentId, toolCallId: source.toolCallId }
  }
  throw imageSourceError('unknown source kind')
}
