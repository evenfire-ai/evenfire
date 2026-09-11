import type { NextFunction, Response } from 'express'
import { Router } from 'express'
import {
  controlApiBinaryRequestWithStatus,
  controlApiRequest,
  controlApiRequestWithStatus,
} from '../controlApiClient.js'
import { publicCorrelationId, sanitizeControlApiPublicError } from '../http/publicApiError.js'
import { type AuthedRequest, extractAuthToken, requireAuth } from '../middleware/auth.js'

const PROPAGATED_STATUSES = new Set([400, 403, 404, 409, 410, 422])

function forwardControlApiError(error: unknown, res: Response, next: NextFunction): void {
  const sanitized = sanitizeControlApiPublicError(
    error,
    PROPAGATED_STATUSES,
    publicCorrelationId(res.req)
  )
  if (sanitized) {
    res.status(sanitized.status).json(sanitized.body)
    return
  }
  next(error)
}

export function createExternalWorkflowsRouter(): Router {
  const router = Router()

  router.get(
    '/workflows',
    requireAuth,
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        const sessionToken = extractAuthToken(req)
        const result = await controlApiRequest('GET', '/external/workflows', {
          userSessionToken: sessionToken,
        })
        res.status(200).json(result)
      } catch (error) {
        forwardControlApiError(error, res, next)
      }
    }
  )

  router.get(
    '/workflows/:ns/:name',
    requireAuth,
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        const ns = String(req.params.ns || '').trim()
        const name = String(req.params.name || '').trim()
        if (!ns || !name) {
          res.status(400).json({ error: 'namespace and name are required' })
          return
        }
        const sessionToken = extractAuthToken(req)
        const result = await controlApiRequest(
          'GET',
          `/external/workflows/${encodeURIComponent(ns)}/${encodeURIComponent(name)}`,
          {
            userSessionToken: sessionToken,
          }
        )
        res.status(200).json(result)
      } catch (error) {
        forwardControlApiError(error, res, next)
      }
    }
  )

  router.get(
    '/workflows/:ns/:name/health',
    requireAuth,
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        const ns = String(req.params.ns || '').trim()
        const name = String(req.params.name || '').trim()
        if (!ns || !name) {
          res.status(400).json({ error: 'namespace and name are required' })
          return
        }
        const sessionToken = extractAuthToken(req)
        const result = await controlApiRequest(
          'GET',
          `/external/workflows/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/health`,
          {
            userSessionToken: sessionToken,
          }
        )
        res.status(200).json(result)
      } catch (error) {
        forwardControlApiError(error, res, next)
      }
    }
  )

  router.post(
    '/workflows/:ns/:name/trigger',
    requireAuth,
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        const ns = String(req.params.ns || '').trim()
        const name = String(req.params.name || '').trim()
        if (!ns || !name) {
          res.status(400).json({ error: 'namespace and name are required' })
          return
        }
        const sessionToken = extractAuthToken(req)
        const idempotencyKey = req.headers['idempotency-key'] as string | undefined
        if (!idempotencyKey) {
          res.status(400).json({ error: 'Idempotency-Key header is required' })
          return
        }
        const { data, status } = await controlApiRequestWithStatus(
          'POST',
          `/external/workflows/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/trigger`,
          {
            userSessionToken: sessionToken,
            body: req.body,
            extraHeaders: { 'idempotency-key': idempotencyKey },
          }
        )
        res.status(status).json(data)
      } catch (error) {
        forwardControlApiError(error, res, next)
      }
    }
  )

  router.get(
    '/workflows/:ns/:name/runs',
    requireAuth,
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        const ns = String(req.params.ns || '').trim()
        const name = String(req.params.name || '').trim()
        if (!ns || !name) {
          res.status(400).json({ error: 'namespace and name are required' })
          return
        }
        const sessionToken = extractAuthToken(req)
        const rawLimit = String(req.query?.limit || '').trim()
        const limit = rawLimit ? Number(rawLimit) : 20
        const result = await controlApiRequest(
          'GET',
          `/external/workflows/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/runs`,
          {
            userSessionToken: sessionToken,
            query: { limit: String(limit) },
          }
        )
        res.status(200).json(result)
      } catch (error) {
        forwardControlApiError(error, res, next)
      }
    }
  )

  router.get(
    '/workflows/:ns/:name/runs/:runId/artifacts',
    requireAuth,
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        const ns = String(req.params.ns || '').trim()
        const name = String(req.params.name || '').trim()
        const runId = String(req.params.runId || '').trim()
        if (!ns || !name || !runId) {
          res.status(400).json({ error: 'namespace, name, and runId are required' })
          return
        }
        const sessionToken = extractAuthToken(req)
        const result = await controlApiRequest(
          'GET',
          `/external/workflows/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}/artifacts`,
          {
            userSessionToken: sessionToken,
          }
        )
        res.status(200).json(result)
      } catch (error) {
        forwardControlApiError(error, res, next)
      }
    }
  )

  router.get(
    '/workflows/:ns/:name/runs/:runId/artifacts/:artifactName/download',
    requireAuth,
    async (req: AuthedRequest, res: Response, next: NextFunction) => {
      try {
        const ns = String(req.params.ns || '').trim()
        const name = String(req.params.name || '').trim()
        const runId = String(req.params.runId || '').trim()
        const artifactName = String(req.params.artifactName || '').trim()
        if (!ns || !name || !runId || !artifactName) {
          res.status(400).json({ error: 'namespace, name, runId, and artifactName are required' })
          return
        }
        const sessionToken = extractAuthToken(req)
        const result = await controlApiBinaryRequestWithStatus(
          'GET',
          `/external/workflows/${encodeURIComponent(ns)}/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactName)}/download`,
          {
            userSessionToken: sessionToken,
          }
        )
        res.status(result.status)
        for (const [key, value] of Object.entries(result.headers)) {
          if (value) res.setHeader(key, value)
        }
        res.end(result.body)
      } catch (error) {
        forwardControlApiError(error, res, next)
      }
    }
  )

  return router
}
