import { Router } from 'express'
import { config } from '../config.js'
import {
  type AuthedRequest,
  extractAuthToken,
  requireRpcAuth,
  requireScope,
} from '../middleware/auth.js'
import { resolveHostConnectionForUser } from '../services/mcpProxyService.js'

const activeStreamCountsByUser = new Map<string, number>()
const activeStreamCountsByUserHost = new Map<string, number>()
const activeStreams = new Set<string>()
let streamCounter = 0

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

function isWildcardOrInvalidHostRef(hostRef: string): boolean {
  if (!hostRef.trim()) return true
  return /[*%]/.test(hostRef)
}

function sanitizedStreamErrorMessage(): string {
  return 'Activity temporarily unavailable'
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
    requireScope('host:activity:read'),
    async (req: AuthedRequest, res, next) => {
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
            .json({ error: 'Activity stream is read-only and does not accept request bodies' })
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
        let keepAliveId: NodeJS.Timeout | null = null
        let lifetimeId: NodeJS.Timeout | null = null
        let idleCheckId: NodeJS.Timeout | null = null

        const cleanup = (reason: string) => {
          if (closed) return
          closed = true
          abortController.abort()
          if (keepAliveId) clearInterval(keepAliveId)
          if (lifetimeId) clearTimeout(lifetimeId)
          if (idleCheckId) clearInterval(idleCheckId)
          activeStreams.delete(streamId)
          decrementCounter(activeStreamCountsByUser, auth.sub)
          decrementCounter(activeStreamCountsByUserHost, userHostKey(auth.sub, hostRef))
          if (!res.writableEnded) {
            res.write(`event: closed\n`)
            res.write(`data: ${JSON.stringify({ reason })}\n\n`)
            res.end()
          }
        }

        const writeEvent = (event: 'open' | 'activity' | 'error' | 'closed', payload: unknown) => {
          if (closed || res.writableEnded) return
          eventId += 1
          res.write(`id: ${eventId}\n`)
          res.write(`event: ${event}\n`)
          res.write(`data: ${JSON.stringify(payload)}\n\n`)
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
        if (!upstreamResponse.ok || !upstreamResponse.body) {
          writeEvent('error', { message: sanitizedStreamErrorMessage() })
          cleanup('upstream_unavailable')
          return
        }

        writeEvent('open', { hostRef, observedAt: new Date().toISOString() })
        keepAliveId = setInterval(() => {
          if (!closed) res.write(': keepalive\n\n')
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

        const reader = upstreamResponse.body.getReader()
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
              buffer += decoder.decode(readResult.value, { stream: true })
              let splitAt = buffer.indexOf('\n\n')
              while (splitAt >= 0) {
                const block = buffer.slice(0, splitAt)
                buffer = buffer.slice(splitAt + 2)
                splitAt = buffer.indexOf('\n\n')
                const parsed = parseSseBlock(block)
                if (!parsed || !allowedEvents.has(parsed.event)) continue
                if (parsed.event === 'activity') {
                  writeEvent('activity', parsed.data)
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
              console.warn(
                `[RPC_PROXY] host activity stream read failed host=${hostRef} user=${auth.sub} error=${
                  error instanceof Error ? error.message : String(error)
                }`
              )
              writeEvent('error', { message: sanitizedStreamErrorMessage() })
              cleanup('upstream-failure')
            }
          } finally {
            reader.releaseLock()
          }
        })()

        req.on('close', () => {
          cleanup('client-disconnect')
        })
      } catch (error) {
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
