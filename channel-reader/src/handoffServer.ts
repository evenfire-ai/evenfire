import http from 'node:http'
import type { ProviderTargetIdentity } from './types'

const MAX_HANDOFF_BODY_BYTES = 256 * 1024

export type SlackMessageHandoff = {
  kind: 'slack.message'
  content: string
  workflowRunId?: string
  providerUserId: string
  providerWorkspaceId: string
  providerChannelId: string
  providerEventId: string
  providerMessageTs: string
  responseThreadTs?: string | null
  providerTarget: ProviderTargetIdentity
  rawData?: Record<string, unknown>
}

export type SlackEnrollmentHandoff = {
  kind: 'slack.enrollment'
  nonce: string
  providerUserId: string
  providerWorkspaceId: string
  providerChannelId: string
  providerChannelType?: string | null
  providerChannelTitle?: string | null
  providerEventId?: string | null
  providerMessageTs?: string | null
  responseThreadTs?: string | null
  providerTarget: ProviderTargetIdentity
}

export type SlackHandoffRequest = SlackMessageHandoff | SlackEnrollmentHandoff

export type TeamsMessageHandoff = {
  kind: 'teams.message'
  content: string
  workflowRunId?: string
  providerUserId: string
  providerWorkspaceId: string
  providerChannelId: string
  providerConversationId: string
  providerReplyToMessageId?: string | null
  providerChannelType?: string | null
  providerEventId: string
  providerMessageId: string
  serviceUrl: string
  providerTarget: ProviderTargetIdentity
  rawData?: Record<string, unknown>
}

export type TeamsEnrollmentHandoff = {
  kind: 'teams.enrollment'
  nonce: string
  providerUserId: string
  providerWorkspaceId: string
  providerChannelId: string
  providerConversationId: string
  providerReplyToMessageId?: string | null
  providerChannelType?: string | null
  providerChannelTitle?: string | null
  providerTeamId?: string | null
  providerTeamsChannelId?: string | null
  providerEventId?: string | null
  providerMessageId?: string | null
  serviceUrl: string
  providerTarget: ProviderTargetIdentity
}

export type TeamsFileConsentHandoff = {
  kind: 'teams.file-consent'
  action: 'accept' | 'decline'
  workflowRunId: string
  artifactName: string
  providerUserId: string
  providerWorkspaceId: string
  providerChannelId: string
  providerConversationId: string
  providerReplyToMessageId: string
  providerChannelType?: string | null
  providerEventId: string
  providerMessageId: string
  serviceUrl: string
  uploadInfo?: {
    contentUrl: string
    uploadUrl: string
    uniqueId: string
    name?: string
    fileType?: string
  }
  providerTarget: ProviderTargetIdentity
}

export type TeamsHandoffRequest =
  | TeamsMessageHandoff
  | TeamsEnrollmentHandoff
  | TeamsFileConsentHandoff
export type ProviderHandoffRequest = SlackHandoffRequest | TeamsHandoffRequest

export type SlackHandoffResponse = { ok: true } | { ok: false; status: number; error: string }
export type ProviderHandoffResponse = SlackHandoffResponse

export type SlackHandoffHandler = {
  handleSlackHandoff(request: SlackHandoffRequest): Promise<SlackHandoffResponse>
  handleTeamsHandoff?(request: TeamsHandoffRequest): Promise<ProviderHandoffResponse>
}

class HandoffBodyError extends Error {
  constructor(
    readonly status: number,
    readonly publicError: string
  ) {
    super(publicError)
    this.name = 'HandoffBodyError'
  }
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let totalBytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += buffer.byteLength
    if (totalBytes > MAX_HANDOFF_BODY_BYTES) {
      throw new HandoffBodyError(413, 'payload_too_large')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function bearerToken(req: http.IncomingMessage): string {
  const value = String(req.headers.authorization || '').trim()
  const match = value.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || ''
}

export function createChannelReaderHandoffServer(
  handler: SlackHandoffHandler,
  token: string
): http.Server {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        writeJson(res, 200, { ok: true })
        return
      }

      const isSlackHandoff = req.url === '/internal/slack/handoff'
      const isTeamsHandoff = req.url === '/internal/teams/handoff'
      if (req.method !== 'POST' || (!isSlackHandoff && !isTeamsHandoff)) {
        writeJson(res, 404, { error: 'not_found' })
        return
      }

      if (!token || bearerToken(req) !== token) {
        writeJson(res, 401, { error: 'unauthorized' })
        return
      }

      const body = await readBody(req)
      const payload = JSON.parse(body.toString('utf8')) as ProviderHandoffRequest
      const result = isTeamsHandoff
        ? handler.handleTeamsHandoff
          ? await handler.handleTeamsHandoff(payload as TeamsHandoffRequest)
          : { ok: false as const, status: 501, error: 'teams_handoff_not_configured' }
        : await handler.handleSlackHandoff(payload as SlackHandoffRequest)
      if (!result.ok) {
        writeJson(res, result.status, { ok: false, error: result.error })
        return
      }
      writeJson(res, 200, { ok: true })
    } catch (err) {
      if (err instanceof HandoffBodyError) {
        writeJson(res, err.status, { error: err.publicError })
        return
      }
      if (err instanceof SyntaxError) {
        writeJson(res, 400, { error: 'invalid_json' })
        return
      }
      console.error('[Handoff] Unhandled error:', err instanceof Error ? err.message : err)
      writeJson(res, 500, { error: 'internal_error' })
    }
  })
}
