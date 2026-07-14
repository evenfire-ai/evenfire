import http from 'node:http'
import type { ProviderTargetIdentity } from './types'

const MAX_HANDOFF_BODY_BYTES = 256 * 1024

export type SlackMessageHandoff = {
  kind: 'slack.message'
  content: string
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
  providerEventId?: string | null
  providerMessageTs?: string | null
  responseThreadTs?: string | null
  providerTarget: ProviderTargetIdentity
}

export type SlackHandoffRequest = SlackMessageHandoff | SlackEnrollmentHandoff

export type SlackHandoffResponse = { ok: true } | { ok: false; status: number; error: string }

export type SlackHandoffHandler = {
  handleSlackHandoff(request: SlackHandoffRequest): Promise<SlackHandoffResponse>
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

      if (req.method !== 'POST' || req.url !== '/internal/slack/handoff') {
        writeJson(res, 404, { error: 'not_found' })
        return
      }

      if (!token || bearerToken(req) !== token) {
        writeJson(res, 401, { error: 'unauthorized' })
        return
      }

      const body = await readBody(req)
      const payload = JSON.parse(body.toString('utf8')) as SlackHandoffRequest
      const result = await handler.handleSlackHandoff(payload)
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
