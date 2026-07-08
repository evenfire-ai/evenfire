import { Router } from 'express'
import { config } from '../config.js'
import {
  type AuthedRequest,
  extractAuthToken,
  requireRpcAuth,
  requireScope,
} from '../middleware/auth.js'
import {
  UpstreamHostError,
  forwardHostStatus,
  resolveHostConnectionForUser,
} from '../services/mcpProxyService.js'

/**
 * Stream gives up after this many back-to-back upstream auth failures and
 * emits `auth-expired` so the desktop client knows to clear its cached RPC
 * token and reconnect with a fresh one. The token TTL is 300s; status polls
 * fire every `streamIntervalMs` (default 5s), so 3 strikes keeps a stuck
 * stream from spamming forever while still tolerating a single transient
 * 401 race during normal token rotation.
 */
const AUTH_FAILURE_THRESHOLD = 3

const activeStreamCountsByUser = new Map<string, number>()
const activeStreamCountsByUserHost = new Map<string, number>()
const activeStreams = new Set<string>()
let streamCounter = 0

function nextStreamId(): string {
  streamCounter += 1
  return `rpc-stream-${Date.now()}-${streamCounter}`
}

function userHostKey(userId: string, hostRef: string): string {
  return `${userId}::${hostRef}`
}

function incrementCounter(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) || 0) + 1)
}

function decrementCounter(map: Map<string, number>, key: string): void {
  const next = (map.get(key) || 0) - 1
  if (next <= 0) map.delete(key)
  else map.set(key, next)
}

function isWildcardOrInvalidHostRef(hostRef: string): boolean {
  if (!hostRef.trim()) return true
  return /[*%]/.test(hostRef)
}

function sanitizedStreamErrorMessage(): string {
  return 'Status temporarily unavailable'
}

export function createRpcHostStatusStreamRouter(): Router {
  const router = Router()

  router.get(
    '/rpc/hosts/:hostRef/status/stream',
    requireRpcAuth,
    requireScope('host:status:read'),
    async (req: AuthedRequest, res, next) => {
      // Read-only telemetry channel:
      // - server-sent status updates from mcp-host to desktop clients
      // - never accepts message submission payloads
      try {
        const auth = req.auth!
        const rpcAccessToken = extractAuthToken(req)
        const hostRef = String(req.params.hostRef || '').trim()
        if (!hostRef || isWildcardOrInvalidHostRef(hostRef)) {
          res.status(400).json({ error: 'hostRef is required' })
          return
        }
        if (Number(req.headers['content-length'] || 0) > 0) {
          res
            .status(400)
            .json({ error: 'Status stream is read-only and does not accept request bodies' })
          return
        }

        const host = await resolveHostConnectionForUser(auth.sub, hostRef, rpcAccessToken, {
          teamId: auth.teamId,
        })
        if (!host) {
          res.status(403).json({ error: 'Forbidden: user cannot access this host' })
          return
        }

        const perUserCount = activeStreamCountsByUser.get(auth.sub) || 0
        const perUserHostCount =
          activeStreamCountsByUserHost.get(userHostKey(auth.sub, hostRef)) || 0
        if (
          activeStreams.size >= config.streamMaxConcurrent ||
          perUserCount >= config.streamMaxPerUser ||
          perUserHostCount >= config.streamMaxPerUserHost
        ) {
          res.setHeader('retry-after', '5')
          res.status(429).json({ error: 'Too many active status streams' })
          return
        }

        res.setHeader('content-type', 'text/event-stream')
        res.setHeader('cache-control', 'no-cache, no-transform')
        res.setHeader('connection', 'keep-alive')
        res.setHeader('x-accel-buffering', 'no')
        res.flushHeaders()

        const streamId = nextStreamId()
        activeStreams.add(streamId)
        incrementCounter(activeStreamCountsByUser, auth.sub)
        incrementCounter(activeStreamCountsByUserHost, userHostKey(auth.sub, hostRef))

        let closed = false
        let pollInFlight = false
        let eventId = 0
        let lastSuccessfulStatusAt = Date.now()
        let consecutiveAuthFailures = 0
        let intervalId: NodeJS.Timeout | null = null
        let keepAliveId: NodeJS.Timeout | null = null
        let lifetimeId: NodeJS.Timeout | null = null

        const cleanup = (reason: string) => {
          if (closed) return
          closed = true
          if (intervalId) clearInterval(intervalId)
          if (keepAliveId) clearInterval(keepAliveId)
          if (lifetimeId) clearTimeout(lifetimeId)
          activeStreams.delete(streamId)
          decrementCounter(activeStreamCountsByUser, auth.sub)
          decrementCounter(activeStreamCountsByUserHost, userHostKey(auth.sub, hostRef))
          if (!res.writableEnded) {
            res.write(`event: closed\n`)
            res.write(`data: ${JSON.stringify({ reason })}\n\n`)
            res.end()
          }
        }

        const writeEvent = (event: string, payload: unknown) => {
          if (closed || res.writableEnded) return
          eventId += 1
          res.write(`id: ${eventId}\n`)
          res.write(`event: ${event}\n`)
          res.write(`data: ${JSON.stringify(payload)}\n\n`)
        }

        const pollAndEmit = async () => {
          if (closed || pollInFlight) return
          pollInFlight = true
          try {
            const status = await forwardHostStatus(host)
            if (!status) {
              writeEvent('error', { message: sanitizedStreamErrorMessage() })
              return
            }
            lastSuccessfulStatusAt = Date.now()
            consecutiveAuthFailures = 0
            writeEvent('status', status)
          } catch (error) {
            const isAuthFailure =
              error instanceof UpstreamHostError && (error.status === 401 || error.status === 403)
            if (isAuthFailure) {
              consecutiveAuthFailures += 1
            } else {
              consecutiveAuthFailures = 0
            }
            console.warn(
              `[RPC_PROXY] host status stream poll failed host=${hostRef} user=${auth.sub} error=${
                error instanceof Error ? error.message : String(error)
              }`
            )
            // After AUTH_FAILURE_THRESHOLD strikes, the upstream is rejecting
            // the captured RPC token (almost certainly expired). Emit a
            // dedicated `auth-expired` event so the desktop client clears
            // its token cache and reconnects via getOrIssue() instead of
            // tight-looping with the same stale token forever.
            if (!closed && isAuthFailure && consecutiveAuthFailures >= AUTH_FAILURE_THRESHOLD) {
              writeEvent('auth-expired', {
                message: 'RPC token rejected by host. Reconnect with a fresh token.',
              })
              cleanup('auth-expired')
              return
            }
            writeEvent('error', { message: sanitizedStreamErrorMessage() })
          } finally {
            pollInFlight = false
            if (!closed && Date.now() - lastSuccessfulStatusAt > config.streamIdleTimeoutMs) {
              writeEvent('error', { message: sanitizedStreamErrorMessage() })
              cleanup('idle-timeout')
            }
          }
        }

        writeEvent('open', { hostRef, observedAt: new Date().toISOString() })
        void pollAndEmit()
        intervalId = setInterval(() => {
          void pollAndEmit()
        }, config.streamIntervalMs)
        keepAliveId = setInterval(() => {
          if (!closed) res.write(': keepalive\n\n')
        }, config.streamKeepaliveMs)
        lifetimeId = setTimeout(() => {
          writeEvent('error', { message: 'Status stream expired. Reconnect required.' })
          cleanup('max-lifetime')
        }, config.streamMaxLifetimeMs)

        req.on('close', () => {
          cleanup('client-disconnect')
        })
      } catch (error) {
        console.warn(
          `[RPC_PROXY] host status stream setup failed host=${String(req.params.hostRef || '').trim()} error=${
            error instanceof Error ? error.message : String(error)
          }`
        )
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal Server Error' })
          return
        }
        next(error)
      }
    }
  )

  return router
}
