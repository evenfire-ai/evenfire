import type { Attachment, ResumeFileAttachment, ResumeSourceMessage } from '../core/types'
import type { IncomingMessage } from '../server'

/**
 * #666 R4-M2 — what a cold restart needs from the suspended turn's message, and
 * nothing else. Each field is read after a restart:
 *
 * - `sender`, `channelType`, `channelId`, `threadId`: the approval binding, the
 *   workspace root, `session_search`, `cron_manage` ownership and the rpc scope.
 * - `metadata.teamId`: rpc team scope and budget attribution.
 * - `content`: the provider-workflow access gate and the tool registry.
 * - `hostRef`, `messageId`, `timestamp`: Host attribution and the pins' identity.
 * - `imageModel`: the visual model the turn was pinned to.
 * - file attachments (metadata) and `fileReferenceResolutions`: the version pins
 *   and attachment lines. Image attachments are dropped (their content lives in
 *   the frozen snapshot) and inline bytes (dataBase64) never persist in the
 *   approval row. (#1043: a resumable model-step checkpoint holds inline file
 *   bytes separately, for at most its short byte TTL — migration 018.)
 *
 * Everything else the channel delivered (the raw Slack, email or Telegram
 * payload in `metadata`, `providerIdentity`, `traceContext`, the model piggyback)
 * is not persisted: an allowlist keeps a field added to the message later out of
 * the durable row until a restart actually needs it.
 */
export function sourceMessageForResume(
  message: IncomingMessage | undefined
): ResumeSourceMessage | undefined {
  if (!message) return undefined
  const files = message.attachments?.filter(attachment => attachment.kind === 'file') ?? []
  const teamId = message.metadata?.teamId
  return {
    content: message.content,
    channelType: message.channelType,
    channelId: message.channelId,
    sender: message.sender,
    timestamp: message.timestamp,
    messageId: message.messageId,
    hostRef: message.hostRef,
    ...(message.threadId !== undefined ? { threadId: message.threadId } : {}),
    ...(typeof teamId === 'string' ? { metadata: { teamId } } : {}),
    ...(message.imageModel ? { imageModel: message.imageModel } : {}),
    ...(files.length ? { attachments: files.map(fileWithoutBytes) } : {}),
    ...(message.fileReferenceResolutions
      ? { fileReferenceResolutions: message.fileReferenceResolutions }
      : {}),
  }
}

function fileWithoutBytes(attachment: Attachment): ResumeFileAttachment {
  const metadata: Partial<Attachment> = { ...attachment }
  delete metadata.dataBase64
  return metadata as ResumeFileAttachment
}
