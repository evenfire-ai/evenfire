/**
 * Incoming Desktop / rpc-proxy image attachments.
 *
 * `CLERUM_ATTACHMENT_MAX_COUNT` is the outbound response delivery cap
 * (Slack / Telegram / channel-reader). Inbound Codex composer images use the
 * shared visual contract (`VISUAL_LIMITS.maxImages`) so a live ConfigMap of 3
 * cannot silently drop the 4th screenshot.
 */
import { VISUAL_LIMITS } from '@clerum/llm-provider-attempt-contract'
import type { Attachment } from './core/types'
import { approxDecodedBytes } from './shared/encoding'

export function sanitizeIncomingAttachments(
  raw: Attachment[] | undefined,
  maxBytes: number
): Attachment[] | undefined {
  if (!raw || raw.length === 0) {
    return undefined
  }

  const sanitized: Attachment[] = []
  let droppedOverCap = 0
  for (const attachment of raw) {
    if (sanitized.length >= VISUAL_LIMITS.maxImages) {
      droppedOverCap += 1
      continue
    }
    const isSupportedImageMime =
      attachment.mimeType === 'image/jpeg' || attachment.mimeType === 'image/png'
    if (
      attachment.kind !== 'image' ||
      !isSupportedImageMime ||
      attachment.encoding !== 'base64' ||
      typeof attachment.dataBase64 !== 'string' ||
      !attachment.dataBase64.trim()
    ) {
      continue
    }
    const decodedBytes = approxDecodedBytes(attachment.dataBase64)
    if (decodedBytes > maxBytes) {
      continue
    }
    sanitized.push(attachment)
  }

  if (droppedOverCap > 0) {
    console.warn(
      `[Main] Dropping ${droppedOverCap} incoming image attachment(s) beyond ${VISUAL_LIMITS.maxImages}`
    )
  }

  return sanitized.length > 0 ? sanitized : undefined
}
