import { Router } from 'express'
import type { Response as ExpressResponse, NextFunction } from 'express'
import { randomUUID } from 'crypto'
import { config } from '../config.js'
import {
  type AuthedRequest,
  extractAuthToken,
  requireRpcAuth,
  requireScope,
} from '../middleware/auth.js'
import { rpcInvocationContext } from '../rpcAccessContext.js'
import {
  type HostWakeApiResponse,
  requestHostWakeFromControlApi,
} from '../services/controlApiRestService.js'
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
import {
  isUpstreamTimeoutError,
  isWakeEligibleHostError,
  respondWithWakeAndHold,
} from '../services/wakeAndHold.js'
import { mintOrReuseDirectTraceContext } from '../traceContext.js'

const RFC1123_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

function isSafeUpstreamPathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    value.length <= 500 &&
    !/[/\\\u0000-\u001f\u007f]/.test(value)
  )
}

function isSafeUpstreamAgentSegment(value: string): boolean {
  return isSafeUpstreamPathSegment(value) && value.length <= 200 && !value.includes(':')
}

function parseUnsignedIntegerQuery(value: unknown): number | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

/**
 * Pre-wake host error mapping: fetch timeout → 504, everything else → 502.
 *
 * Guards `res.headersSent` (§11.5): this is the terminal responder that
 * route-level outer catches invoke after a held request may already have
 * committed a response. A second write here is the ERR_HTTP_HEADERS_SENT /
 * duplicate-terminal-response bug, so it becomes a loud no-op instead.
 */
export function respondUpstreamUnavailable(res: ExpressResponse, error: unknown): void {
  if (res.headersSent) {
    console.warn(
      `[RPC_PROXY] suppressing duplicate terminal response (upstream-unavailable): ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return
  }
  if (isUpstreamTimeoutError(error)) {
    res.status(504).json({ error: 'Gateway Timeout' })
    return
  }
  res.status(502).json({ error: 'Upstream host unavailable' })
}

/**
 * Guards a `next(error)` handoff against a committed response (§11.5). Express
 * routes an error to the default handler which, when headers are already sent,
 * aborts the socket; suppress it loudly instead so a held request that already
 * wrote its terminal response is never double-terminated.
 */
function guardedNext(res: ExpressResponse, next: NextFunction, error: unknown): void {
  if (res.headersSent) {
    console.warn(
      `[RPC_PROXY] suppressing post-response route error: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return
  }
  next(error)
}

/**
 * A 503 carrying mcp-host's `host_draining` fence is a wake-eligible upstream
 * error, not a client-visible failure: convert it so the finite routes below
 * can hand it to respondWithWakeAndHold.
 */
function sessionDrainingFence(response: Response, body: string): Error | null {
  if (response.status !== 503 || !body.includes('host_draining')) return null
  return Object.assign(new Error('Upstream host returned draining fence'), {
    name: 'UpstreamHostError',
    status: response.status,
    bodySnippet: body,
  })
}

function controlApiHostAccessRejectionStatus(error: unknown): 401 | 403 | 409 | null {
  if (!(error instanceof Error) || error.name !== 'ControlApiHostAccessRejectedError') {
    return null
  }
  const status = (error as Error & { status?: unknown }).status
  return status === 401 || status === 403 || status === 409 ? status : null
}

export function respondControlApiHostAccessRejection(
  res: ExpressResponse,
  status: 401 | 403 | 409
): void {
  if (res.headersSent) {
    console.warn(
      `[RPC_PROXY] suppressing duplicate terminal response (host-access-rejection ${status})`
    )
    return
  }
  if (status === 401) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  if (status === 403) {
    res.status(403).json({ error: 'Forbidden: user cannot access this host' })
    return
  }
  res.status(409).json({ error: 'Direct run attribution conflict' })
}

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
    async (req: AuthedRequest, res) => {
      // Host runtime write path (REST-oriented):
      // - separate from read-only status stream
      // - explicitly scoped to host:message:invoke
      try {
        const auth = req.auth!
        const rpcAccessToken = extractAuthToken(req)
        const hostRef = String(req.params.hostRef || '').trim()
        if (!isSafeUpstreamPathSegment(hostRef)) {
          res.status(400).json({ error: 'Invalid hostRef' })
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
        //
        // Per-request idempotency identity (D1): the delivery id must be UNIQUE
        // per inbound HTTP request, NOT a function of content. A content-hash
        // key would suppress legitimate duplicate turns — a user sending
        // identical content twice in one thread ("yes", "ok", "retry") within
        // mcp-host's dedup TTL would have the FIRST answer replayed and the 2nd
        // turn silently dropped.
        //
        // Prefer a client-supplied Idempotency-Key header when present (lets the
        // Desktop App scope its own retries); otherwise mint a fresh random
        // nonce. It is computed exactly ONCE here — before the first forward —
        // and carried on the single forwardedBody object reused by BOTH the
        // initial forward and the wake-and-hold retry (attemptUpstream reuses
        // the same object and never recomputes the id). So a socket-death retry
        // of ONE request re-presents the SAME messageId — mcp-host's admission
        // sink (MessageQueue.deliveryKeyOf) dedups it (duplicate_delivery →
        // replay) instead of re-executing the turn — while two DISTINCT sends
        // (even byte-identical content) get distinct ids and both execute.
        const clientIdempotencyKey =
          typeof req.headers['idempotency-key'] === 'string'
            ? req.headers['idempotency-key'].trim()
            : ''
        const deliveryMessageId = clientIdempotencyKey || randomUUID()
        const requestId =
          typeof req.headers['x-request-id'] === 'string'
            ? req.headers['x-request-id'].trim()
            : undefined
        const desktopSessionId =
          typeof body.threadId === 'string' ? body.threadId.trim() || undefined : undefined
        const traceContext = mintOrReuseDirectTraceContext({
          authorityScope: `${auth.sub}:${hostRef}`,
          deliveryId: deliveryMessageId,
          sessionId: desktopSessionId,
          requestId,
          origin: 'direct_chat',
        })
        const forwardedBody: HostRuntimeMessageRequest = {
          content: body.content,
          channelType: 'rpc',
          channelId: hostRef,
          hostRef,
          sender: auth.sub,
          messageId: deliveryMessageId,
          metadata: rpcInvocationContext(auth),
          threadId: desktopSessionId,
          attachments: Array.isArray(body.attachments) ? body.attachments : undefined,
          traceContext,
          // R2 "Option A": thread the optional piggybacked per-session model.
          // This body is an explicit field allow-list, so an unlisted field is
          // dropped. Trimmed/empty values are omitted.
          ...(typeof body.model === 'string' && body.model.trim()
            ? { model: body.model.trim() }
            : {}),
        }

        const host = await resolveHostConnectionForUser(auth.sub, hostRef, rpcAccessToken, {
          teamId: auth.teamId,
          ...(traceContext.sessionId
            ? {
                directRunBinding: {
                  runId: traceContext.runId,
                  sessionId: traceContext.sessionId,
                  origin: traceContext.origin,
                },
              }
            : {}),
        })
        if (!host) {
          res.status(403).json({ error: 'Forbidden: user cannot access this host' })
          return
        }
        if (host.attributionBindingStatus === 'unavailable') {
          console.warn(
            JSON.stringify({
              event: 'governed_trace_operational_error',
              scope: 'agent_run',
              reason: 'attribution_binding_unavailable',
            })
          )
        }

        const isAsync = req.query.async === 'true'
        const attachmentCount = Array.isArray(forwardedBody.attachments)
          ? (forwardedBody.attachments as unknown[]).length
          : 0
        console.info(
          `[RPC_PROXY] user=${auth.sub} host=${hostRef} method=host-message-rest${isAsync ? ' (async)' : ''} attachments=${attachmentCount}`
        )
        let upstreamResponse: Record<string, unknown> | null = null
        try {
          upstreamResponse = await forwardHostMessageToHost(host, forwardedBody, {
            async: isAsync,
          })
        } catch (error) {
          console.warn(
            `[RPC_PROXY] host message forward failed host=${hostRef} error=${
              error instanceof Error ? error.message : String(error)
            }`
          )
          if (isWakeEligibleHostError(error)) {
            // Stateless wake-and-hold: a down or draining host triggers a
            // control-api wake (and possibly a bounded hold) instead of the
            // generic 502. Non-stateless hosts fall back to the legacy path.
            await respondWithWakeAndHold({
              res,
              hostRef,
              host,
              claims: auth,
              rpcAccessToken,
              attemptUpstream: async () => {
                const retried = await forwardHostMessageToHost(host, forwardedBody, {
                  async: isAsync,
                })
                res.status(200).json(retried)
              },
              respondLegacy: legacyError => respondUpstreamUnavailable(res, legacyError),
            })
            return
          }
          respondUpstreamUnavailable(res, error)
          return
        }
        // The upstream accepted the message: the request is resolved. Writing
        // the success response OUTSIDE the catch above guarantees a failure in
        // the write itself can never be classified as "host down" and re-enter
        // the wake path (which would re-forward an already-delivered message).
        res.status(200).json(upstreamResponse)
      } catch (error) {
        const rejectedStatus = controlApiHostAccessRejectionStatus(error)
        if (rejectedStatus) {
          respondControlApiHostAccessRejection(res, rejectedStatus)
          return
        }
        console.warn(
          `[RPC_PROXY] host message forward failed host=${String(req.params.hostRef || '').trim()} error=${
            error instanceof Error ? error.message : String(error)
          }`
        )
        respondUpstreamUnavailable(res, error)
      }
    }
  )

  // Pre-warm a suspended stateless host. The Desktop App calls this when the
  // user opens the agent view so the cold wake overlaps with the user reading
  // history/typing. Fire-and-forget: control-api owns dedup/coalescing/
  // rate-limiting and the monotonic wake generation — this route only passes
  // its answer through. NO hold and NO readiness polling here (that is the
  // held-request path in wakeAndHold.ts).
  router.post(
    '/rpc/hosts/:hostRef/wake',
    requireRpcAuth,
    requireScope('host:wake:write'),
    async (req: AuthedRequest, res, next) => {
      try {
        const auth = req.auth!
        const rpcAccessToken = extractAuthToken(req)
        const hostRef = String(req.params.hostRef || '').trim()
        if (!isSafeUpstreamPathSegment(hostRef)) {
          res.status(400).json({ error: 'Invalid hostRef' })
          return
        }

        const host = await resolveHostConnectionForUser(auth.sub, hostRef, rpcAccessToken, {
          teamId: auth.teamId,
        })
        if (!host) {
          res.status(403).json({ error: 'Forbidden: user cannot access this host' })
          return
        }

        console.info(`[RPC_PROXY] user=${auth.sub} host=${hostRef} method=host-wake`)
        let wake: HostWakeApiResponse
        try {
          wake = await requestHostWakeFromControlApi(hostRef, rpcAccessToken)
        } catch (error) {
          console.warn(
            `[RPC_PROXY] host wake request failed host=${hostRef} error=${
              error instanceof Error ? error.message : String(error)
            }`
          )
          res.status(502).json({ error: 'Control API host wake unavailable' })
          return
        }

        switch (wake.kind) {
          case 'active':
            res.status(200).json({
              status: 'active',
              ...(wake.wakeGeneration !== null ? { wakeGeneration: wake.wakeGeneration } : {}),
            })
            return
          case 'wake-requested':
            res.status(202).json({
              status: 'wake-requested',
              ...(wake.wakeGeneration !== null ? { wakeGeneration: wake.wakeGeneration } : {}),
            })
            return
          case 'not-stateless':
            res.status(409).json({ status: 'not-stateless' })
            return
          case 'unknown':
            res.status(404).json({ status: 'unknown' })
            return
          case 'rate-limited':
            res.setHeader('Retry-After', String(Math.max(1, Math.ceil(wake.retryAfterSeconds))))
            res.status(429).json({
              error: 'Host wake rate limited',
              retryAfterSeconds: wake.retryAfterSeconds,
            })
            return
          case 'auth':
            // control-api rejected the caller's rpc access token — mirror it.
            res.status(wake.status).json({ error: 'Control API rejected the rpc access token' })
            return
          default: {
            // Exhaustiveness guard: a future HostWakeApiResponse kind must
            // answer 502 instead of leaving the request hanging until the
            // client times out.
            const unhandledWake: never = wake
            void unhandledWake
            console.warn(`[RPC_PROXY] unhandled host wake response kind host=${hostRef}`)
            res.status(502).json({ error: 'Unhandled wake response' })
            return
          }
        }
      } catch (error) {
        next(error)
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
        // Wake-eligible finite operation (§11.4): the route scope stays
        // host:approval:write; wake capability rides on the token. A suspended
        // (network-down) or draining Host triggers a wake-and-hold instead of a
        // bare next(error)/passthrough.
        const attempt = async () => {
          const response = await fetch(`${baseUrl}/v1/runtime/approvals/approve`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...host.headers },
            body: JSON.stringify(upstreamBody),
          })
          const body = await response.text()
          const draining = sessionDrainingFence(response, body)
          if (draining) throw draining
          res.status(response.status).send(body)
        }
        try {
          await attempt()
        } catch (error) {
          if (!isWakeEligibleHostError(error)) throw error
          await respondWithWakeAndHold({
            res,
            hostRef,
            host,
            claims: auth,
            rpcAccessToken,
            attemptUpstream: attempt,
            respondLegacy: legacyError => respondUpstreamUnavailable(res, legacyError),
          })
        }
      } catch (error) {
        guardedNext(res, next, error)
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
        // Wake-eligible finite operation (§11.4): scope stays host:approval:write.
        const attempt = async () => {
          const response = await fetch(`${baseUrl}/v1/runtime/approvals/deny`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...host.headers },
            body: JSON.stringify(upstreamBody),
          })
          const body = await response.text()
          const draining = sessionDrainingFence(response, body)
          if (draining) throw draining
          res.status(response.status).send(body)
        }
        try {
          await attempt()
        } catch (error) {
          if (!isWakeEligibleHostError(error)) throw error
          await respondWithWakeAndHold({
            res,
            hostRef,
            host,
            claims: auth,
            rpcAccessToken,
            attemptUpstream: attempt,
            respondLegacy: legacyError => respondUpstreamUnavailable(res, legacyError),
          })
        }
      } catch (error) {
        guardedNext(res, next, error)
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
        if (!isSafeUpstreamPathSegment(hostRef)) {
          res.status(400).json({ error: 'Invalid hostRef' })
          return
        }
        const rawSessionAgent = req.query.agent
        const sessionAgent =
          typeof rawSessionAgent === 'string' ? rawSessionAgent.trim() : undefined
        const rawSessionCursor = req.query.cursor
        const sessionCursor = typeof rawSessionCursor === 'string' ? rawSessionCursor : ''
        const sessionLimit = parseUnsignedIntegerQuery(req.query.limit)
        if (
          (rawSessionAgent !== undefined && typeof rawSessionAgent !== 'string') ||
          (rawSessionCursor !== undefined && typeof rawSessionCursor !== 'string') ||
          (rawSessionAgent !== undefined &&
            (!sessionAgent || !isSafeUpstreamAgentSegment(sessionAgent))) ||
          (rawSessionCursor !== undefined && !sessionCursor) ||
          sessionCursor.length > 2048 ||
          sessionLimit === null ||
          (sessionLimit !== undefined && sessionLimit < 1)
        ) {
          res.status(400).json({ error: 'Invalid session pagination query' })
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
        const upstreamUrl = new URL(`${baseUrl}/v1/runtime/sessions`)
        if (sessionAgent) upstreamUrl.searchParams.set('agent', sessionAgent)
        if (sessionLimit !== undefined) {
          upstreamUrl.searchParams.set('limit', String(Math.min(sessionLimit, 100)))
        }
        if (sessionCursor) upstreamUrl.searchParams.set('cursor', sessionCursor)
        console.info(`[RPC_PROXY] user=${auth.sub} host=${hostRef} method=list-sessions`)
        // Wake-eligible finite operation (§11.4): the route scope stays
        // host:session:read; wake capability rides on the token. A suspended
        // (network-down) or draining Host triggers a wake-and-hold instead of a
        // bare next(error)/passthrough.
        const forwardSessionList = async () => {
          const response = await fetch(upstreamUrl, {
            method: 'GET',
            headers: { ...host.headers },
            signal: AbortSignal.timeout(config.upstreamTimeoutMs),
          })
          const body = await response.text()
          const draining = sessionDrainingFence(response, body)
          if (draining) throw draining
          res
            .status(response.status)
            .type(response.headers.get('content-type') || 'application/json')
            .send(body)
        }
        try {
          await forwardSessionList()
        } catch (error) {
          // A sanitized session boundary can also wrap local response-body
          // failures. Wake only when its retained cause proves the host is
          // unavailable, or when the host explicitly returned the draining
          // fence; otherwise preserve the ordinary sanitized error path.
          if (!isWakeEligibleHostError(error)) {
            throw error
          }
          await respondWithWakeAndHold({
            res,
            hostRef,
            host,
            claims: auth,
            rpcAccessToken,
            attemptUpstream: forwardSessionList,
            respondLegacy: legacyError => respondUpstreamUnavailable(res, legacyError),
          })
        }
      } catch (error) {
        guardedNext(res, next, error)
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
        if (
          !isSafeUpstreamPathSegment(hostRef) ||
          !isSafeUpstreamAgentSegment(agent) ||
          !isSafeUpstreamPathSegment(chatId)
        ) {
          res.status(400).json({ error: 'Invalid hostRef, agent, or chatId' })
          return
        }
        const rawLimit = parseUnsignedIntegerQuery(req.query.limit)
        const beforeTurn = parseUnsignedIntegerQuery(req.query.beforeTurn)
        const afterTurn = parseUnsignedIntegerQuery(req.query.afterTurn)
        const invalidQueryShape = ['limit', 'beforeTurn', 'afterTurn'].some(
          key => req.query[key] !== undefined && typeof req.query[key] !== 'string'
        )
        if (
          invalidQueryShape ||
          rawLimit === null ||
          (rawLimit !== undefined && rawLimit < 1) ||
          beforeTurn === null ||
          (beforeTurn !== undefined && beforeTurn < 1) ||
          afterTurn === null ||
          (afterTurn !== undefined && afterTurn < 0) ||
          (beforeTurn !== undefined && afterTurn !== undefined)
        ) {
          res.status(400).json({ error: 'Invalid session messages pagination query' })
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
        const upstreamUrl = new URL(
          `${baseUrl}/v1/runtime/sessions/${encodeURIComponent(agent)}/${encodeURIComponent(chatId)}/messages`
        )
        if (rawLimit !== undefined) {
          upstreamUrl.searchParams.set('limit', String(Math.min(rawLimit, 200)))
        }
        if (beforeTurn !== undefined) {
          upstreamUrl.searchParams.set('beforeTurn', String(beforeTurn))
        }
        if (afterTurn !== undefined) upstreamUrl.searchParams.set('afterTurn', String(afterTurn))
        console.info(
          `[RPC_PROXY] user=${auth.sub} host=${hostRef} method=get-session-messages agent=${agent} chatId=${chatId}`
        )
        // Wake-eligible finite operation (§11.4): scope stays host:session:read.
        const forwardTranscript = async () => {
          const response = await fetch(upstreamUrl, {
            method: 'GET',
            headers: { ...host.headers },
            signal: AbortSignal.timeout(config.upstreamTimeoutMs),
          })
          const body = await response.text()
          const draining = sessionDrainingFence(response, body)
          if (draining) throw draining
          res
            .status(response.status)
            .type(response.headers.get('content-type') || 'application/json')
            .send(body)
        }
        try {
          await forwardTranscript()
        } catch (error) {
          // See the list route above: availability recovery is deliberately
          // narrower than the generic sanitized upstream-error boundary.
          if (!isWakeEligibleHostError(error)) {
            throw error
          }
          await respondWithWakeAndHold({
            res,
            hostRef,
            host,
            claims: auth,
            rpcAccessToken,
            attemptUpstream: forwardTranscript,
            respondLegacy: legacyError => respondUpstreamUnavailable(res, legacyError),
          })
        }
      } catch (error) {
        guardedNext(res, next, error)
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
        if (
          !isSafeUpstreamPathSegment(hostRef) ||
          !isSafeUpstreamAgentSegment(agent) ||
          !isSafeUpstreamPathSegment(chatId)
        ) {
          res.status(400).json({ error: 'Invalid hostRef, agent, or chatId' })
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
        // Wake-eligible finite operation (§11.4): scope stays host:session:read.
        const attempt = async () => {
          const response = await fetch(
            `${baseUrl}/v1/runtime/sessions/${encodeURIComponent(agent)}/${encodeURIComponent(chatId)}/context-breakdown`,
            {
              method: 'GET',
              headers: { ...host.headers },
              signal: AbortSignal.timeout(config.upstreamTimeoutMs),
            }
          )
          const body = await response.text()
          const draining = sessionDrainingFence(response, body)
          if (draining) throw draining
          res
            .status(response.status)
            .type(response.headers.get('content-type') || 'application/json')
            .send(body)
        }
        try {
          await attempt()
        } catch (error) {
          if (!isWakeEligibleHostError(error)) throw error
          await respondWithWakeAndHold({
            res,
            hostRef,
            host,
            claims: auth,
            rpcAccessToken,
            attemptUpstream: attempt,
            respondLegacy: legacyError => respondUpstreamUnavailable(res, legacyError),
          })
        }
      } catch (error) {
        guardedNext(res, next, error)
      }
    }
  )

  // List selectable models for the session — passthrough to mcp-host.
  // Read-only projection of the in-memory allowlist; scoped to host:session:read
  // (same as the other session reads). Passes the optional chatId query through
  // so mcp-host can include the per-session selection.
  router.get(
    '/rpc/hosts/:hostRef/models',
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
        const chatId = typeof req.query.chatId === 'string' ? req.query.chatId.trim() : ''
        const upstreamUrl = chatId
          ? `${baseUrl}/v1/runtime/models?chatId=${encodeURIComponent(chatId)}`
          : `${baseUrl}/v1/runtime/models`
        console.info(`[RPC_PROXY] user=${auth.sub} host=${hostRef} method=list-models`)
        // Wake-eligible finite operation (§11.4): scope stays host:session:read.
        const attempt = async () => {
          const response = await fetch(upstreamUrl, {
            method: 'GET',
            headers: { ...host.headers },
          })
          const body = await response.text()
          const draining = sessionDrainingFence(response, body)
          if (draining) throw draining
          res
            .status(response.status)
            .type(response.headers.get('content-type') || 'application/json')
            .send(body)
        }
        try {
          await attempt()
        } catch (error) {
          if (!isWakeEligibleHostError(error)) throw error
          await respondWithWakeAndHold({
            res,
            hostRef,
            host,
            claims: auth,
            rpcAccessToken,
            attemptUpstream: attempt,
            respondLegacy: legacyError => respondUpstreamUnavailable(res, legacyError),
          })
        }
      } catch (error) {
        guardedNext(res, next, error)
      }
    }
  )

  // Set the per-session model — write path, scoped to host:model:write.
  // Body {chatId, model} is passed through verbatim; mcp-host owns validation
  // (model_not_allowed) and per-user authorization, so its 400/403 pass through.
  router.post(
    '/rpc/hosts/:hostRef/model',
    requireRpcAuth,
    requireScope('host:model:write'),
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
        const body = req.body as Record<string, unknown>
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          res.status(400).json({ error: 'Invalid set-model request payload' })
          return
        }
        const baseUrl = host.url.replace(/\/+$/, '')
        console.info(`[RPC_PROXY] user=${auth.sub} host=${hostRef} method=set-model`)
        // Wake-eligible finite operation (§11.4): scope stays host:model:write.
        const attempt = async () => {
          const response = await fetch(`${baseUrl}/v1/runtime/model`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...host.headers },
            body: JSON.stringify(body),
          })
          const upstreamBody = await response.text()
          const draining = sessionDrainingFence(response, upstreamBody)
          if (draining) throw draining
          res
            .status(response.status)
            .type(response.headers.get('content-type') || 'application/json')
            .send(upstreamBody)
        }
        try {
          await attempt()
        } catch (error) {
          if (!isWakeEligibleHostError(error)) throw error
          await respondWithWakeAndHold({
            res,
            hostRef,
            host,
            claims: auth,
            rpcAccessToken,
            attemptUpstream: attempt,
            respondLegacy: legacyError => respondUpstreamUnavailable(res, legacyError),
          })
        }
      } catch (error) {
        guardedNext(res, next, error)
      }
    }
  )

  router.get(
    '/rpc/hosts/:hostRef/tasks/:taskId/result',
    requireRpcAuth,
    requireScope('host:message:invoke'),
    async (req: AuthedRequest, res) => {
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
        const attemptTaskResult = async () => {
          const result = await forwardTaskResultFromHost(host, taskId)
          if (!result) {
            res.status(404).json({ error: 'Task result not found' })
            return
          }
          res.status(200).json(result)
        }
        try {
          await attemptTaskResult()
        } catch (error) {
          console.warn(
            `[RPC_PROXY] task result forward failed error=${error instanceof Error ? error.message : String(error)}`
          )
          if (isWakeEligibleHostError(error)) {
            await respondWithWakeAndHold({
              res,
              hostRef,
              host,
              claims: auth,
              rpcAccessToken,
              attemptUpstream: attemptTaskResult,
              respondLegacy: legacyError => respondUpstreamUnavailable(res, legacyError),
            })
            return
          }
          respondUpstreamUnavailable(res, error)
        }
      } catch (error) {
        console.warn(
          `[RPC_PROXY] task result forward failed error=${error instanceof Error ? error.message : String(error)}`
        )
        respondUpstreamUnavailable(res, error)
      }
    }
  )

  router.post(
    '/rpc/hosts/:hostRef/tasks/:taskId/cancel',
    requireRpcAuth,
    requireScope('host:message:invoke'),
    async (req: AuthedRequest, res) => {
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

        const attemptCancel = async () => {
          const result = await forwardCancelToHost(host, taskId, auth.sub)
          if (result.body) {
            res
              .status(result.status)
              .type(result.contentType || 'application/json')
              .send(result.body)
          } else {
            res.status(result.status).end()
          }
        }
        try {
          await attemptCancel()
        } catch (error) {
          console.warn(
            `[RPC_PROXY] cancel forward failed error=${error instanceof Error ? error.message : String(error)}`
          )
          if (isWakeEligibleHostError(error)) {
            await respondWithWakeAndHold({
              res,
              hostRef,
              host,
              claims: auth,
              rpcAccessToken,
              attemptUpstream: attemptCancel,
              respondLegacy: legacyError => respondUpstreamUnavailable(res, legacyError),
            })
            return
          }
          respondUpstreamUnavailable(res, error)
        }
      } catch (error) {
        console.warn(
          `[RPC_PROXY] cancel forward failed error=${error instanceof Error ? error.message : String(error)}`
        )
        respondUpstreamUnavailable(res, error)
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
        // Wake-eligible finite operation (§11.4): scope stays host:task:read.
        const attempt = async () => {
          const response = await fetch(`${baseUrl}/v1/runtime/artifacts`, {
            headers: { ...host.headers },
          })
          const body = await response.text()
          const draining = sessionDrainingFence(response, body)
          if (draining) throw draining
          res.status(response.status).send(body)
        }
        try {
          await attempt()
        } catch (error) {
          if (!isWakeEligibleHostError(error)) throw error
          await respondWithWakeAndHold({
            res,
            hostRef,
            host,
            claims: auth,
            rpcAccessToken,
            attemptUpstream: attempt,
            respondLegacy: legacyError => respondUpstreamUnavailable(res, legacyError),
          })
        }
      } catch (error) {
        guardedNext(res, next, error)
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
        // Wake-eligible finite operation (§11.4): scope stays host:task:read.
        // The success path only commits (`res.send`) at the very end, so a
        // wake retry before that point is safe from duplicate delivery.
        const attemptDownload = async () => {
          const response = await fetch(
            `${baseUrl}/v1/runtime/artifacts/${encodeURIComponent(filename)}/download`,
            {
              headers: { ...host.headers },
            }
          )
          if (!response.ok) {
            const errBody = await response.text()
            const draining = sessionDrainingFence(response, errBody)
            if (draining) throw draining
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
        }
        try {
          await attemptDownload()
        } catch (error) {
          if (!isWakeEligibleHostError(error)) throw error
          await respondWithWakeAndHold({
            res,
            hostRef,
            host,
            claims: auth,
            rpcAccessToken,
            attemptUpstream: attemptDownload,
            respondLegacy: legacyError => respondUpstreamUnavailable(res, legacyError),
          })
        }
      } catch (error) {
        guardedNext(res, next, error)
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
