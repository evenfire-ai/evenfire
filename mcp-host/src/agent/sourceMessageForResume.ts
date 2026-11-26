import type { Attachment, ResumeFileAttachment, ResumeSourceMessage } from '../core/types'
import type { IncomingMessage } from '../server'
import { allowlistProviderIdentity, isExternalChannelType } from '../workflow/channelIdentity'

/**
 * #666 R4-M2 / #1640 X11 — what a cold restart needs from the suspended turn's
 * message, and nothing else. Each field is read after a restart:
 *
 * - `sender`, `channelType`, `channelId`, `threadId`: the approval binding, the
 *   workspace root, `session_search`, `cron_manage` ownership and the rpc scope.
 * - `metadata.teamId`: rpc team scope and budget attribution.
 * - `content`: the provider-workflow access gate and the tool registry.
 * - `hostRef`, `messageId`, `timestamp`: Host attribution and the pins' identity.
 * - `imageModel`: the visual model the turn was pinned to.
 * - `authorityV2`: the non-bearer binding needed to revalidate a resumed v2 action.
 * - `linkedUserId`, allowlisted `providerIdentity`, `channelAttachmentIds`:
 *   live identity re-verification on warm/cold approval resume and retained
 *   channel attachment lookup (`X11`).
 * - file attachments (metadata) and `fileReferenceResolutions`: the version pins
 *   and attachment lines. Image attachments are dropped (their content lives in
 *   the frozen snapshot) and inline bytes (dataBase64) never persist.
 * - `locationReferenceResolutions`: the `referenced_folder` line, when a resume
 *   has no saved context and rebuilds the turn-context block.
 *
 * Everything else the channel delivered (the raw Slack, email or Telegram
 * payload in `metadata`, `traceContext`, the model piggyback) is not persisted:
 * an allowlist keeps a field added to the message later out of the durable row
 * until a restart actually needs it.
 */
export function sourceMessageForResume(
  message: IncomingMessage | undefined,
  opts?: { linkedUserId?: string }
): ResumeSourceMessage | undefined {
  if (!message) return undefined
  const files = message.attachments?.filter(attachment => attachment.kind === 'file') ?? []
  const teamId = message.metadata?.teamId
  const isExternalChannel = isExternalChannelType(message.channelType)
  const linkedUserId = isExternalChannel
    ? opts?.linkedUserId?.trim() ||
      message.admittedLinkedUserId?.trim() ||
      (message as ResumeSourceMessage).linkedUserId?.trim() ||
      undefined
    : undefined
  const rawAllowlistedIdentity = isExternalChannel
    ? allowlistProviderIdentity(message.providerIdentity)
    : undefined
  const providerIdentity =
    rawAllowlistedIdentity && rawAllowlistedIdentity.medium === message.channelType
      ? rawAllowlistedIdentity
      : undefined
  const channelAttachmentIds =
    Array.isArray(message.channelAttachmentIds) && message.channelAttachmentIds.length > 0
      ? [...message.channelAttachmentIds]
      : undefined
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
    ...(message.locationReferenceResolutions
      ? { locationReferenceResolutions: message.locationReferenceResolutions }
      : {}),
    ...(message.authorityV2 ? { authorityV2: message.authorityV2 } : {}),
    ...(linkedUserId ? { linkedUserId } : {}),
    ...(providerIdentity ? { providerIdentity } : {}),
    ...(channelAttachmentIds ? { channelAttachmentIds } : {}),
  }
}

function fileWithoutBytes(attachment: Attachment): ResumeFileAttachment {
  const metadata: Partial<Attachment> = { ...attachment }
  delete metadata.dataBase64
  return metadata as ResumeFileAttachment
}
