import type { NextFunction, Response } from 'express'
import { Router } from 'express'
import { ControlApiError, controlApiRequest, controlApiStreamRequest } from '../controlApiClient.js'
import { type AuthedRequest, extractAuthToken, requireAuth } from '../middleware/auth.js'

/**
 * Read-only end-user access to SharedFileSystems referenced by a Context.
 * Mirrors the control-api `/external/contexts/:id/shared-filesystems` router.
 *
 *   GET  /api/v1/me/contexts/:contextId/shared-filesystems
 *   GET  /api/v1/me/contexts/:contextId/shared-filesystems/:sfsName/proxy/*
 *
 * Anything but GET/HEAD is rejected at this layer too — defense in depth, so
 * a misconfigured client cannot even attempt an upload through here.
 */
export type ContextSharedFilesystemSummary = {
  name: string
  mountPath: string
  phase: string | null
  pvcName: string | null
  message: string | null
}

const PROPAGATED_STATUSES = new Set([400, 403, 404, 409, 410, 422])
const PASSTHROUGH_HEADERS = [
  'retry-after',
  'ratelimit',
  'ratelimit-policy',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-request-id',
] as const

function forwardControlApiError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof ControlApiError && PROPAGATED_STATUSES.has(error.status)) {
    const body =
      error.body && typeof error.body === 'object' ? error.body : { error: String(error.message) }
    res.status(error.status).json(body)
    return
  }
  next(error)
}

export function createContextSharedFilesystemsRouter(): Router {
  const router = Router()

  router.use(
    '/me/contexts/:contextId/shared-filesystems',
    requireAuth,
    (req: AuthedRequest, res, next) => {
      if (req.method === 'GET' || req.method === 'HEAD') {
        next()
        return
      }
      res.setHeader('Allow', 'GET, HEAD')
      res.status(405).json({ error: 'Method Not Allowed' })
    }
  )

  router.get(
    '/me/contexts/:contextId/shared-filesystems',
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        const sessionToken = extractAuthToken(req)
        const data = await controlApiRequest<{ items: ContextSharedFilesystemSummary[] }>(
          'GET',
          `/external/contexts/${encodeURIComponent(req.params.contextId)}/shared-filesystems`,
          { userSessionToken: sessionToken }
        )
        res.status(200).json(data)
      } catch (error) {
        forwardControlApiError(error, res, next)
      }
    }
  )

  router.get(
    '/me/contexts/:contextId/shared-filesystems/:sfsName/proxy/*',
    async (req: AuthedRequest, res, next) => {
      try {
        const sessionToken = extractAuthToken(req)
        const subPath = req.params[0] ? `/${req.params[0]}` : '/'
        const queryString = (() => {
          const idx = req.originalUrl.indexOf('?')
          return idx === -1 ? '' : req.originalUrl.slice(idx)
        })()
        const upstreamRes = await controlApiStreamRequest(
          'GET',
          `/external/contexts/${encodeURIComponent(req.params.contextId)}` +
            `/shared-filesystems/${encodeURIComponent(req.params.sfsName)}/proxy${subPath}${queryString}`,
          {
            userSessionToken: sessionToken,
            throwOnHttpError: false,
          }
        )

        res.status(upstreamRes.status)
        for (const name of PASSTHROUGH_HEADERS) {
          const value = upstreamRes.headers.get(name)
          if (value) res.setHeader(name, value)
        }
        const ct = upstreamRes.headers.get('content-type')
        if (ct) res.setHeader('content-type', ct)
        const cd = upstreamRes.headers.get('content-disposition')
        if (cd) res.setHeader('content-disposition', cd)
        const cl = upstreamRes.headers.get('content-length')
        if (cl) res.setHeader('content-length', cl)

        if (!upstreamRes.body) {
          res.end()
          return
        }
        const reader = upstreamRes.body.getReader()
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (value) res.write(Buffer.from(value))
          }
          res.end()
        } catch {
          if (!res.headersSent) res.status(502).json({ error: 'upstream error' })
          else res.end()
        }
      } catch (error) {
        next(error)
      }
    }
  )

  return router
}
