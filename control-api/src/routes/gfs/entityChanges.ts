import type { Request, Response, Router } from 'express'
import { type UiAuthedRequest, requireAuthForControlUI } from '../../middleware/controlUIAuth.js'
import { authenticateAdminSession } from '../../services/adminSessionAuth.js'
import { CONTROL_UI_ADMIN_SESSION_COOKIE, readCookie } from '../../utils/auth/sessionCookies.js'
import { parseRequestedEntityChangeCursor, streamEntityChanges } from '../entityChangeStream.js'

export function registerGfsEntityChangeRoutes(router: Router): void {
  router.get(
    '/gfs/entity-changes/stream',
    requireAuthForControlUI,
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
        'operator'
      )
    }
  )
}
