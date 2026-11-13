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
import { setStreamHeaders } from './streamHeaders.js'

const logger = rootLogger.child({ module: 'entity-change-stream' })
const MAX_BUFFERED_BYTES = 64 * 1024
const BACKPRESSURE_TIMEOUT_MS = 5000
const AUTHORIZATION_RECHECK_MS = 15_000
const ZERO_CURSOR = '00000000-0000-0000-0000-000000000000'
// The only principal left on this stream; kept as a label so existing
// operator series and dashboard filters stay valid.
const PRINCIPAL_KIND = 'operator'

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
const activeEntityChangeStreamsByPrincipal = new Map<string, number>()

export function closeActiveEntityChangeStreams(): void {
  for (const close of Array.from(activeEntityChangeStreams)) close()
}

export function parseRequestedEntityChangeCursor(req: Request): string | null | false {
  const raw = String(req.query?.cursor || '').trim()
  if (!raw) return null
  return isEntityChangeCursor(raw) ? raw : false
}

/**
 * The operator entity-change stream. `isAuthorized` resolves false when the
 * session is no longer current and rejects when that cannot be decided.
 */
export function streamEntityChanges(
  req: Request,
  res: Response,
  initialCursor: string | null,
  isAuthorized: () => Promise<boolean>,
  principalId: string
): void {
  void (async () => {
    let closed = false
    let closing = false
    let polling = false
    let metricsActive = false
    let cursor = initialCursor
    let lastAuthorizationCheck = 0
    let authorizationRetryAfter = 0
    let lastHeartbeat = Date.now()
    let pollTimer: NodeJS.Timeout | null = null
    let heartbeatTimer: NodeJS.Timeout | null = null
    let lifetimeTimer: NodeJS.Timeout | null = null
    let unsubscribeFeedWake: (() => void) | null = null
    let admittedPrincipal: string | null = null
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
      if (admittedPrincipal) {
        const count = activeEntityChangeStreamsByPrincipal.get(admittedPrincipal) ?? 0
        if (count <= 1) activeEntityChangeStreamsByPrincipal.delete(admittedPrincipal)
        else activeEntityChangeStreamsByPrincipal.set(admittedPrincipal, count - 1)
        admittedPrincipal = null
      }
      if (metricsActive) {
        metricsActive = false
        entityChangeStreamConnectionsActive.dec({ principal_kind: PRINCIPAL_KIND })
        if (!closing) {
          entityChangeStreamDisconnectsTotal.inc({
            principal_kind: PRINCIPAL_KIND,
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
          principal_kind: PRINCIPAL_KIND,
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
          principal_kind: PRINCIPAL_KIND,
          frame_type: message.type,
        })
      }
      return drained
    }

    const closeForFailure = async (
      reason: 'max_lifetime' | 'session_expired' | 'server_shutdown' | 'slow_consumer',
      currentCursor = cursor || ZERO_CURSOR
    ) => {
      if (closed || closing) return
      closing = true
      entityChangeStreamDisconnectsTotal.inc({ principal_kind: PRINCIPAL_KIND, reason })
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
          if (Date.now() < authorizationRetryAfter) return
          try {
            if (!(await isAuthorized())) {
              await closeForFailure('session_expired', checkpoint.cursor)
              return
            }
            lastAuthorizationCheck = Date.now()
            authorizationRetryAfter = 0
          } catch (err) {
            // Feed wakes may arrive for every committed change while the auth
            // service is unavailable. Keep the stream fail-closed and retry
            // authorization at a bounded cadence instead of amplifying load.
            authorizationRetryAfter = Date.now() + config.entityChangeStreamPollMs
            throw err
          }
          if (closed) {
            return
          }
        }
        if (checkpoint.resyncRequired) {
          entityChangeStreamResyncRequiredTotal.inc({ principal_kind: PRINCIPAL_KIND })
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
          { event: 'entity_change_stream_poll_failed', principalKind: PRINCIPAL_KIND, err },
          'entity change stream poll failed; polling will retry'
        )
      } finally {
        polling = false
      }
    }

    try {
      // A rejection lands in the catch below, which answers the fixed 500 body.
      if (!(await isAuthorized())) {
        res.status(401).end()
        cleanup()
        return
      }
      if (closed || res.destroyed) return
      const principalConnections = activeEntityChangeStreamsByPrincipal.get(principalId) ?? 0
      if (
        activeEntityChangeStreams.size >= config.entityChangeStreamMaxConnections ||
        principalConnections >= config.entityChangeStreamMaxConnectionsPerPrincipal
      ) {
        res.status(429)
        res.setHeader('retry-after', '5')
        res.json({ error: 'Entity change stream capacity reached' })
        cleanup()
        return
      }
      activeEntityChangeStreamsByPrincipal.set(principalId, principalConnections + 1)
      admittedPrincipal = principalId
      lastAuthorizationCheck = Date.now()
      setStreamHeaders(res)
      unsubscribeFeedWake = subscribeEntityChangeFeedWake(() => void poll())
      activeEntityChangeStreams.add(shutdown)
      entityChangeStreamConnectionsActive.inc({ principal_kind: PRINCIPAL_KIND })
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
        { event: 'entity_change_stream_start_failed', principalKind: PRINCIPAL_KIND, err },
        'stream setup failed'
      )
      if (!res.headersSent) res.status(500).json({ error: 'Entity change stream unavailable' })
      else res.end()
      cleanup()
    }
  })()
}
