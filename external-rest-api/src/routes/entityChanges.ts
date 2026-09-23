import { type NextFunction, type Response, Router } from 'express'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ControlApiError, controlApiStreamRequest } from '../controlApiClient.js'
import { type AuthedRequest, extractAuthToken, requireAuth } from '../middleware/auth.js'

function forwardError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof ControlApiError && error.status >= 400 && error.status <= 599) {
    const body =
      error.status < 500 && error.body && typeof error.body === 'object'
        ? error.body
        : { error: 'Entity change stream unavailable' }
    for (const [name, value] of Object.entries(error.headers)) res.setHeader(name, value)
    res.status(error.status).json(body)
    return
  }
  next(error)
}

export function createEntityChangesRouter(): Router {
  const router = Router()
  router.get('/entity-changes/stream', requireAuth, async (req: AuthedRequest, res, next) => {
    const abortController = new AbortController()
    const abort = () => abortController.abort()
    req.on('aborted', abort)
    const abortIfPremature = () => {
      if (!res.writableEnded) abort()
    }
    res.on('close', abortIfPremature)
    try {
      const cursor = String(req.query?.cursor || '').trim()
      const upstream = await controlApiStreamRequest('GET', '/external/entity-changes/stream', {
        query: cursor ? { cursor } : undefined,
        userSessionToken: extractAuthToken(req),
        signal: abortController.signal,
      })
      if (!upstream.body) {
        res.status(502).json({ error: 'Entity change stream unavailable' })
        return
      }
      res.status(upstream.status)
      res.setHeader(
        'content-type',
        upstream.headers.get('content-type') || 'application/x-ndjson; charset=utf-8'
      )
      res.setHeader(
        'cache-control',
        upstream.headers.get('cache-control') || 'no-cache, no-transform'
      )
      res.setHeader('connection', 'keep-alive')
      res.setHeader('x-accel-buffering', 'no')
      const requestId = upstream.headers.get('x-request-id')
      if (requestId) res.setHeader('x-request-id', requestId)
      res.flushHeaders?.()
      await pipeline(
        Readable.fromWeb(
          upstream.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>
        ),
        res,
        { signal: abortController.signal }
      )
    } catch (error) {
      if (abortController.signal.aborted || res.destroyed) return
      forwardError(error, res, next)
    } finally {
      req.off('aborted', abort)
      res.off('close', abortIfPremature)
    }
  })
  return router
}
