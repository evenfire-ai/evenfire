import { Router } from 'express'
import { registry } from '../observability/metrics.js'

/**
 * Prometheus scrape endpoint.
 *
 * Exposed WITHOUT authentication because Prometheus scrape traffic is
 * internal to the cluster (NetworkPolicy limits reach; nginx gateway does
 * not forward this path). Matches industry standard for /metrics.
 */
export function createMetricsRouter(): Router {
  const router = Router()

  router.get('/metrics', (_req, res, next) => {
    void (async () => {
      try {
        res.setHeader('Content-Type', registry.contentType)
        const body = await registry.metrics()
        res.status(200).send(body)
      } catch (err) {
        next(err)
      }
    })()
  })

  return router
}
