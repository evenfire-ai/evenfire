import { Router } from 'express'
import type { NextFunction, Response } from 'express'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ControlApiError, controlApiRequest, controlApiStreamRequest } from '../controlApiClient.js'
import { type AuthedRequest, extractAuthToken, requireAuth } from '../middleware/auth.js'

/**
 * End-user gfs (Global File System) surface — the user side of the delegation UI
 * (Desktop / profile). Pure passthrough on the Session-JWT plane: every route
 * requires the user session (requireAuth) and forwards to control-api
 * `/external/gfs/*` with the user session token. No auth is invented here — the
 * control-api side mints/verifies via the existing JWT scheme. Mirrors
 * `routes/contextSharedFilesystems.ts` + `routes/rpc.ts`.
 */

// 5xx included so control-api's gfsc failure codes reach the desktop verbatim:
// 504 gfsc_timeout, 502 gfsc_unreachable, plus 500/503 forwarded from gfsc. Without
// them forwardControlApiError falls through to the global handler, which collapses
// every 5xx to a generic 500 and the documented codes become unobservable at the
// client (a wedged gfsc looks identical to an internal bug).
const PROPAGATED = new Set([400, 401, 403, 404, 409, 410, 412, 422, 429, 500, 502, 503, 504])
const STREAM_HEADERS = [
  'content-type',
  'content-length',
  'content-disposition',
  'cache-control',
  'upload-offset',
  'upload-length',
  'upload-part-bytes',
  'upload-part-count',
  'upload-active-parts',
  'upload-state',
  'upload-expires',
  'upload-part-number',
  'upload-part-offset',
  'upload-part-length',
  'upload-checksum',
]

function forwardControlApiError(error: unknown, res: Response, next: NextFunction): void {
  if (error instanceof ControlApiError && PROPAGATED.has(error.status)) {
    const body =
      error.body && typeof error.body === 'object' ? error.body : { error: String(error.message) }
    res.status(error.status).json(body)
    return
  }
  next(error)
}

export function createGfsRouter(): Router {
  const router = Router()

  router.use('/me/gfs', requireAuth)

  // Resumable v2 relay. JSON lifecycle calls remain bounded metadata requests;
  // a part PUT passes the IncomingMessage directly to control-api so neither
  // external-rest-api nor control-api materializes the part in memory.
  router.get('/me/gfs/capabilities', (req: AuthedRequest, res, next) => {
    void proxyUploadStream(req, res, next, 'GET', '/external/gfs/capabilities')
  })
  router.post('/me/gfs/uploads', (req: AuthedRequest, res, next) => {
    void proxyUploadStream(req, res, next, 'POST', '/external/gfs/uploads')
  })
  router.head('/me/gfs/uploads/:id', (req: AuthedRequest, res, next) => {
    void proxyUploadStream(
      req,
      res,
      next,
      'HEAD',
      `/external/gfs/uploads/${encodeURIComponent(req.params.id)}`
    )
  })
  router.get('/me/gfs/uploads/:id/status', (req: AuthedRequest, res, next) => {
    void proxyUploadStream(
      req,
      res,
      next,
      'GET',
      `/external/gfs/uploads/${encodeURIComponent(req.params.id)}/status`
    )
  })
  router.put('/me/gfs/uploads/:id/parts/:part', (req: AuthedRequest, res, next) => {
    void proxyUploadStream(
      req,
      res,
      next,
      'PUT',
      `/external/gfs/uploads/${encodeURIComponent(req.params.id)}/parts/${encodeURIComponent(req.params.part)}`
    )
  })
  for (const action of ['pause', 'resume', 'complete'] as const) {
    router.post(`/me/gfs/uploads/:id/${action}`, (req: AuthedRequest, res, next) => {
      void proxyUploadStream(
        req,
        res,
        next,
        'POST',
        `/external/gfs/uploads/${encodeURIComponent(req.params.id)}/${action}`
      )
    })
  }
  router.delete('/me/gfs/uploads/:id', (req: AuthedRequest, res, next) => {
    void proxyUploadStream(
      req,
      res,
      next,
      'DELETE',
      `/external/gfs/uploads/${encodeURIComponent(req.params.id)}`
    )
  })

  router.post('/me/gfs/token', async (req: AuthedRequest, res, next) => {
    try {
      const data = await controlApiRequest('POST', '/external/gfs/token', {
        userSessionToken: extractAuthToken(req),
        body: req.body ?? {},
      })
      res.status(200).json(data)
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  router.get('/me/gfs/resolve', async (req: AuthedRequest, res, next) => {
    try {
      const data = await controlApiRequest('GET', '/external/gfs/resolve', {
        userSessionToken: extractAuthToken(req),
        query: { uri: typeof req.query.uri === 'string' ? req.query.uri : undefined },
      })
      res.status(200).json(data)
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  router.get('/me/gfs/resources', async (req: AuthedRequest, res, next) => {
    try {
      const data = await controlApiRequest('GET', '/external/gfs/resources', {
        userSessionToken: extractAuthToken(req),
        query: {
          drive: typeof req.query.drive === 'string' ? req.query.drive : undefined,
          limit: typeof req.query.limit === 'string' ? req.query.limit : undefined,
          cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
        },
      })
      res.status(200).json(data)
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  router.get('/me/gfs/resources/:id/children', async (req: AuthedRequest, res, next) => {
    try {
      const data = await controlApiRequest(
        'GET',
        `/external/gfs/resources/${encodeURIComponent(req.params.id)}/children`,
        {
          userSessionToken: extractAuthToken(req),
          query: {
            drive: typeof req.query.drive === 'string' ? req.query.drive : undefined,
            limit: typeof req.query.limit === 'string' ? req.query.limit : undefined,
            cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
          },
        }
      )
      res.status(200).json(data)
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  router.get('/me/gfs/resources/:id/affordances', async (req: AuthedRequest, res, next) => {
    try {
      const data = await controlApiRequest(
        'GET',
        `/external/gfs/resources/${encodeURIComponent(req.params.id)}/affordances`,
        {
          userSessionToken: extractAuthToken(req),
          query: { drive: typeof req.query.drive === 'string' ? req.query.drive : undefined },
        }
      )
      res.status(200).json(data)
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  router.patch('/me/gfs/resources/:id', async (req: AuthedRequest, res, next) => {
    try {
      const data = await controlApiRequest(
        'PATCH',
        `/external/gfs/resources/${encodeURIComponent(req.params.id)}`,
        {
          userSessionToken: extractAuthToken(req),
          query: { drive: typeof req.query.drive === 'string' ? req.query.drive : undefined },
          body: req.body ?? {},
        }
      )
      res.status(200).json(data)
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  router.post('/me/gfs/resources/:id/children', async (req: AuthedRequest, res, next) => {
    try {
      const data = await controlApiRequest(
        'POST',
        `/external/gfs/resources/${encodeURIComponent(req.params.id)}/children`,
        {
          userSessionToken: extractAuthToken(req),
          query: { drive: typeof req.query.drive === 'string' ? req.query.drive : undefined },
          body: req.body ?? {},
        }
      )
      res.status(201).json(data)
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  router.put('/me/gfs/resources/:id/content', async (req: AuthedRequest, res, next) => {
    try {
      const data = await controlApiRequest(
        'PUT',
        `/external/gfs/resources/${encodeURIComponent(req.params.id)}/content`,
        {
          userSessionToken: extractAuthToken(req),
          query: { drive: typeof req.query.drive === 'string' ? req.query.drive : undefined },
          body: req.body ?? {},
        }
      )
      res.status(200).json(data)
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  router.delete('/me/gfs/resources/:id', async (req: AuthedRequest, res, next) => {
    try {
      const data = await controlApiRequest(
        'DELETE',
        `/external/gfs/resources/${encodeURIComponent(req.params.id)}`,
        {
          userSessionToken: extractAuthToken(req),
          query: { drive: typeof req.query.drive === 'string' ? req.query.drive : undefined },
          body: req.body ?? {},
        }
      )
      res.status(200).json(data)
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  router.get('/me/gfs/proxy/:rid', async (req: AuthedRequest, res, next) => {
    try {
      const upstream = await controlApiStreamRequest(
        'GET',
        `/external/gfs/proxy/${encodeURIComponent(req.params.rid)}`,
        {
          userSessionToken: extractAuthToken(req),
          query: { drive: typeof req.query.drive === 'string' ? req.query.drive : undefined },
        }
      )
      res.status(upstream.status)
      for (const header of STREAM_HEADERS) {
        const value = upstream.headers.get(header)
        if (value) res.setHeader(header, value)
      }
      if (!upstream.body) {
        res.end()
        return
      }
      await pipeline(
        Readable.fromWeb(
          upstream.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>
        ),
        res
      )
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  // Delegation (folder-owner): grant/share as the user. control-api's
  // assertMayGrant enforces no-escalation against the user's own held bits.
  // The grants list requires manage_acl on the resource (view-ACL = manage-ACL,
  // enforced by control-api's handleGrantListForCaller); its item `id` is what
  // powers per-row revoke in the Manage modal.
  router.get('/me/gfs/grants', async (req: AuthedRequest, res, next) => {
    try {
      const data = await controlApiRequest('GET', '/external/gfs/grants', {
        userSessionToken: extractAuthToken(req),
        query: {
          drive: typeof req.query.drive === 'string' ? req.query.drive : undefined,
          resourceId: typeof req.query.resourceId === 'string' ? req.query.resourceId : undefined,
        },
      })
      res.status(200).json(data)
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  router.put('/me/gfs/grants', async (req: AuthedRequest, res, next) => {
    try {
      const data = await controlApiRequest('PUT', '/external/gfs/grants', {
        userSessionToken: extractAuthToken(req),
        body: req.body ?? {},
      })
      res.status(200).json(data)
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  router.delete('/me/gfs/grants/:id', async (req: AuthedRequest, res, next) => {
    try {
      const data = await controlApiRequest(
        'DELETE',
        `/external/gfs/grants/${encodeURIComponent(req.params.id)}`,
        { userSessionToken: extractAuthToken(req) }
      )
      res.status(200).json(data)
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  router.post('/me/gfs/shares', async (req: AuthedRequest, res, next) => {
    try {
      const data = await controlApiRequest('POST', '/external/gfs/shares', {
        userSessionToken: extractAuthToken(req),
        body: req.body ?? {},
      })
      res.status(200).json(data)
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  router.delete('/me/gfs/shares/:id', async (req: AuthedRequest, res, next) => {
    try {
      const data = await controlApiRequest(
        'DELETE',
        `/external/gfs/shares/${encodeURIComponent(req.params.id)}`,
        { userSessionToken: extractAuthToken(req) }
      )
      res.status(200).json(data)
    } catch (error) {
      forwardControlApiError(error, res, next)
    }
  })

  return router
}

async function proxyUploadStream(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE',
  path: string
): Promise<void> {
  try {
    const extraHeaders: Record<string, string> = {}
    for (const name of [
      'content-type',
      'upload-part-number',
      'upload-offset',
      'upload-chunk-length',
      'upload-checksum',
    ]) {
      const value = req.headers[name]
      if (typeof value === 'string') extraHeaders[name] = value
    }
    const isPart = method === 'PUT' && /\/parts\/[0-9]+$/.test(path)
    const body =
      method === 'GET' || method === 'HEAD'
        ? undefined
        : isPart
          ? req
          : JSON.stringify(req.body ?? {})
    const upstream = await controlApiStreamRequest(method, path, {
      userSessionToken: extractAuthToken(req),
      // Preserve the bounded status cursor contract across the relay.  Dropping
      // these query parameters makes every resume request fetch page one and
      // can silently truncate a session with more than 256 parts.
      query: {
        drive: typeof req.query.drive === 'string' ? req.query.drive : undefined,
        limit: typeof req.query.limit === 'string' ? req.query.limit : undefined,
        cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      },
      extraHeaders,
      body,
    })
    res.status(upstream.status)
    for (const header of STREAM_HEADERS) {
      const value = upstream.headers.get(header)
      if (value) res.setHeader(header, value)
    }
    if (!upstream.body) {
      res.end()
      return
    }
    await pipeline(
      Readable.fromWeb(
        upstream.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>
      ),
      res
    )
  } catch (error) {
    forwardControlApiError(error, res, next)
  }
}
