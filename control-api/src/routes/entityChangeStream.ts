import type { Request, Response } from 'express'
import { config } from '../config.js'
import { rootLogger } from '../observability/logger.js'
import {
  entityChangeStreamConnectionsActive,
  entityChangeStreamDisconnectsTotal,
  entityChangeStreamFramesSentTotal,
  entityChangeStreamResyncRequiredTotal,
} from '../observability/metrics.js'
import {
  type EntityChangeScope,
  isEntityChangeCursor,
  readEntityChangeCheckpoint,
  subscribeEntityChangeFeedWake,
} from '../services/entityChangeService.js'

const logger = rootLogger.child({ module: 'entity-change-stream' })
const MAX_BUFFERED_BYTES = 64 * 1024
const BACKPRESSURE_TIMEOUT_MS = 5000
const AUTHORIZATION_RECHECK_MS = 15_000

type EntityChangeStreamMessage =
  | {
      schemaVersion: 1
      type: 'resync_required'
      cursor: string
      scopes: EntityChangeScope[]
    }
  | {
      schemaVersion: 1
      type: 'scope.invalidated'
      cursor: string
      scopes: EntityChangeScope[]
    }
  | { schemaVersion: 1; type: 'heartbeat'; cursor: string; observedAt: string }
  | {
      schemaVersion: 1
      type: 'stream.closing'
      cursor: string
      reason: 'max_lifetime' | 'session_expired' | 'server_shutdown' | 'slow_consumer'
    }

const activeEntityChangeStreams = new Set<() => void>()

export function closeActiveEntityChangeStreams(): void {
  for (const close of Array.from(activeEntityChangeStreams)) close()
}

export function parseRequestedEntityChangeCursor(req: Request): string | null | false {
  const raw = String(req.query?.cursor || '').trim()
  if (!raw) return null
  return isEntityChangeCursor(raw) ? raw : false
}

function setStreamHeaders(res: Response): void {
  res.status(200)
  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('cache-control', 'no-cache, no-transform')
  res.setHeader('connection', 'keep-alive')
  res.setHeader('x-accel-buffering', 'no')
  res.flushHeaders?.()
}

export function streamEntityChanges(
  req: Request,
  res: Response,
  initialCursor: string | null,
  isAuthorized: () => Promise<boolean>,
  principalKind: 'user' | 'operator'
): void {
  void (async () => {
    let closed = false
    let closing = false
    let polling = false
    let metricsActive = false
    let cursor = initialCursor
    let lastAuthorizationCheck = 0
    let lastHeartbeat = Date.now()
    let pollTimer: NodeJS.Timeout | null = null
    let heartbeatTimer: NodeJS.Timeout | null = null
    let lifetimeTimer: NodeJS.Timeout | null = null
    let unsubscribeFeedWake: (() => void) | null = null
    let shutdown = () => undefined

    const cleanup = () => {
      if (closed) return
      closed = true
      if (pollTimer) clearInterval(pollTimer)
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      if (lifetimeTimer) clearTimeout(lifetimeTimer)
      unsubscribeFeedWake?.()
      unsubscribeFeedWake = null
      activeEntityChangeStreams.delete(shutdown)
      if (metricsActive) {
        metricsActive = false
        entityChangeStreamConnectionsActive.dec({ principal_kind: principalKind })
        if (!closing) {
          entityChangeStreamDisconnectsTotal.inc({
            principal_kind: principalKind,
            reason: 'client_disconnect',
          })
        }
      }
    }

    req.on('aborted', cleanup)
    res.on('close', cleanup)
    req.setTimeout(0)

    const write = async (message: EntityChangeStreamMessage): Promise<boolean> => {
      if (closed || res.destroyed) return false
      const frame = `${JSON.stringify(message)}\n`
      if (res.writableLength + Buffer.byteLength(frame) > MAX_BUFFERED_BYTES) return false
      if (res.write(frame)) {
        entityChangeStreamFramesSentTotal.inc({
          principal_kind: principalKind,
          frame_type: message.type,
        })
        return true
      }
      const drained = await new Promise<boolean>(resolve => {
        let settled = false
        const finish = (writable: boolean) => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          res.off('drain', onDrain)
          res.off('close', onClose)
          resolve(writable)
        }
        const onDrain = () => finish(true)
        const onClose = () => finish(false)
        const timeout = setTimeout(() => finish(false), BACKPRESSURE_TIMEOUT_MS)
        res.once('drain', onDrain)
        res.once('close', onClose)
      })
      if (drained) {
        entityChangeStreamFramesSentTotal.inc({
          principal_kind: principalKind,
          frame_type: message.type,
        })
      }
      return drained
    }

    const closeForFailure = async (
      reason: 'max_lifetime' | 'session_expired' | 'server_shutdown' | 'slow_consumer',
      currentCursor = cursor || '00000000-0000-0000-0000-000000000000'
    ) => {
      if (closed || closing) return
      closing = true
      entityChangeStreamDisconnectsTotal.inc({ principal_kind: principalKind, reason })
      await write({ schemaVersion: 1, type: 'stream.closing', cursor: currentCursor, reason })
      res.end()
      cleanup()
    }
    shutdown = () => void closeForFailure('server_shutdown')

    const poll = async () => {
      if (closed || closing || polling) return
      polling = true
      try {
        const checkpoint = await readEntityChangeCheckpoint(cursor)
        const hasChange = checkpoint.resyncRequired || checkpoint.scopes.length > 0
        if (hasChange || Date.now() - lastAuthorizationCheck >= AUTHORIZATION_RECHECK_MS) {
          if (!(await isAuthorized())) {
            await closeForFailure('session_expired', checkpoint.cursor)
            return
          }
          lastAuthorizationCheck = Date.now()
        }
        if (checkpoint.resyncRequired) {
          entityChangeStreamResyncRequiredTotal.inc({ principal_kind: principalKind })
          if (
            !(await write({
              schemaVersion: 1,
              type: 'resync_required',
              cursor: checkpoint.cursor,
              scopes: ['gfs', 'authorization'],
            }))
          ) {
            await closeForFailure('slow_consumer', cursor || checkpoint.cursor)
            return
          }
          cursor = checkpoint.cursor
        } else if (checkpoint.scopes.length > 0) {
          if (
            !(await write({
              schemaVersion: 1,
              type: 'scope.invalidated',
              cursor: checkpoint.cursor,
              scopes: checkpoint.scopes,
            }))
          ) {
            await closeForFailure('slow_consumer', cursor || checkpoint.cursor)
            return
          }
          cursor = checkpoint.cursor
        }
        if (Date.now() - lastHeartbeat >= config.entityChangeStreamHeartbeatMs) {
          if (
            !(await write({
              schemaVersion: 1,
              type: 'heartbeat',
              cursor: checkpoint.cursor,
              observedAt: new Date().toISOString(),
            }))
          ) {
            await closeForFailure('slow_consumer', checkpoint.cursor)
            return
          }
          cursor = checkpoint.cursor
          lastHeartbeat = Date.now()
        }
      } catch (err) {
        logger.warn(
          { event: 'entity_change_stream_poll_failed', principalKind, err },
          'entity change stream poll failed; polling will retry'
        )
      } finally {
        polling = false
      }
    }

    try {
      if (!(await isAuthorized())) {
        res.status(401).end()
        cleanup()
        return
      }
      if (closed || res.destroyed) return
      lastAuthorizationCheck = Date.now()
      setStreamHeaders(res)
      unsubscribeFeedWake = subscribeEntityChangeFeedWake(() => void poll())
      activeEntityChangeStreams.add(shutdown)
      entityChangeStreamConnectionsActive.inc({ principal_kind: principalKind })
      metricsActive = true
      await poll()
      if (closed) return
      pollTimer = setInterval(() => void poll(), config.entityChangeStreamPollMs)
      heartbeatTimer = setInterval(() => void poll(), config.entityChangeStreamHeartbeatMs)
      lifetimeTimer = setTimeout(
        () => void closeForFailure('max_lifetime'),
        config.entityChangeStreamMaxLifetimeMs
      )
    } catch (err) {
      logger.error(
        { event: 'entity_change_stream_start_failed', principalKind, err },
        'stream setup failed'
      )
      if (!res.headersSent) res.status(500).json({ error: 'Entity change stream unavailable' })
      else res.end()
      cleanup()
    }
  })()
}
