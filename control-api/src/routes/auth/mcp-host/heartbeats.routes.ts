import { Router } from 'express'
import { requireInternalControlJwt } from '../../../middleware/internalControlJwt.js'
import { mcpHostHttpMetrics } from '../../../middleware/mcpHostHttpMetrics.js'
import { listHostHeartbeatsSince } from '../../../services/hostHeartbeatService.js'

/**
 * Internal heartbeat feed for HCC's lifecycle poller.
 *
 * `GET /api/v1/auth/mcp-host/heartbeats?since=<epoch_ms>` — InternalControl
 * JWT only, issuer `hcc` (WRC provisions recipes and has no business reading
 * 1st-party host lifecycle data). Returns the rows the /mcp-host facade
 * ingested with `received_at > since`, oldest first, so the poller can apply
 * them to the StatelessLifecycleTracker in arrival order.
 */
export function createAuthMcpHostHeartbeatsRoutes(): Router {
  const router = Router()

  router.get(
    '/auth/mcp-host/heartbeats',
    mcpHostHttpMetrics('auth_mcp_host_heartbeats'),
    requireInternalControlJwt,
    (req, res, next) => {
      void (async () => {
        try {
          const provisioner = req.internalControl!
          if (provisioner.iss !== 'hcc') {
            req.log?.info(
              {
                event: 'auth_denied',
                reason: 'issuer_not_allowed',
                route: 'auth_mcp_host_heartbeats',
                iss: provisioner.iss,
                sub: provisioner.sub,
              },
              'non-hcc issuer on /auth/mcp-host/heartbeats'
            )
            return res.status(403).json({ error: 'issuer_not_allowed' })
          }

          const rawSince = req.query.since
          const since =
            typeof rawSince === 'string' && /^\d+$/.test(rawSince) ? Number(rawSince) : NaN
          if (!Number.isSafeInteger(since) || since < 0) {
            return res.status(400).json({
              error: 'since_required',
              message: 'since must be a non-negative epoch-milliseconds integer',
            })
          }

          const heartbeats = await listHostHeartbeatsSince(since)
          return res.status(200).json({ heartbeats })
        } catch (err) {
          next(err)
        }
      })()
    }
  )

  return router
}
