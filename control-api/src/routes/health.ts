import { Router } from 'express'
import type { PoolClient } from 'pg'
import { pool } from '../db.js'
import { K8sGateway } from '../k8s.js'

export function createHealthRouter(gateway: K8sGateway): Router {
  const router = Router()

  router.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      namespace: gateway.getNamespace(),
    })
  })

  router.get('/health/notifications', async (_req, res) => {
    const response: {
      status: 'ok' | 'degraded' | 'error'
      dbRead: 'ok' | 'error'
      streamRouteMounted: true
      listenWakeup: 'ok' | 'degraded'
      error?: string
    } = {
      status: 'error',
      dbRead: 'error',
      streamRouteMounted: true,
      listenWakeup: 'degraded',
    }

    let client: PoolClient | null = null
    try {
      client = await pool.connect()
      await client.query('SELECT 1')
      response.dbRead = 'ok'
      try {
        await client.query('LISTEN notification_queued')
        await client.query('UNLISTEN notification_queued')
        response.listenWakeup = 'ok'
      } catch {
        response.listenWakeup = 'degraded'
      }
      response.status = response.listenWakeup === 'ok' ? 'ok' : 'degraded'
      res.status(200).json(response)
    } catch (error) {
      console.warn(
        '[health] notification health check failed:',
        error instanceof Error ? error.message : String(error)
      )
      response.error = 'notification_health_unavailable'
      res.status(503).json(response)
    } finally {
      client?.release()
    }
  })

  return router
}
