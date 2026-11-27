/**
 * X12 / X11 — Projection & graceful demotion helpers for `channel_retained`
 * image parts carried on user messages (`ChatMessage.imageOrigin === 'channel_retained'`).
 *
 * Unlike Desktop `rpc` inline images (which retain `#654/#669` hard-refusal),
 * channel-retained PNG/JPEG images degrade deterministically to text capability /
 * framing / limit notices on non-vision models, failover, framing defects,
 * provider delivery limit overflow, and approval suspension (`projectGfsApproval`)
 * without mutating the caller's input array.
 */
import { type ChatMessage, type MessageContentPart, textContentFromParts } from '../core/types'

export type ChannelImageDemotionReason =
  | 'model_image_input_unavailable'
  | 'image_framing_invalid'
  | 'image_input_limit_exceeded'
  | 'geometry_unknown'
  | 'suspended_for_approval'

export type ChannelRetainedImagePart = Extract<MessageContentPart, { type: 'image' }>

export function channelRetainedImageParts(
  messages: readonly ChatMessage[]
): ChannelRetainedImagePart[] {
  const out: ChannelRetainedImagePart[] = []
  for (const message of messages) {
    if (message.imageOrigin !== 'channel_retained' || !Array.isArray(message.contentParts)) {
      continue
    }
    for (const part of message.contentParts) {
      if (part && part.type === 'image' && !part.sourceIdentityOnly) {
        out.push(part)
      }
    }
  }
  return out
}

function labelForChannelImage(part: ChannelRetainedImagePart): string {
  if (typeof part.filename === 'string' && part.filename.trim().length > 0) {
    return part.filename.trim()
  }
  if (part.source?.kind === 'attachment' && part.source.attachmentId) {
    return `attachment ${part.source.attachmentId}`
  }
  return 'retained image'
}

export function buildChannelImageDemotionNotice(
  part: ChannelRetainedImagePart,
  reason: ChannelImageDemotionReason,
  detail?: string
): string {
  const label = labelForChannelImage(part)
  switch (reason) {
    case 'model_image_input_unavailable':
      return `[Channel image "${label}" retained in storage was not sent to this model because it does not support image input${detail ? `: ${detail}` : ''}.]`
    case 'image_framing_invalid':
      return `[Channel image "${label}" retained in storage was not sent to the vision model because its image container framing is unsupported or malformed.]`
    case 'image_input_limit_exceeded':
      return `[Channel image "${label}" retained in storage was not sent to this model attempt because it exceeds provider visual delivery limits.]`
    case 'geometry_unknown':
      return `[Channel image "${label}" retained in storage was not sent to this model attempt because its image dimensions could not be verified.]`
    case 'suspended_for_approval':
      return `[Channel image "${label}" omitted from suspended approval snapshot; retained in storage.]`
  }
}

/**
 * Demote only the `selected` image parts inside `imageOrigin === 'channel_retained'`
 * messages to deterministic text notices without mutating `messages`.
 */
export function projectChannelRetainedMessages(
  messages: readonly ChatMessage[],
  selected: ReadonlySet<MessageContentPart>,
  reason: ChannelImageDemotionReason,
  detail?: string
): ChatMessage[] {
  if (selected.size === 0) return [...messages]
  return messages.map(message => {
    if (
      message.imageOrigin !== 'channel_retained' ||
      !Array.isArray(message.contentParts) ||
      !message.contentParts.some(part => part.type === 'image' && selected.has(part))
    ) {
      return message
    }
    const parts: MessageContentPart[] = message.contentParts.map(part =>
      part.type === 'image' && selected.has(part)
        ? {
            type: 'text',
            text: buildChannelImageDemotionNotice(part, reason, detail),
          }
        : part
    )
    const content = textContentFromParts(parts)
    if (!parts.some(part => part.type === 'image')) {
      const { contentParts: _dropped, imageOrigin: _origin, ...rest } = message
      return { ...rest, content }
    }
    return { ...message, content, contentParts: parts }
  })
}
