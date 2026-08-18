import express, { NextFunction, Request, Response } from 'express'
import cors from 'cors'
import { config } from './config.js'
import {
  sanitizeControlApiPublicError,
  sendPublicApiError,
  sendSanitizedControlApiPublicError,
} from './http/publicApiError.js'
import { requireTrustedBrowserMutation } from './middleware/browserMutationGuard.js'
import { withExternalRequestContext } from './requestContext.js'
import { createAccessRouter } from './routes/access.js'
import { createAuthRouter } from './routes/auth.js'
import { createContextSharedFilesystemsRouter } from './routes/contextSharedFilesystems.js'
import { createDesktopRouter } from './routes/desktop.js'
import { createDirectoryRouter } from './routes/directory.js'
import { createGfsRouter } from './routes/gfs.js'
import { createHealthRouter } from './routes/health.js'
import { createInvitationsRouter } from './routes/invitations.js'
import { createMeRouter } from './routes/me.js'
import { createMembersRouter } from './routes/members.js'
import { createNotificationsRouter } from './routes/notifications.js'
import { createOauthCallbackRouter } from './routes/oauthCallback.js'
import { createOauthGrantsRouter } from './routes/oauthGrants.js'
import { createRpcRouter } from './routes/rpc.js'
import { createRpcDelegationsRouter } from './routes/rpcDelegations.js'
import { createTeamRouter } from './routes/team.js'
import { createUserApprovalDecisionsRouter } from './routes/userApprovalDecisions.js'
import { createWorkflowApprovalMediumsRouter } from './routes/workflowApprovalMediums.js'
import { createExternalWorkflowsRouter } from './routes/workflows.js'

// Upload v2 part bodies are streamed octets and must not pass through the
// global JSON parser (which would buffer/reject the binary payload).
// Match the route shape, not only a valid UUID. Control API owns the UUID
// validation and must receive malformed IDs as upload requests; otherwise a
// binary body can be consumed by the global JSON parser and produce a parser
// error before the canonical 4xx path is reached.
const GFS_UPLOAD_PART_PATH = /^\/api\/v1\/me\/gfs\/uploads\/[^/]+\/parts\/[0-9]+$/i

export function createApp() {
  const app = express()
  // The deployment admits traffic only from the cloudflared ingress namespace
  // (see deploy/base/profiles/networkpolicies.yaml). That single trusted hop
  // overwrites the client address before this process, so req.ip is the stable
  // limiter identity. Direct service exposure would invalidate this contract
  // and must be rejected by deployment policy rather than by accepting a
  // caller-controlled X-Forwarded-For chain here.
  app.set('trust proxy', 1)
  // Capture the proxy-attested client once at the external boundary. The
  // control-api receives it through the authenticated service channel so its
  // non-GFS edge buckets do not collapse every Desktop client onto the funnel
  // pod address.
  app.use(withExternalRequestContext)
  app.use(
    cors({
      origin: config.corsOrigin === '*' ? true : config.corsOrigin,
      credentials: true,
    })
  )
  const jsonBodyParser = express.json({ limit: config.jsonBodyLimit })
  app.use((req, res, next) => {
    if (req.method === 'PUT' && GFS_UPLOAD_PART_PATH.test(req.path)) {
      next()
      return
    }
    jsonBodyParser(req, res, next)
  })
  app.use(requireTrustedBrowserMutation)

  app.use(createHealthRouter())

  const api = express.Router()
  api.use(createAuthRouter())
  api.use(createAccessRouter())
  api.use(createDesktopRouter())
  api.use(createMeRouter())
  api.use(createMembersRouter())
  api.use(createContextSharedFilesystemsRouter())
  api.use(createGfsRouter())
  api.use(createTeamRouter())
  api.use(createInvitationsRouter())
  api.use(createDirectoryRouter())
  api.use(createRpcRouter())
  api.use(createRpcDelegationsRouter())
  api.use(createNotificationsRouter())
  api.use(createUserApprovalDecisionsRouter())
  api.use(createOauthGrantsRouter())
  // PUBLIC (no auth) — provider redirect target; passthrough to control-api.
  api.use(createOauthCallbackRouter())
  api.use(createWorkflowApprovalMediumsRouter())
  api.use(createExternalWorkflowsRouter())
  app.use('/api/v1', api)

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not Found' })
  })

  app.use(externalRestPublicErrorHandler)

  return app
}

export function externalRestPublicErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const rateLimitError = sanitizeControlApiPublicError(err, new Set([429]))
  if (rateLimitError) {
    sendSanitizedControlApiPublicError(res, rateLimitError)
    return
  }

  const status =
    err instanceof Error && typeof (err as Error & { status?: unknown }).status === 'number'
      ? (err as Error & { status: number }).status
      : undefined
  if (status !== undefined && status >= 400 && status < 500) {
    const code =
      status === 401
        ? 'invalid_session'
        : status === 403
          ? 'forbidden'
          : status === 404
            ? 'not_found'
            : status === 429
              ? 'rate_limited'
              : 'invalid_request'
    sendPublicApiError(
      req,
      res,
      status,
      code,
      status === 404
        ? 'The resource was not found.'
        : status === 429
          ? 'Too many requests; retry later.'
          : 'The request could not be completed.',
      status === 429
    )
    return
  }

  if (status === 503) {
    sendPublicApiError(
      req,
      res,
      503,
      'authority_unavailable',
      'Authorization is temporarily unavailable.',
      true
    )
    return
  }

  sendPublicApiError(req, res, 500, 'internal_error', 'The request could not be completed.')
}
