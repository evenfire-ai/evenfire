import type { NextFunction, Response } from 'express'
import { Router } from 'express'
import { controlApiStreamRequest } from '../controlApiClient.js'
import { type AuthedRequest, extractAuthToken, requireAuth } from '../middleware/auth.js'

function setStreamHeaders(res: Response): void {
  res.status(200)
  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8')
  res.setHeader('cache-control', 'no-cache, no-transform')
  res.setHeader('connection', 'keep-alive')
  res.setHeader('x-accel-buffering', 'no')
  res.flushHeaders?.()
}

export function createNotificationsRouter(): Router {
  const router = Router()

  router.get('/notifications/stream', requireAuth, async (req: AuthedRequest, res, next) => {
    const abortController = new AbortController()
    const onClose = () => abortController.abort()
    req.on('close', onClose)
    req.on('aborted', onClose)

    try {
      const sessionToken = extractAuthToken(req)
      const cursor = String(req.query?.cursor || '').trim()
      const upstream = await controlApiStreamRequest('GET', '/external/notifications/stream', {
        query: cursor ? { cursor } : undefined,
        userSessionToken: sessionToken,
        signal: abortController.signal,
      })

      if (!upstream.body) {
        res.status(502).json({ error: 'Notification stream unavailable' })
        return
      }

      setStreamHeaders(res)
      const reader = upstream.body.getReader()
      try {
        while (!abortController.signal.aborted) {
          const { done, value } = await reader.read()
          if (done) break
          if (value) {
            res.write(Buffer.from(value))
          }
        }
      } finally {
        reader.releaseLock()
        res.end()
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        res.end()
        return
      }
      next(error)
    } finally {
      req.off('close', onClose)
      req.off('aborted', onClose)
    }
  })

  router.post('/notifications/:id/ack', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const sessionToken = extractAuthToken(req)
      const notificationId = String(req.params.id || '').trim()
      const { controlApiRequest } = await import('../controlApiClient.js')
      const result = await controlApiRequest(
        'POST',
        `/external/notifications/${encodeURIComponent(notificationId)}/ack`,
        { userSessionToken: sessionToken }
      )
      res.status(200).json(result)
    } catch (error) {
      next(error)
    }
  })

  router.get('/me/notification-preferences', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const sessionToken = extractAuthToken(req)
      const { controlApiRequest } = await import('../controlApiClient.js')
      const result = await controlApiRequest('GET', '/external/me/notification-preferences', {
        userSessionToken: sessionToken,
      })
      res.status(200).json(result)
    } catch (error) {
      next(error)
    }
  })

  router.put('/me/notification-preferences', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const sessionToken = extractAuthToken(req)
      const { controlApiRequest } = await import('../controlApiClient.js')
      const result = await controlApiRequest('PUT', '/external/me/notification-preferences', {
        userSessionToken: sessionToken,
        body: req.body ?? {},
      })
      res.status(200).json(result)
    } catch (error) {
      next(error)
    }
  })

  return router
}
