import { Request, Response, Router } from 'express'
import { config } from '../../config.js'
import { asyncHandler } from '../../http/asyncHandler.js'
import {
  type ExternalAuthedRequest,
  requireValidExternalSessionToken,
} from '../../middleware/externalSessionAuth.js'
import { mcpHostHttpMetrics } from '../../middleware/mcpHostHttpMetrics.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import { rootLogger } from '../../observability/logger.js'
import {
  notificationStreamConnectionsActive,
  notificationStreamDisconnectsTotal,
  notificationStreamEventsFilteredTotal,
  notificationStreamEventsSentTotal,
  notificationStreamSnapshotSize,
} from '../../observability/metrics.js'
import { scheduleAccessCatalogShadow } from '../../services/access/accessCatalogShadow.js'
import { acknowledgeDesktopNotificationDelivery } from '../../services/notificationAckService.js'
import {
  listActiveApprovalNotificationsForUser,
  listNotificationStreamEventsForUser,
  newestNotificationCursor,
  openNotificationQueueListener,
  parseNotificationCursor,
} from '../../services/notificationStreamService.js'
import {
  getUserNotificationPreferences,
  upsertUserNotificationPreferences,
} from '../../services/userNotificationPreferencesService.js'

const logger = rootLogger.child({ module: 'external-notification-stream' })

type StreamMessage =
  | {
      type: 'notification.snapshot'
      items: unknown[]
      cursor: string | null
      observedAt: string
    }
  | {
      type: 'approval.requested'
      id: string
      cursor: string
      approval: unknown
      observedAt: string
    }
  | {
      type: 'approval.updated'
      id: string
      cursor: string
      approvalRequestId: string
      status: string
      observedAt: string
    }
  | {
      type: 'workflow.run.completed'
      id: string
      cursor: string
      workflowRun: unknown
      observedAt: string
    }
  | {
      type: 'sdk.notification'
      id: string
      cursor: string
      notification: unknown
      observedAt: string
    }
  | {
      type: 'heartbeat'
      observedAt: string
    }
  | {
      type: 'stream.closing'
      reason: string
      observedAt: string
    }

function writeStreamMessage(res: Response, message: StreamMessage): boolean {
  return res.write(`${JSON.stringify(message)}\n`)
}

function setStreamHeaders(res: Response): void {
  res.status(200)
  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('cache-control', 'no-cache, no-transform')
  res.setHeader('connection', 'keep-alive')
  res.setHeader('x-accel-buffering', 'no')
  res.flushHeaders?.()
}

export function createExternalNotificationsRouter(): Router {
  const router = Router()

  router.get(
    '/external/notifications/stream',
    mcpHostHttpMetrics('external_notifications_stream'),
    requireValidExternalSessionToken,
    rateLimitMiddleware({
      bucketType: 'external_user',
      maxPerMinute: config.approvalRlExternalPerMin,
      getBucketKey: req => {
        const extReq = req as ExternalAuthedRequest
        const uid = extReq.externalAuth?.userId
        return uid ? `user:${uid}:notifications` : null
      },
    }),
    (req: Request, res: Response) => {
      void (async () => {
        const extReq = req as ExternalAuthedRequest
        const claims = extReq.externalAuth
        if (!claims) {
          res.status(401).json({ error: 'Unauthorized' })
          return
        }

        const rawCursor = String(req.query?.cursor || '').trim()
        const parsedCursor = rawCursor ? parseNotificationCursor(rawCursor) : null
        if (rawCursor && !parsedCursor) {
          res.status(400).json({ error: 'Invalid notification cursor' })
          return
        }

        let closed = false
        let flushInFlight = false
        let lastCursor: string | null = rawCursor || null
        let listener: Awaited<ReturnType<typeof openNotificationQueueListener>> | null = null
        let heartbeatTimer: NodeJS.Timeout | null = null
        let lifetimeTimer: NodeJS.Timeout | null = null
        let disconnectReason = 'client_closed'
        let connectionCounted = false

        const cleanup = () => {
          if (closed) return
          closed = true
          if (heartbeatTimer) clearInterval(heartbeatTimer)
          if (lifetimeTimer) clearTimeout(lifetimeTimer)
          listener?.removeAllListeners('notification')
          listener?.removeAllListeners('error')
          listener?.release()
          if (connectionCounted) notificationStreamConnectionsActive.dec()
          notificationStreamDisconnectsTotal.inc({ reason: disconnectReason }, 1)
          logger.info(
            {
              event: 'notification_stream_disconnect',
              reason: disconnectReason,
              userId: claims.userId,
              correlationId: req.correlationId ?? null,
            },
            'notification stream disconnected'
          )
        }

        req.on('close', cleanup)
        req.on('aborted', () => {
          disconnectReason = 'client_aborted'
          cleanup()
        })
        res.on('close', cleanup)
        req.setTimeout(0)

        setStreamHeaders(res)
        notificationStreamConnectionsActive.inc()
        connectionCounted = true
        logger.info(
          {
            event: 'notification_stream_connected',
            userId: claims.userId,
            correlationId: req.correlationId ?? null,
          },
          'notification stream connected'
        )

        const flushNewEvents = async () => {
          if (closed || flushInFlight) return
          flushInFlight = true
          try {
            const initialSnapshot = lastCursor === null
            const events = await listNotificationStreamEventsForUser(claims.userId, {
              limit: config.notificationStreamSnapshotLimit,
              after: lastCursor ? parseNotificationCursor(lastCursor) : null,
            })
            const legacyComplete =
              initialSnapshot && events.length < config.notificationStreamSnapshotLimit
            scheduleAccessCatalogShadow({
              session: extReq.externalSessionAuthority,
              family: 'notification',
              legacyLogicalIds: events.map(event => event.id),
              legacyComplete,
            })
            scheduleAccessCatalogShadow({
              session: extReq.externalSessionAuthority,
              family: 'workflow_approval',
              legacyLogicalIds: events.flatMap(event =>
                event.eventType === 'approval.requested' ? [event.approval.id] : []
              ),
              legacyComplete,
            })
            if (events.length === 0) {
              notificationStreamEventsFilteredTotal.inc({ reason: 'no_new_active_events' }, 1)
              return
            }
            for (const event of events) {
              if (closed) break
              if (event.eventType === 'approval.requested') {
                writeStreamMessage(res, {
                  type: 'approval.requested',
                  id: event.id,
                  cursor: event.cursor,
                  approval: event.approval,
                  observedAt: new Date().toISOString(),
                })
              } else if (event.eventType === 'approval.updated') {
                writeStreamMessage(res, {
                  type: 'approval.updated',
                  id: event.id,
                  cursor: event.cursor,
                  approvalRequestId: event.approvalRequestId,
                  status: event.status,
                  observedAt: new Date().toISOString(),
                })
              } else if (event.eventType === 'sdk.notification') {
                writeStreamMessage(res, {
                  type: 'sdk.notification',
                  id: event.id,
                  cursor: event.cursor,
                  notification: event.notification,
                  observedAt: new Date().toISOString(),
                })
              } else {
                writeStreamMessage(res, {
                  type: 'workflow.run.completed',
                  id: event.id,
                  cursor: event.cursor,
                  workflowRun: event.workflowRun,
                  observedAt: new Date().toISOString(),
                })
              }
              lastCursor = event.cursor
              notificationStreamEventsSentTotal.inc({ event_type: event.eventType }, 1)
            }
          } catch (error) {
            disconnectReason = 'stream_error'
            logger.error(
              {
                event: 'notification_stream_flush_failed',
                userId: claims.userId,
                err: error instanceof Error ? error.message : String(error),
                correlationId: req.correlationId ?? null,
              },
              'notification stream flush failed'
            )
            res.end()
            cleanup()
          } finally {
            flushInFlight = false
          }
        }

        try {
          listener = await openNotificationQueueListener()
          listener.on('notification', () => {
            void flushNewEvents()
          })
          listener.on('error', error => {
            notificationStreamEventsFilteredTotal.inc({ reason: 'listen_error' }, 1)
            logger.warn(
              {
                event: 'notification_stream_listen_error',
                userId: claims.userId,
                err: error instanceof Error ? error.message : String(error),
                correlationId: req.correlationId ?? null,
              },
              'notification stream LISTEN degraded'
            )
          })
        } catch (error) {
          notificationStreamEventsFilteredTotal.inc({ reason: 'listen_unavailable' }, 1)
          logger.warn(
            {
              event: 'notification_stream_listen_unavailable',
              userId: claims.userId,
              err: error instanceof Error ? error.message : String(error),
              correlationId: req.correlationId ?? null,
            },
            'notification stream LISTEN unavailable'
          )
        }

        const snapshot = await listActiveApprovalNotificationsForUser(claims.userId, {
          limit: config.notificationStreamSnapshotLimit,
          after: parsedCursor,
        })
        const snapshotCursor = newestNotificationCursor(snapshot, lastCursor)
        notificationStreamSnapshotSize.observe(snapshot.length)
        writeStreamMessage(res, {
          type: 'notification.snapshot',
          items: snapshot.map(event => event.approval),
          cursor: snapshotCursor,
          observedAt: new Date().toISOString(),
        })
        notificationStreamEventsSentTotal.inc({ event_type: 'notification.snapshot' }, 1)
        void flushNewEvents()

        heartbeatTimer = setInterval(() => {
          void flushNewEvents()
          if (closed) return
          writeStreamMessage(res, {
            type: 'heartbeat',
            observedAt: new Date().toISOString(),
          })
          notificationStreamEventsSentTotal.inc({ event_type: 'heartbeat' }, 1)
        }, config.notificationStreamHeartbeatMs)

        lifetimeTimer = setTimeout(() => {
          if (closed) return
          disconnectReason = 'max_lifetime'
          writeStreamMessage(res, {
            type: 'stream.closing',
            reason: 'max_lifetime',
            observedAt: new Date().toISOString(),
          })
          res.end()
          cleanup()
        }, config.notificationStreamMaxLifetimeMs)
      })().catch(error => {
        logger.error(
          {
            event: 'notification_stream_unhandled_error',
            err: error instanceof Error ? error.message : String(error),
            correlationId: req.correlationId ?? null,
          },
          'notification stream failed before setup completed'
        )
        if (!res.headersSent) {
          res.status(500).json({ error: 'Notification stream failed' })
        } else {
          res.end()
        }
      })
    }
  )

  router.post(
    '/external/notifications/:id/ack',
    mcpHostHttpMetrics('external_notification_ack'),
    requireValidExternalSessionToken,
    rateLimitMiddleware({
      bucketType: 'external_user',
      maxPerMinute: config.approvalRlExternalPerMin,
      getBucketKey: req => {
        const extReq = req as ExternalAuthedRequest
        const uid = extReq.externalAuth?.userId
        return uid ? `user:${uid}:notification-ack` : null
      },
    }),
    asyncHandler(async (req: Request, res: Response) => {
      const extReq = req as ExternalAuthedRequest
      const claims = extReq.externalAuth
      if (!claims) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      const result = await acknowledgeDesktopNotificationDelivery(
        claims.userId,
        String(req.params.id || '')
      )
      if (result.status === 'not_found') {
        res.status(404).json({ error: 'notification_not_found' })
        return
      }
      res.status(200).json({ ok: true, status: result.status })
    })
  )

  router.get(
    '/external/me/notification-preferences',
    mcpHostHttpMetrics('external_notification_preferences_get'),
    requireValidExternalSessionToken,
    asyncHandler(async (req: Request, res: Response) => {
      const extReq = req as ExternalAuthedRequest
      const claims = extReq.externalAuth
      if (!claims) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      res.status(200).json(await getUserNotificationPreferences(claims.userId))
    })
  )

  router.put(
    '/external/me/notification-preferences',
    mcpHostHttpMetrics('external_notification_preferences_put'),
    requireValidExternalSessionToken,
    asyncHandler(async (req: Request, res: Response) => {
      const extReq = req as ExternalAuthedRequest
      const claims = extReq.externalAuth
      if (!claims) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      try {
        const body = req.body ?? {}
        res.status(200).json(
          await upsertUserNotificationPreferences(claims.userId, {
            preferredMedium: body.preferredMedium,
            preferredAccountId: body.preferredAccountId,
            channelFallbackEnabled: body.channelFallbackEnabled,
          })
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (
          message === 'invalid_preferred_medium' ||
          message === 'invalid_channel_fallback_enabled' ||
          message === 'preferred_medium_not_verified' ||
          message === 'preferred_account_not_found'
        ) {
          res.status(400).json({ error: message })
          return
        }
        throw error
      }
    })
  )

  return router
}
