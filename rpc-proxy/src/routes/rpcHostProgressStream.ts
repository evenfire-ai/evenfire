import { Router } from 'express'
import { config } from '../config.js'
import {
  type AuthedRequest,
  extractAuthToken,
  requireRpcAuth,
  requireScope,
} from '../middleware/auth.js'
import { resolveHostConnectionForUser } from '../services/mcpProxyService.js'

function isWildcardOrInvalidHostRef(hostRef: string): boolean {
  if (!hostRef.trim()) return true
  return /[*%]/.test(hostRef)
}

function sanitizedStreamErrorMessage(): string {
  return 'Progress stream temporarily unavailable'
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

export function createRpcHostProgressStreamRouter(): Router {
  const router = Router()

  router.get(
    '/rpc/hosts/:hostRef/tasks/:taskId/progress/stream',
    requireRpcAuth,
    requireScope('host:activity:read'),
    async (req: AuthedRequest, res, next) => {
      try {
        const auth = req.auth!
        const rpcAccessToken = extractAuthToken(req)
        const hostRef = String(req.params.hostRef || '').trim()
        const taskId = String(req.params.taskId || '').trim()

        if (!hostRef || isWildcardOrInvalidHostRef(hostRef)) {
          res.status(400).json({ error: 'hostRef is required' })
          return
        }
        if (!taskId || taskId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(taskId)) {
          res
            .status(400)
            .json({ error: 'taskId is required and must be alphanumeric (max 128 chars)' })
          return
        }
        if (Number(req.headers['content-length'] || 0) > 0) {
          res
            .status(400)
            .json({ error: 'Progress stream is read-only and does not accept request bodies' })
          return
        }

        const host = await resolveHostConnectionForUser(auth.sub, hostRef, rpcAccessToken, {
          teamId: auth.teamId,
        })
        if (!host) {
          res.status(403).json({ error: 'Forbidden: user cannot access this host' })
          return
        }

        res.setHeader('content-type', 'text/event-stream')
        res.setHeader('cache-control', 'no-cache, no-transform')
        res.setHeader('connection', 'keep-alive')
        res.setHeader('x-accel-buffering', 'no')
        res.flushHeaders()

        const abortController = new AbortController()
        let closed = false
        let eventId = 0
        let keepAliveId: NodeJS.Timeout | null = null

        const cleanup = (reason: string) => {
          if (closed) return
          closed = true
          abortController.abort()
          if (keepAliveId) clearInterval(keepAliveId)
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

        const allowedEvents = new Set([
          'open',
          'waiting',
          'tool_start',
          'tool_complete',
          'tool_progress',
          'llm_in_progress',
          'suspended',
          'terminal',
          'done',
          'error',
          'closed',
        ])
        const baseUrl = host.url.replace(/\/+$/, '')
        const upstreamResponse = await fetch(
          `${baseUrl}/v1/runtime/tasks/${taskId}/progress/stream`,
          {
            method: 'GET',
            headers: {
              accept: 'text/event-stream',
              ...host.headers,
            },
            signal: abortController.signal,
          }
        )

        if (!upstreamResponse.ok || !upstreamResponse.body) {
          writeEvent('error', { message: sanitizedStreamErrorMessage() })
          cleanup('upstream_unavailable')
          return
        }

        keepAliveId = setInterval(() => {
          if (!closed) res.write(': keepalive\n\n')
        }, config.activityStreamKeepaliveMs)

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
                if (parsed.event === 'terminal') {
                  // Phase D unified terminal event — forward and close the stream
                  // (spec §6.4: stream closes immediately after terminal).
                  writeEvent('terminal', parsed.data)
                  cleanup('terminal')
                } else if (parsed.event === 'done') {
                  writeEvent('done', parsed.data)
                  cleanup('done')
                } else if (parsed.event === 'error') {
                  // Structured LLM errors (from handleTaskFailure) carry a `code`
                  // field and are intended for the user — forward them as-is.
                  // Transport/internal errors (no `code`) are sanitized.
                  const errorData = parsed.data as { code?: string } | undefined
                  if (errorData && typeof errorData.code === 'string') {
                    writeEvent('error', parsed.data)
                  } else {
                    writeEvent('error', { message: sanitizedStreamErrorMessage() })
                  }
                } else if (parsed.event === 'closed') {
                  cleanup('upstream-closed')
                } else {
                  // Forward tool_start, tool_complete, suspended, open events as-is
                  writeEvent(parsed.event, parsed.data)
                }
              }
            }
          } catch (error) {
            if (!closed) {
              console.warn(
                `[RPC_PROXY] host progress stream read failed host=${hostRef} task=${taskId} user=${auth.sub} error=${
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
