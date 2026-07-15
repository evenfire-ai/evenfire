import type { ReaderConfig } from './config.js'
import type {
  ReaderEnrollmentCommand,
  ReaderMessageCommand,
  ReaderTeamsFileConsentCommand,
} from './decisionHandler.js'
import { fetchWithTimeout, timeoutErrorName } from './httpTimeout.js'
import { readerLogger } from './logger.js'

const log = readerLogger.child({ module: 'channel-reader-client' })
const AGENT_HOST_REF_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

export type SlackTargetHandoffContext = {
  targetId: string
  hostRef: string
  communicationChannelRef: string
  providerWorkspaceId: string
  replyInThreads: boolean
  replyOnlyWhenMentioned: boolean
}

export type TeamsTargetHandoffContext = {
  targetId: string
  hostRef: string
  communicationChannelRef: string
  providerWorkspaceId: string
  replyOnlyWhenMentioned: boolean
}

function splitCommunicationChannelRef(
  ref?: string | null
): { namespace: string; name: string } | null {
  const trimmed = ref?.trim()
  if (!trimmed) return null
  const [namespace, name, ...rest] = trimmed.split('/')
  if (rest.length > 0 || !namespace || !name) return null
  return { namespace, name }
}

function channelReaderUrl(cfg: ReaderConfig, hostRef: string): string | null {
  const normalized = hostRef.trim()
  if (!AGENT_HOST_REF_RE.test(normalized)) return null
  return cfg.channelReaderUrlTemplate.replace(/\{host\}/g, normalized).replace(/\/+$/, '')
}

async function postHandoff(
  cfg: ReaderConfig,
  target: SlackTargetHandoffContext | TeamsTargetHandoffContext,
  path: '/internal/slack/handoff' | '/internal/teams/handoff',
  body: Record<string, unknown>
): Promise<{ ok: true } | { ok: false; status?: number; error: string }> {
  if (!cfg.channelReaderHandoffToken) {
    return { ok: false, status: 503, error: 'channel_reader_handoff_not_configured' }
  }
  const baseUrl = channelReaderUrl(cfg, target.hostRef)
  if (!baseUrl) {
    return { ok: false, status: 400, error: 'invalid_channel_reader_host_ref' }
  }

  try {
    const response = await fetchWithTimeout(
      `${baseUrl}${path}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.channelReaderHandoffToken}`,
        },
        body: JSON.stringify(body),
      },
      cfg.channelReaderHandoffTimeoutMs
    )
    if (!response.ok) {
      const responseBody = (await response.json().catch(() => ({}))) as { error?: string }
      return {
        ok: false,
        status: response.status,
        error: responseBody.error ?? `channel_reader_handoff_failed_${response.status}`,
      }
    }
    return { ok: true }
  } catch (err) {
    log.warn('channel-reader handoff failed', {
      error: timeoutErrorName(err),
      hostRef: target.hostRef,
    })
    return { ok: false, status: 504, error: 'channel_reader_unavailable' }
  }
}

export async function handoffSlackMessageToChannelReader(
  cfg: ReaderConfig,
  target: SlackTargetHandoffContext,
  command: ReaderMessageCommand
): Promise<{ ok: true } | { ok: false; status?: number; error: string }> {
  const channelRef = splitCommunicationChannelRef(target.communicationChannelRef)
  if (!channelRef) return { ok: false, status: 400, error: 'invalid_communication_channel_ref' }
  const responseThreadTs = target.replyInThreads
    ? command.threadTs || command.providerMessageTs
    : null
  return postHandoff(cfg, target, '/internal/slack/handoff', {
    kind: 'slack.message',
    content: command.content,
    ...(command.workflowRunId ? { workflowRunId: command.workflowRunId } : {}),
    providerUserId: command.providerUserId,
    providerWorkspaceId: command.providerWorkspaceId,
    providerChannelId: command.providerChannelId,
    providerEventId: command.providerEventId,
    providerMessageTs: command.providerMessageTs,
    responseThreadTs,
    providerTarget: {
      hostRef: target.hostRef,
      communicationChannelNamespace: channelRef.namespace,
      communicationChannelName: channelRef.name,
    },
  })
}

export async function handoffSlackEnrollmentToChannelReader(
  cfg: ReaderConfig,
  target: SlackTargetHandoffContext,
  enrollment: ReaderEnrollmentCommand,
  providerMessageTs?: string | null,
  threadTs?: string | null
): Promise<{ ok: true } | { ok: false; status?: number; error: string }> {
  const channelRef = splitCommunicationChannelRef(target.communicationChannelRef)
  if (!channelRef) return { ok: false, status: 400, error: 'invalid_communication_channel_ref' }
  const responseThreadTs = target.replyInThreads ? threadTs || providerMessageTs || null : null
  return postHandoff(cfg, target, '/internal/slack/handoff', {
    kind: 'slack.enrollment',
    nonce: enrollment.nonce,
    providerUserId: enrollment.providerUserId,
    providerWorkspaceId: enrollment.providerWorkspaceId,
    providerChannelId: enrollment.providerChannelId,
    providerChannelType: enrollment.providerChannelType ?? null,
    providerChannelTitle: enrollment.providerChannelTitle ?? null,
    providerEventId: enrollment.providerEventId ?? null,
    providerMessageTs: providerMessageTs ?? null,
    responseThreadTs,
    providerTarget: {
      hostRef: target.hostRef,
      communicationChannelNamespace: channelRef.namespace,
      communicationChannelName: channelRef.name,
    },
  })
}

export async function handoffTeamsMessageToChannelReader(
  cfg: ReaderConfig,
  target: TeamsTargetHandoffContext,
  command: ReaderMessageCommand & {
    serviceUrl?: string | null
    providerChannelType?: string | null
  }
): Promise<{ ok: true } | { ok: false; status?: number; error: string }> {
  const channelRef = splitCommunicationChannelRef(target.communicationChannelRef)
  if (!channelRef) return { ok: false, status: 400, error: 'invalid_communication_channel_ref' }
  return postHandoff(cfg, target, '/internal/teams/handoff', {
    kind: 'teams.message',
    content: command.content,
    ...(command.workflowRunId ? { workflowRunId: command.workflowRunId } : {}),
    providerUserId: command.providerUserId,
    providerWorkspaceId: command.providerWorkspaceId,
    providerChannelId: command.providerChannelId,
    providerConversationId: command.providerConversationId,
    providerReplyToMessageId: command.providerReplyToMessageId ?? command.providerMessageTs,
    providerChannelType: command.providerChannelType ?? null,
    providerEventId: command.providerEventId,
    providerMessageId: command.providerMessageTs,
    serviceUrl: command.serviceUrl ?? '',
    providerTarget: {
      hostRef: target.hostRef,
      communicationChannelNamespace: channelRef.namespace,
      communicationChannelName: channelRef.name,
    },
  })
}

export async function handoffTeamsFileConsentToChannelReader(
  cfg: ReaderConfig,
  target: TeamsTargetHandoffContext,
  command: ReaderTeamsFileConsentCommand
): Promise<{ ok: true } | { ok: false; status?: number; error: string }> {
  const channelRef = splitCommunicationChannelRef(target.communicationChannelRef)
  if (!channelRef) return { ok: false, status: 400, error: 'invalid_communication_channel_ref' }
  return postHandoff(cfg, target, '/internal/teams/handoff', {
    kind: 'teams.file-consent',
    ...command,
    providerTarget: {
      hostRef: target.hostRef,
      communicationChannelNamespace: channelRef.namespace,
      communicationChannelName: channelRef.name,
    },
  })
}

export async function handoffTeamsEnrollmentToChannelReader(
  cfg: ReaderConfig,
  target: TeamsTargetHandoffContext,
  enrollment: ReaderEnrollmentCommand & {
    serviceUrl?: string | null
    providerChannelType?: string | null
    providerChannelTitle?: string | null
    providerTeamId?: string | null
    providerTeamsChannelId?: string | null
  },
  providerMessageId?: string | null
): Promise<{ ok: true } | { ok: false; status?: number; error: string }> {
  const channelRef = splitCommunicationChannelRef(target.communicationChannelRef)
  if (!channelRef) return { ok: false, status: 400, error: 'invalid_communication_channel_ref' }
  return postHandoff(cfg, target, '/internal/teams/handoff', {
    kind: 'teams.enrollment',
    nonce: enrollment.nonce,
    providerUserId: enrollment.providerUserId,
    providerWorkspaceId: enrollment.providerWorkspaceId,
    providerChannelId: enrollment.providerChannelId,
    providerConversationId: enrollment.providerConversationId,
    providerReplyToMessageId: enrollment.providerReplyToMessageId ?? providerMessageId ?? null,
    providerChannelType: enrollment.providerChannelType ?? null,
    providerChannelTitle: enrollment.providerChannelTitle ?? null,
    providerTeamId: enrollment.providerTeamId ?? null,
    providerTeamsChannelId: enrollment.providerTeamsChannelId ?? null,
    providerEventId: enrollment.providerEventId ?? null,
    providerMessageId: providerMessageId ?? null,
    serviceUrl: enrollment.serviceUrl ?? '',
    providerTarget: {
      hostRef: target.hostRef,
      communicationChannelNamespace: channelRef.namespace,
      communicationChannelName: channelRef.name,
    },
  })
}
