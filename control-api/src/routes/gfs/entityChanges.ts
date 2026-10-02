import type { Request, Response, Router } from 'express'
import { ipKeyGenerator } from 'express-rate-limit'
import { config } from '../../config.js'
import { type UiAuthedRequest, requireAuthForControlUI } from '../../middleware/controlUIAuth.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import { authenticateAdminSession } from '../../services/adminSessionAuth.js'
import { CONTROL_UI_ADMIN_SESSION_COOKIE, readCookie } from '../../utils/auth/sessionCookies.js'
import { parseRequestedEntityChangeCursor, streamEntityChanges } from '../entityChangeStream.js'

export function registerGfsEntityChangeRoutes(router: Router): void {
  const ipRateLimit = rateLimitMiddleware({
    bucketType: 'gfs_operator_entity_changes_ip',
    maxPerMinute: config.adminPublicTokenIpRlPerMin,
    getBucketKey: req =>
      `gfs-operator-entity-changes:ip:${ipKeyGenerator(req.ip || req.socket.remoteAddress || 'unknown')}`,
    onBackendUnavailable: 'closed',
  })
  const operatorRateLimit = rateLimitMiddleware({
    bucketType: 'gfs_operator_entity_changes',
    maxPerMinute: config.adminPublicTokenRlPerMin,
    getBucketKey: req =>
      `gfs-operator-entity-changes:operator:${(req as UiAuthedRequest).adminAuth?.sub ?? 'unknown'}`,
    onBackendUnavailable: 'closed',
  })

  router.get(
    '/gfs/entity-changes/stream',
    ipRateLimit,
    requireAuthForControlUI,
    operatorRateLimit,
    (req: Request, res: Response) => {
      const adminReq = req as UiAuthedRequest
      const cursor = parseRequestedEntityChangeCursor(req)
      if (cursor === false) {
        res.status(400).json({ error: 'Invalid entity change cursor' })
        return
      }
      const token = readCookie(req, CONTROL_UI_ADMIN_SESSION_COOKIE)
      streamEntityChanges(
        req,
        res,
        cursor,
        async () => {
          const current = await authenticateAdminSession(token)
          return Boolean(current && current.sub === adminReq.adminAuth?.sub)
        },
        'operator',
        `operator:${adminReq.adminAuth?.sub ?? 'unknown'}`
      )
    }
  )
}
