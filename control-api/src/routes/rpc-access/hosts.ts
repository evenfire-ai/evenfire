import { Router } from 'express'
import { config } from '../../config.js'
import { K8sGateway } from '../../k8s.js'
import { rateLimitMiddleware } from '../../middleware/rateLimitMiddleware.js'
import {
  requireRpcTokenHostMatch,
  requireValidRpcAccessTokenAny,
} from '../../middleware/rpcAccessAuth.js'
import { WAKE_REQUESTED_ANNOTATION, executeHostWake } from '../../services/hostWakeAction.js'

export { WAKE_REQUESTED_ANNOTATION }

export function createRpcAccessHostsRouter(gateway: K8sGateway): Router {
  const router = Router()
  router.post(
    '/rpc/hosts/:hostRef/wake',
    requireValidRpcAccessTokenAny(['host:wake:write']),
    requireRpcTokenHostMatch(),
    rateLimitMiddleware({
      bucketType: 'host_wake',
      maxPerMinute: config.hostWakeRlPerMin,
      getBucketKey: req => {
        const hostRef = String(req.params?.hostRef || '').trim()
        return hostRef ? `host-wake:${hostRef}` : null
      },
    }),
    async (req, res, next) => {
      const hostRef = String(req.params.hostRef || '').trim()
      try {
        const result = await executeHostWake(gateway, hostRef)
        if (result.kind === 'unknown') {
          res.status(404).json({ status: 'unknown' })
          return
        }
        if (result.kind === 'not-stateless') {
          res.status(409).json({ status: 'not-stateless' })
          return
        }
        req.log?.info(
          {
            event: 'host_wake_requested',
            hostRef: hostRef.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 253),
            result: result.kind,
            wakeGeneration: result.wakeGeneration,
          },
          'host wake requested'
        )
        if (result.kind === 'active') {
          res.status(200).json({
            status: 'active',
            ...(result.wakeGeneration !== null ? { wakeGeneration: result.wakeGeneration } : {}),
          })
          return
        }
        res.status(202).json({
          status: 'wake-requested',
          wakeGeneration: result.wakeGeneration,
        })
      } catch (error) {
        next(error)
      }
    }
  )
  return router
}
