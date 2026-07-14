import { Router } from 'express'
import { config } from '../config.js'
import {
  type AuthedRequest,
  extractAuthToken,
  requireRpcAuth,
  requireScope,
} from '../middleware/auth.js'
import { rpcInvocationContext } from '../rpcAccessContext.js'
import {
  type HostRuntimeMessageRequest,
  forwardCancelToHost,
  forwardHostActivity,
  forwardHostHealth,
  forwardHostMessageToHost,
  forwardHostStatus,
  forwardRpcToServer,
  forwardTaskResultFromHost,
  listAllowedServersForUser,
  resolveHostConnectionForUser,
  resolveServerConnectionForUser,
  validateRpcRequest,
} from '../services/mcpProxyService.js'

const RFC1123_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

class ProxyArtifactTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Artifact too large to download: max ${maxBytes} bytes`)
    this.name = 'ProxyArtifactTooLargeError'
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    /* best effort only */
  }
}

async function readArtifactResponseBuffer(response: Response): Promise<Buffer> {
  const maxBytes = config.artifactDownloadMaxBytes
  const contentLength = response.headers.get('content-length')
  if (contentLength) {
    const declaredBytes = Number(contentLength)
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      await cancelResponseBody(response)
      throw new ProxyArtifactTooLargeError(maxBytes)
    }
  }

  if (!response.body) {
    const arrayBuffer = await response.arrayBuffer()
    if (arrayBuffer.byteLength > maxBytes) throw new ProxyArtifactTooLargeError(maxBytes)
    return Buffer.from(arrayBuffer)
  }

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let totalBytes = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    totalBytes += value.byteLength
    if (totalBytes > maxBytes) {
      await reader.cancel()
      throw new ProxyArtifactTooLargeError(maxBytes)
    }
    chunks.push(Buffer.from(value))
  }

  return Buffer.concat(chunks, totalBytes)
}

export function createRpcRouter(): Router {
  const router = Router()

  router.get(
    '/rpc/servers',
    requireRpcAuth,
    requireScope('mcp:servers:list'),
    async (req: AuthedRequest, res, next) => {
      try {
        const auth = req.auth!
        const rpcAccessToken = extractAuthToken(req)
        const result = await listAllowedServersForUser(auth.sub, rpcAccessToken)
        res.status(200).json({
          userId: result.userId,
          contextIds: result.contextIds,
          servers: result.servers,
        })
      } catch (error) {
        next(error)
      }
    }
  )

  router.post(
    '/rpc/:serverName',
    requireRpcAuth,
    requireScope('mcp:server:invoke'),
    async (req: AuthedRequest, res, next) => {
      try {
        const auth = req.auth!
        const rpcAccessToken = extractAuthToken(req)
        const serverName = String(req.params.serverName || '').trim()
        if (!serverName) {
          res.status(400).json({ error: 'serverName is required' })
          return
        }

        const server = await resolveServerConnectionForUser(auth.sub, serverName, rpcAccessToken)
        if (!server) {
          res.status(403).json({ error: 'Forbidden: user cannot access this server' })
          return
        }

        const rpcRequest = validateRpcRequest(req.body)
        if (!rpcRequest) {
          res.status(400).json({ error: 'Invalid JSON-RPC request payload' })
          return
        }

        // Avoid logging params to prevent accidental sensitive data exposure.
        console.info(
          `[RPC_PROXY] user=${auth.sub} server=${serverName} method=${rpcRequest.method}`
        )

        const rpcResponse = await forwardRpcToServer(server, rpcRequest, auth.sub)
        res.status(200).json(rpcResponse)
      } catch (error) {
        next(error)
      }
    }
  )

  router.post(
    '/rpc/hosts/:hostRef/messages',
    requireRpcAuth,
    requireScope('host:message:invoke'),
    async (req: AuthedRequest, res, next) => {
      // Host runtime write path (REST-oriented):
      // - separate from read-only status stream
      // - explicitly scoped to host:message:invoke
      try {
        const auth = req.auth!
        const rpcAccessToken = extractAuthToken(req)
        const hostRef = String(req.params.hostRef || '').trim()
        if (!hostRef) {
          res.status(400).json({ error: 'hostRef is required' })
          return
        }

        const host = await resolveHostConnectionForUser(auth.sub, hostRef, rpcAccessToken, {
          teamId: auth.teamId,
        })
        if (!host) {
          res.status(403).json({ error: 'Forbidden: user cannot access this host' })
          return
        }

        const body = req.body as HostRuntimeMessageRequest
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          res.status(400).json({ error: 'Invalid host message request payload' })
          return
        }
        if (typeof body.content !== 'string' || !body.content.trim()) {
          res.status(400).json({ error: 'Invalid host message request payload' })
          return
        }

        // Identity invariant: rpc-proxy is the sole authority on the Desktop
        // RPC envelope. Ignore client-supplied channel, sender, host, and
        // metadata values; derive them from the route and signed JWT.
        const forwardedBody: HostRuntimeMessageRequest = {
          content: body.content,
          channelType: 'rpc',
          channelId: hostRef,
          hostRef,
          sender: auth.sub,
          metadata: rpcInvocationContext(auth),
          threadId: typeof body.threadId === 'string' ? body.threadId : undefined,
          attachments: Array.isArray(body.attachments) ? body.attachments : undefined,
        }

        const isAsync = req.query.async === 'true'
        const attachmentCount = Array.isArray(forwardedBody.attachments)
          ? (forwardedBody.attachments as unknown[]).length
          : 0
        console.info(
          `[RPC_PROXY] user=${auth.sub} host=${hostRef} method=host-message-rest${isAsync ? ' (async)' : ''} attachments=${attachmentCount}`
        )
        const response = await forwardHostMessageToHost(host, forwardedBody, { async: isAsync })
        res.status(200).json(response)
      } catch (error) {
        console.warn(
          `[RPC_PROXY] host message forward failed host=${String(req.params.hostRef || '').trim()} error=${
            error instanceof Error ? error.message : String(error)
          }`
        )
        if (error instanceof Error && error.name === 'AbortError') {
          res.status(504).json({ error: 'Gateway Timeout' })
          return
        }
        res.status(502).json({ error: 'Upstream host unavailable' })
      }
    }
  )

  // Approve tool execution
  router.post(
    '/rpc/hosts/:hostRef/approvals/approve',
    requireRpcAuth,
    requireScope('host:approval:write'),
    async (req: AuthedRequest, res, next) => {
      try {
        const auth = req.auth!
        const rpcAccessToken = extractAuthToken(req)
        const hostRef = String(req.params.hostRef || '').trim()
        if (!hostRef) {
          res.status(400).json({ error: 'hostRef is required' })
          return
        }
        const host = await resolveHostConnectionForUser(auth.sub, hostRef, rpcAccessToken, {
          teamId: auth.teamId,
        })
        if (!host) {
          res.status(403).json({ error: 'Forbidden: user cannot access this host' })
          return
        }
        const baseUrl = host.url.replace(/\/+$/, '')
        // Translate Desktop App fields → mcp-host approval API fields.
        // Identity is always the JWT auth.sub (server-assigned, matches the
        // sender that was stamped onto the original message).
        const parsed = req.body as Record<string, unknown>
        const upstreamBody = {
          userId: auth.sub,
          requestId: parsed.toolCallId || parsed.requestId,
          alwaysApprove: parsed.alwaysApprove || false,
        }
        const response = await fetch(`${baseUrl}/v1/runtime/approvals/approve`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...host.headers },
          body: JSON.stringify(upstreamBody),
        })
        const body = await response.text()
        res.status(response.status).send(body)
      } catch (error) {
        next(error)
      }
    }
  )

  // Deny tool execution
  router.post(
    '/rpc/hosts/:hostRef/approvals/deny',
    requireRpcAuth,
    requireScope('host:approval:write'),
    async (req: AuthedRequest, res, next) => {
      try {
        const auth = req.auth!
        const rpcAccessToken = extractAuthToken(req)
        const hostRef = String(req.params.hostRef || '').trim()
        if (!hostRef) {
          res.status(400).json({ error: 'hostRef is required' })
          return
        }
        const host = await resolveHostConnectionForUser(auth.sub, hostRef, rpcAccessToken, {
          teamId: auth.teamId,
        })
        if (!host) {
          res.status(403).json({ error: 'Forbidden: user cannot access this host' })
          return
        }
        const baseUrl = host.url.replace(/\/+$/, '')
        // Translate Desktop App fields → mcp-host denial API fields.
        // Identity is always the JWT auth.sub (server-assigned, matches the
        // sender that was stamped onto the original message).
        const parsed = req.body as Record<string, unknown>
        const upstreamBody = {
          userId: auth.sub,
          requestId: parsed.toolCallId || parsed.requestId,
        }
        const response = await fetch(`${baseUrl}/v1/runtime/approvals/deny`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...host.headers },
          body: JSON.stringify(upstreamBody),
        })
        const body = await response.text()
        res.status(response.status).send(body)
      } catch (error) {
        next(error)
      }
    }
  )

  // List sessions for the authenticated user — passthrough to mcp-host /v1/runtime/sessions.
  router.get(
    '/rpc/hosts/:hostRef/sessions',
    requireRpcAuth,
    requireScope('host:session:read'),
    async (req: AuthedRequest, res, next) => {
      try {
        const auth = req.auth!
        const rpcAccessToken = extractAuthToken(req)
        const hostRef = String(req.params.hostRef || '').trim()
        if (!hostRef) {
          res.status(400).json({ error: 'hostRef is required' })
          return
        }
        const host = await resolveHostConnectionForUser(auth.sub, hostRef, rpcAccessToken, {
          teamId: auth.teamId,
        })
        if (!host) {
          res.status(403).json({ error: 'Forbidden: user cannot access this host' })
          return
        }
        const baseUrl = host.url.replace(/\/+$/, '')
        console.info(`[RPC_PROXY] user=${auth.sub} host=${hostRef} method=list-sessions`)
        const response = await fetch(`${baseUrl}/v1/runtime/sessions`, {
          method: 'GET',
          headers: { ...host.headers },
        })
        const body = await response.text()
        res
          .status(response.status)
          .type(response.headers.get('content-type') || 'application/json')
          .send(body)
      } catch (error) {
        next(error)
      }
    }
  )

  // Fetch one session's transcript — passthrough to mcp-host.
  router.get(
    '/rpc/hosts/:hostRef/sessions/:agent/:chatId/messages',
    requireRpcAuth,
    requireScope('host:session:read'),
    async (req: AuthedRequest, res, next) => {
      try {
        const auth = req.auth!
        const rpcAccessToken = extractAuthToken(req)
        const hostRef = String(req.params.hostRef || '').trim()
        const agent = String(req.params.agent || '').trim()
        const chatId = String(req.params.chatId || '').trim()
        if (!hostRef || !agent || !chatId) {
          res.status(400).json({ error: 'hostRef, agent, and chatId are required' })
          return
        }
        const host = await resolveHostConnectionForUser(auth.sub, hostRef, rpcAccessToken, {
          teamId: auth.teamId,
        })
        if (!host) {
          res.status(403).json({ error: 'Forbidden: user cannot access this host' })
          return
        }
        const baseUrl = host.url.replace(/\/+$/, '')
        console.info(
          `[RPC_PROXY] user=${auth.sub} host=${hostRef} method=get-session-messages agent=${agent} chatId=${chatId}`
        )
        const response = await fetch(
          `${baseUrl}/v1/runtime/sessions/${encodeURIComponent(agent)}/${encodeURIComponent(chatId)}/messages`,
          { method: 'GET', headers: { ...host.headers } }
        )
        const body = await response.text()
        res
          .status(response.status)
          .type(response.headers.get('content-type') || 'application/json')
          .send(body)
      } catch (error) {
        next(error)
      }
    }
  )

  // Fetch one session's context-window breakdown — passthrough to mcp-host.
  // Mirrors the .../messages route exactly: same host:session:read scope and
  // per-user host resolution. mcp-host owns the per-user authorization (userSub
  // from the verified edge caller) and the anti-enumeration 404.
  router.get(
    '/rpc/hosts/:hostRef/sessions/:agent/:chatId/context-breakdown',
    requireRpcAuth,
    requireScope('host:session:read'),
    async (req: AuthedRequest, res, next) => {
      try {
        const auth = req.auth!
        const rpcAccessToken = extractAuthToken(req)
        const hostRef = String(req.params.hostRef || '').trim()
        const agent = String(req.params.agent || '').trim()
        const chatId = String(req.params.chatId || '').trim()
        if (!hostRef || !agent || !chatId) {
          res.status(400).json({ error: 'hostRef, agent, and chatId are required' })
          return
        }
        const host = await resolveHostConnectionForUser(auth.sub, hostRef, rpcAccessToken, {
          teamId: auth.teamId,
        })
        if (!host) {
          res.status(403).json({ error: 'Forbidden: user cannot access this host' })
          return
        }
        const baseUrl = host.url.replace(/\/+$/, '')
        console.info(
          `[RPC_PROXY] user=${auth.sub} host=${hostRef} method=get-context-breakdown agent=${agent} chatId=${chatId}`
        )
        const response = await fetch(
          `${baseUrl}/v1/runtime/sessions/${encodeURIComponent(agent)}/${encodeURIComponent(chatId)}/context-breakdown`,
          { method: 'GET', headers: { ...host.headers } }
        )
        const body = await response.text()
        res
          .status(response.status)
          .type(response.headers.get('content-type') || 'application/json')
          .send(body)
      } catch (error) {
        next(error)
      }
    }
  )

  router.get(
    '/rpc/hosts/:hostRef/tasks/:taskId/result',
    requireRpcAuth,
    requireScope('host:message:invoke'),
    async (req: AuthedRequest, res, next) => {
      try {
        const auth = req.auth!
        const rpcAccessToken = extractAuthToken(req)
        const hostRef = String(req.params.hostRef || '').trim()
        const taskId = String(req.params.taskId || '').trim()
        if (!hostRef) {
          res.status(400).json({ error: 'hostRef is required' })
          return
        }
        if (!taskId || !/^[a-zA-Z0-9_-]+$/.test(taskId)) {
          res.status(400).json({ error: 'Invalid taskId' })
          return
        }

        const host = await resolveHostConnectionForUser(auth.sub, hostRef, rpcAccessToken, {
          teamId: auth.teamId,
        })
        if (!host) {
          res.status(404).json({ error: 'Host not found or not accessible' })
          return
        }

        console.info(
          `[RPC_PROXY] user=${auth.sub} host=${hostRef} method=get-task-result taskId=${taskId}`
        )
        const result = await forwardTaskResultFromHost(host, taskId)
        if (!result) {
          res.status(404).json({ error: 'Task result not found' })
          return
        }
        res.status(200).json(result)
      } catch (error) {
        console.warn(
          `[RPC_PROXY] task result forward failed error=${error instanceof Error ? error.message : String(error)}`
        )
        if (error instanceof Error && error.name === 'AbortError') {
          res.status(504).json({ error: 'Gateway Timeout' })
          return
        }
        res.status(502).json({ error: 'Upstream host unavailable' })
      }
    }
  )

  router.post(
    '/rpc/hosts/:hostRef/tasks/:taskId/cancel',
    requireRpcAuth,
    requireScope('host:message:invoke'),
    async (req: AuthedRequest, res, next) => {
      try {
        const auth = req.auth!
        const rpcAccessToken = extractAuthToken(req)
        const hostRef = String(req.params.hostRef || '').trim()
        const taskId = String(req.params.taskId || '').trim()
        if (!hostRef) {
          res.status(400).json({ error: 'hostRef is required' })
          return
        }
        if (!taskId || !/^[a-zA-Z0-9_-]+$/.test(taskId)) {
          res.status(400).json({ error: 'Invalid taskId' })
          return
        }

        const host = await resolveHostConnectionForUser(auth.sub, hostRef, rpcAccessToken, {
          teamId: auth.teamId,
        })
        if (!host) {
          res.status(404).json({ error: 'Host not found or not accessible' })
          return
        }

        console.info(
          `[RPC_PROXY] user=${auth.sub} host=${hostRef} method=cancel-task taskId=${taskId}`
        )

        const result = await forwardCancelToHost(host, taskId, auth.sub)
        if (result.body) {
          res
            .status(result.status)
            .type(result.contentType || 'application/json')
            .send(result.body)
        } else {
          res.status(result.status).end()
        }
      } catch (error) {
        console.warn(
          `[RPC_PROXY] cancel forward failed error=${error instanceof Error ? error.message : String(error)}`
        )
        if (error instanceof Error && error.name === 'AbortError') {
          res.status(504).json({ error: 'Gateway Timeout' })
          return
        }
        res.status(502).json({ error: 'Upstream host unavailable' })
      }
    }
  )

  // List artifacts generated by internal tools
  router.get(
    '/rpc/hosts/:hostRef/artifacts',
    requireRpcAuth,
    requireScope('host:task:read'),
    async (req: AuthedRequest, res, next) => {
      try {
        const auth = req.auth!
        const rpcAccessToken = extractAuthToken(req)
        const hostRef = String(req.params.hostRef || '').trim()
        if (!hostRef) {
          res.status(400).json({ error: 'hostRef is required' })
          return
        }
        if (!RFC1123_RE.test(hostRef)) {
          res.status(400).json({ error: 'Invalid host reference' })
          return
        }
        const host = await resolveHostConnectionForUser(auth.sub, hostRef, rpcAccessToken, {
          teamId: auth.teamId,
        })
        if (!host) {
          res.status(403).json({ error: 'Forbidden: user cannot access this host' })
          return
        }
        const baseUrl = host.url.replace(/\/+$/, '')
        const response = await fetch(`${baseUrl}/v1/runtime/artifacts`, {
          headers: { ...host.headers },
        })
        const body = await response.text()
        res.status(response.status).send(body)
      } catch (error) {
        next(error)
      }
    }
  )

  // Download a specific artifact
  router.get(
    '/rpc/hosts/:hostRef/artifacts/:filename/download',
    requireRpcAuth,
    requireScope('host:task:read'),
    async (req: AuthedRequest, res, next) => {
      try {
        const auth = req.auth!
        const rpcAccessToken = extractAuthToken(req)
        const hostRef = String(req.params.hostRef || '').trim()
        const filename = String(req.params.filename || '').trim()
        if (!hostRef) {
          res.status(400).json({ error: 'hostRef is required' })
          return
        }
        if (!RFC1123_RE.test(hostRef)) {
          res.status(400).json({ error: 'Invalid host reference' })
          return
        }
        if (
          !filename ||
          filename.includes('..') ||
          filename.includes('/') ||
          filename.includes('\\') ||
          filename.includes('\0')
        ) {
          res.status(400).json({ error: 'Invalid filename' })
          return
        }
        const host = await resolveHostConnectionForUser(auth.sub, hostRef, rpcAccessToken, {
          teamId: auth.teamId,
        })
        if (!host) {
          res.status(403).json({ error: 'Forbidden: user cannot access this host' })
          return
        }
        const baseUrl = host.url.replace(/\/+$/, '')
        const response = await fetch(
          `${baseUrl}/v1/runtime/artifacts/${encodeURIComponent(filename)}/download`,
          {
            headers: { ...host.headers },
          }
        )
        if (!response.ok) {
          const errBody = await response.text()
          res.status(response.status).send(errBody)
          return
        }
        const contentType = response.headers.get('content-type') || 'application/octet-stream'
        const safeFilename = filename.replace(/[^a-zA-Z0-9_.-]/g, '_')
        const redaction = response.headers.get('x-clerum-redaction')
        let buffer: Buffer
        try {
          buffer = await readArtifactResponseBuffer(response)
        } catch (error) {
          if (error instanceof ProxyArtifactTooLargeError) {
            res.status(413).json({ error: 'Artifact too large to download' })
            return
          }
          throw error
        }
        res.setHeader('Content-Type', contentType)
        res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`)
        if (redaction) res.setHeader('X-Clerum-Redaction', redaction)
        res.send(buffer)
      } catch (error) {
        next(error)
      }
    }
  )

  router.get(
    '/rpc/hosts/:hostRef/activity',
    requireRpcAuth,
    requireScope('host:activity:read'),
    async (req: AuthedRequest, res, next) => {
      // Host runtime read-only activity timeline snapshot.
      try {
        const auth = req.auth!
        const rpcAccessToken = extractAuthToken(req)
        const hostRef = String(req.params.hostRef || '').trim()
        if (!hostRef) {
          res.status(400).json({ error: 'hostRef is required' })
          return
        }
        const host = await resolveHostConnectionForUser(auth.sub, hostRef, rpcAccessToken, {
          teamId: auth.teamId,
        })
        if (!host) {
          res.status(403).json({ error: 'Forbidden: user cannot access this host' })
          return
        }
        const limit = Number(req.query.limit || 50)
        const sinceEventId =
          typeof req.query.sinceEventId === 'string' ? req.query.sinceEventId : undefined
        const activity = await forwardHostActivity(host, limit, sinceEventId)
        res.status(200).json(activity)
      } catch (error) {
        console.warn(
          `[RPC_PROXY] host activity failed host=${String(req.params.hostRef || '').trim()} error=${
            error instanceof Error ? error.message : String(error)
          }`
        )
        next(error)
      }
    }
  )

  router.get(
    '/rpc/hosts/:hostRef/status',
    requireRpcAuth,
    requireScope('host:status:read'),
    async (req: AuthedRequest, res, next) => {
      // Host runtime read snapshot (REST-oriented) scoped to host:status:read.
      try {
        const auth = req.auth!
        const rpcAccessToken = extractAuthToken(req)
        const hostRef = String(req.params.hostRef || '').trim()
        if (!hostRef) {
          res.status(400).json({ error: 'hostRef is required' })
          return
        }

        const host = await resolveHostConnectionForUser(auth.sub, hostRef, rpcAccessToken, {
          teamId: auth.teamId,
        })
        if (!host) {
          res.status(403).json({ error: 'Forbidden: user cannot access this host' })
          return
        }

        const status = await forwardHostStatus(host)
        if (!status) {
          console.warn(`[RPC_PROXY] host status malformed host=${hostRef} user=${auth.sub}`)
          res.status(502).json({ error: 'Invalid upstream host status response' })
          return
        }
        res.status(200).json(status)
      } catch (error) {
        console.warn(
          `[RPC_PROXY] host status failed host=${String(req.params.hostRef || '').trim()} error=${
            error instanceof Error ? error.message : String(error)
          }`
        )
        next(error)
      }
    }
  )

  router.get(
    '/rpc/hosts/:hostRef/health',
    requireRpcAuth,
    requireScope('host:health:read'),
    async (req: AuthedRequest, res, next) => {
      // Host runtime health/liveness read path (REST-oriented) scoped to host:health:read.
      try {
        const auth = req.auth!
        const rpcAccessToken = extractAuthToken(req)
        const hostRef = String(req.params.hostRef || '').trim()
        if (!hostRef) {
          res.status(400).json({ error: 'hostRef is required' })
          return
        }

        const host = await resolveHostConnectionForUser(auth.sub, hostRef, rpcAccessToken, {
          teamId: auth.teamId,
        })
        if (!host) {
          res.status(403).json({ error: 'Forbidden: user cannot access this host' })
          return
        }

        const health = await forwardHostHealth(host)
        res.status(200).json(health)
      } catch (error) {
        console.warn(
          `[RPC_PROXY] host health failed host=${String(req.params.hostRef || '').trim()} error=${
            error instanceof Error ? error.message : String(error)
          }`
        )
        next(error)
      }
    }
  )

  return router
}
