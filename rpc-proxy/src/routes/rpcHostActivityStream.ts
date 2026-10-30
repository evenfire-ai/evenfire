import { Router } from 'express'
import { config } from '../config.js'
import { getHostRpcPreflight } from '../hostRpcPreflight.js'
import {
  type AuthedRequest,
  extractAuthToken,
  requireHostRpcPreflightScope,
  requireRpcAuth,
} from '../middleware/auth.js'
import { runtimeHostEdgeContext } from '../routeActionBindingV2.js'
import { isHostAccessDenied, respondHostAccessDenied } from '../services/hostAccessDenial.js'
import { resolveHostConnectionForUser } from '../services/mcpProxyService.js'

const activeStreamCountsByUser = new Map<string, number>()
const activeStreamCountsByUserHost = new Map<string, number>()
const activeStreams = new Set<string>()
let streamCounter = 0

/** Clears in-process stream counters. Tests must call this; production never does. */
export function resetHostActivityStreamRuntimeForTests(): void {
  if (process.env.VITEST !== 'true' && process.env.NODE_ENV !== 'test') {
    throw new Error('resetHostActivityStreamRuntimeForTests is test-only')
  }
  activeStreamCountsByUser.clear()
  activeStreamCountsByUserHost.clear()
  activeStreams.clear()
  streamCounter = 0
}

function nextStreamId(): string {
  streamCounter += 1
  return `activity-stream-${Date.now()}-${streamCounter}`
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
  return 'Activity temporarily unavailable'
}

function maximumActivityFrameBytes(): number {
  const configured = Number(process.env.MCP_HOST_ACTIVITY_MAX_EVENT_BYTES ?? '2048')
  const eventBytes = Number.isSafeInteger(configured) && configured > 0 ? configured : 2_048
  return eventBytes + Buffer.byteLength('event: activity\ndata: \n\n', 'utf8')
}

type ParsedSse = { event: string; data: unknown } | null

function parseSseBlock(block: string): ParsedSse {
  const lines = block.split('\n')
  let event = ''
  const dataLines: string[] = []
  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trim())
    }
  }
  if (!event || dataLines.length === 0) return null
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) as unknown }
  } catch {
    return { event, data: {} }
  }
}

export function createRpcHostActivityStreamRouter(): Router {
  const router = Router()

  router.get(
    '/rpc/hosts/:hostRef/activity/stream',
    requireRpcAuth,
    requireHostRpcPreflightScope('host:activity:read'),
    async (req: AuthedRequest, res, next) => {
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
        if (isHostAccessDenied(host)) {
          respondHostAccessDenied(res, host)
          return
        }
        if (!host) {
          res.status(403).json({ error: 'Forbidden: user cannot access this host' })
          return
        }

        const perUserCount = activeStreamCountsByUser.get(auth.sub) || 0
        const perUserHostCount =
          activeStreamCountsByUserHost.get(userHostKey(auth.sub, hostRef)) || 0
        if (
          activeStreams.size >= config.activityStreamMaxConcurrent ||
          perUserCount >= config.activityStreamMaxPerUser ||
          perUserHostCount >= config.activityStreamMaxPerUserHost
        ) {
          res.setHeader('retry-after', '5')
          res.status(429).json({ error: 'Too many active activity streams' })
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

        const abortController = new AbortController()
        let closed = false
        let eventId = 0
        let lastUpstreamActivityAt = Date.now()
        let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null
        let keepAliveId: NodeJS.Timeout | null = null
        let lifetimeId: NodeJS.Timeout | null = null
        let idleCheckId: NodeJS.Timeout | null = null
        const maxFrameBytes = maximumActivityFrameBytes()

        const serializeEvent = (
          event: 'open' | 'activity' | 'error' | 'closed',
          payload: unknown
        ) => {
          eventId += 1
          return `id: ${eventId}\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
        }

        const cleanup = (reason: string, emitClosed = true) => {
          if (closed) return
          closed = true
          abortController.abort()
          const reader = upstreamReader
          upstreamReader = null
          void reader?.cancel().catch(() => undefined)
          if (keepAliveId) clearInterval(keepAliveId)
          if (lifetimeId) clearTimeout(lifetimeId)
          if (idleCheckId) clearInterval(idleCheckId)
          activeStreams.delete(streamId)
          decrementCounter(activeStreamCountsByUser, auth.sub)
          decrementCounter(activeStreamCountsByUserHost, userHostKey(auth.sub, hostRef))
          if (!res.writableEnded) {
            if (emitClosed) res.write(serializeEvent('closed', { reason }))
            res.end()
          }
        }

        res.once('close', () => cleanup('client-disconnect', false))

        const writeEvent = (event: 'open' | 'activity' | 'error' | 'closed', payload: unknown) => {
          if (closed || res.writableEnded) return false
          if (!res.write(serializeEvent(event, payload))) {
            cleanup('client_backpressure', false)
            return false
          }
          return true
        }

        const allowedEvents = new Set(['open', 'activity', 'error', 'closed'])
        const baseUrl = host.url.replace(/\/+$/, '')
        const upstreamResponse = await fetch(`${baseUrl}/v1/runtime/activity/stream`, {
          method: 'GET',
          headers: {
            accept: 'text/event-stream',
            ...host.headers,
          },
          signal: abortController.signal,
        })
        if (closed) {
          await upstreamResponse.body?.cancel().catch(() => undefined)
          return
        }
        if (!upstreamResponse.ok || !upstreamResponse.body) {
          writeEvent('error', { message: sanitizedStreamErrorMessage() })
          cleanup('upstream_unavailable')
          return
        }

        const reader = upstreamResponse.body.getReader()
        upstreamReader = reader
        if (!writeEvent('open', { hostRef, observedAt: new Date().toISOString() })) {
          return
        }
        keepAliveId = setInterval(() => {
          if (!closed && !res.write(': keepalive\n\n')) cleanup('client_backpressure', false)
        }, config.activityStreamKeepaliveMs)
        lifetimeId = setTimeout(() => {
          writeEvent('error', { message: 'Activity stream expired. Reconnect required.' })
          cleanup('max-lifetime')
        }, config.activityStreamMaxLifetimeMs)
        idleCheckId = setInterval(() => {
          if (!closed && Date.now() - lastUpstreamActivityAt > config.activityStreamIdleTimeoutMs) {
            writeEvent('error', { message: sanitizedStreamErrorMessage() })
            cleanup('idle-timeout')
          }
        }, 1000)

        const decoder = new TextDecoder()
        let buffer = ''
        void (async () => {
          try {
            while (!closed) {
              const readResult = await reader.read()
              if (readResult.done) {
                cleanup('upstream-closed')
                break
              }
              const decoded = decoder.decode(readResult.value, { stream: true })
              let cursor = 0
              while (!closed && cursor < decoded.length) {
                const delimiterCrossesChunk = buffer.endsWith('\n') && decoded[cursor] === '\n'
                const splitAt = delimiterCrossesChunk ? cursor : decoded.indexOf('\n\n', cursor)
                if (!delimiterCrossesChunk && splitAt < 0) {
                  const partial = buffer + decoded.slice(cursor)
                  if (Buffer.byteLength(partial, 'utf8') > maxFrameBytes) {
                    buffer = ''
                    cleanup('upstream_frame_too_large', false)
                    break
                  }
                  buffer = partial
                  break
                }
                const block = delimiterCrossesChunk
                  ? buffer.slice(0, -1)
                  : buffer + decoded.slice(cursor, splitAt)
                const frameBytes = Buffer.byteLength(`${block}\n\n`, 'utf8')
                if (frameBytes > maxFrameBytes) {
                  buffer = ''
                  cleanup('upstream_frame_too_large', false)
                  break
                }
                buffer = ''
                cursor = delimiterCrossesChunk ? cursor + 1 : splitAt + 2
                const parsed = parseSseBlock(block)
                if (!parsed || !allowedEvents.has(parsed.event)) continue
                if (parsed.event === 'activity') {
                  if (!writeEvent('activity', parsed.data)) break
                  lastUpstreamActivityAt = Date.now()
                } else if (parsed.event === 'error') {
                  writeEvent('error', { message: sanitizedStreamErrorMessage() })
                } else if (parsed.event === 'closed') {
                  cleanup('upstream-closed')
                }
              }
            }
          } catch (error) {
            if (!closed) {
              writeEvent('error', { message: sanitizedStreamErrorMessage() })
              cleanup('upstream-failure')
            }
          } finally {
            if (upstreamReader === reader) upstreamReader = null
            reader.releaseLock()
          }
        })()
      } catch (error) {
        if (res.destroyed || res.writableEnded) return
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
