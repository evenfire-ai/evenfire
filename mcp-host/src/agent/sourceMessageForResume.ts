import type { Attachment, ResumeFileAttachment, ResumeSourceMessage } from '../core/types'
import type { IncomingMessage } from '../server'

type ProviderTarget = NonNullable<
  NonNullable<IncomingMessage['providerIdentity']>['providerTarget']
>

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
 *   the frozen snapshot) and inline bytes (dataBase64) never persist.
 * - `providerIdentity` (`medium`, `providerUserId`, `providerWorkspaceId`,
 *   `providerChannelId`, `providerChannelType`, `providerTarget`): a Continue
 *   after a restart re-resolves the linked user through `/resolve` with exactly
 *   these keys. `providerEventId` is not sent there, so it stays out.
 *   `providerTarget` keeps only the providerTarget keys `/resolve` reads
 *   (`hostRef`, `communicationChannelNamespace`, `communicationChannelName`,
 *   `providerBotId`, `providerBotUsername`, `communicationChannelAlias`); the
 *   Telegram channel gate there checks `providerBotUsername`.
 *
 * Everything else the channel delivered (the raw Slack, email or Telegram
 * payload in `metadata`, `traceContext`, the model piggyback, `providerEventId`)
 * is not persisted: an allowlist keeps a field added to the message later out of
 * the durable row until a restart actually needs it.
 */
export function sourceMessageForResume(
  message: IncomingMessage | undefined
): ResumeSourceMessage | undefined {
  if (!message) return undefined
  const files = message.attachments?.filter(attachment => attachment.kind === 'file') ?? []
  const teamId = message.metadata?.teamId
  const identity = message.providerIdentity
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
    ...(identity
      ? {
          providerIdentity: {
            medium: identity.medium,
            providerUserId: identity.providerUserId,
            providerWorkspaceId: identity.providerWorkspaceId,
            providerChannelId: identity.providerChannelId,
            providerChannelType: identity.providerChannelType,
            ...(identity.providerTarget
              ? { providerTarget: providerTargetForResume(identity.providerTarget) }
              : {}),
          },
        }
      : {}),
  }
}

/**
 * Copies the providerTarget keys `/resolve` reads, one by one, and omits any
 * that are absent, so a key added to the channel's target later never reaches
 * the durable row.
 */
function providerTargetForResume(target: ProviderTarget): ProviderTarget {
  return {
    ...(target.hostRef !== undefined ? { hostRef: target.hostRef } : {}),
    ...(target.communicationChannelNamespace !== undefined
      ? { communicationChannelNamespace: target.communicationChannelNamespace }
      : {}),
    ...(target.communicationChannelName !== undefined
      ? { communicationChannelName: target.communicationChannelName }
      : {}),
    ...(target.providerBotId !== undefined ? { providerBotId: target.providerBotId } : {}),
    ...(target.providerBotUsername !== undefined
      ? { providerBotUsername: target.providerBotUsername }
      : {}),
    ...(target.communicationChannelAlias !== undefined
      ? { communicationChannelAlias: target.communicationChannelAlias }
      : {}),
  } as ProviderTarget
}

function fileWithoutBytes(attachment: Attachment): ResumeFileAttachment {
  const metadata: Partial<Attachment> = { ...attachment }
  delete metadata.dataBase64
  return metadata as ResumeFileAttachment
}
