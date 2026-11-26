import { Router } from 'express'
import {
  HOST_EDGE_ASSERTION_HEADER,
  HOST_EDGE_RPC_PROXY_ROUTE_SCOPES,
} from '@clerum/action-context-contracts'
import { config } from '../config.js'
import { getHostRpcPreflight } from '../hostRpcPreflight.js'
import {
  type AuthedRequest,
  extractAuthToken,
  requireHostRpcPreflightScope,
  requireRpcAuth,
} from '../middleware/auth.js'
import { runtimeHostEdgeContext } from '../routeActionBindingV2.js'
import { isHostResolveRefusal, respondHostResolveRefusal } from '../services/hostAccessDenial.js'
import {
  UpstreamHostError,
  forwardHostStatus,
  isHeldEdgeAssertionNearExpiry,
  resolveHostConnectionForUser,
} from '../services/mcpProxyService.js'

/**
 * The stream ends with `auth-expired`, so the desktop client clears its cached
 * RPC token and reconnects with a fresh one, in two cases:
 * - Normal: the held edge assertion, which ends no later than the RPC token, is
 *   within `RPC_PROXY_UPSTREAM_TIMEOUT_MS` + 2 s of its `exp` (10 s with the
 *   8 s default, 62 s with the minikube overlay's 60000). The stream checks this
 *   before each poll; a fresh token gives a cycle of about 290 s by default,
 *   about 238 s on minikube.
 * - Abnormal: the Host refuses this many consecutive polls with 401/403. Polls
 *   fire every `streamIntervalMs` (default 3 s); the threshold tolerates one or
 *   two transient refusals and keeps a stream the Host refuses from polling
 *   forever.
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

function sanitizedStreamErrorMessage(): string {
  return 'Status temporarily unavailable'
}

/** Clears in-process stream counters. Tests must call this; production never does. */
export function resetHostStatusStreamRuntimeForTests(): void {
  if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
    throw new Error('resetHostStatusStreamRuntimeForTests is test-only')
  }
  activeStreamCountsByUser.clear()
  activeStreamCountsByUserHost.clear()
  activeStreams.clear()
  streamCounter = 0
}

export function createRpcHostStatusStreamRouter(): Router {
  const router = Router()

  router.get(
    '/rpc/hosts/:hostRef/status/stream',
    requireRpcAuth,
    requireHostRpcPreflightScope(HOST_EDGE_RPC_PROXY_ROUTE_SCOPES['GET /v1/runtime/status']),
    async (req: AuthedRequest, res, next) => {
      // Read-only telemetry channel:
      // - server-sent status updates from mcp-host to desktop clients
      // - never accepts message submission payloads
      try {
        const auth = req.auth!
        const rpcAccessToken = extractAuthToken(req)
        const { hostRef } = getHostRpcPreflight(req)

        const host = await resolveHostConnectionForUser(
          auth.sub,
          hostRef,
          rpcAccessToken,
          runtimeHostEdgeContext(req)
        )
        if (isHostResolveRefusal(host)) {
          respondHostResolveRefusal(res, host, 'forbidden')
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
            // The stream does not renew the held edge assertion. End the
            // stream before a poll could reach the Host after `exp`.
            if (
              isHeldEdgeAssertionNearExpiry(host.headers[HOST_EDGE_ASSERTION_HEADER], Date.now())
            ) {
              writeEvent('auth-expired', {
                message: 'Host access is about to expire. Reconnect with a fresh token.',
              })
              cleanup('auth-expired')
              return
            }
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
            // After AUTH_FAILURE_THRESHOLD strikes, the Host has refused the
            // poll that many times in a row (edge assertion, host access or
            // caller context). Emit a dedicated `auth-expired` event so the
            // desktop client clears its token cache and reconnects with a
            // fresh token instead of polling the Host with the same
            // connection forever.
            if (!closed && isAuthFailure && consecutiveAuthFailures >= AUTH_FAILURE_THRESHOLD) {
              writeEvent('auth-expired', {
                message: 'Host refused the status poll. Reconnect with a fresh token.',
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
        // After the timers exist: the first poll can end the stream
        // synchronously (near-expiry check), and cleanup must clear them.
        void pollAndEmit()

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
