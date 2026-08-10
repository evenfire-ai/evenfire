import express, { NextFunction, Request, Response } from 'express'
import cors from 'cors'
import { config } from './config.js'
import { requireTrustedBrowserMutation } from './middleware/browserMutationGuard.js'
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
import { createTeamRouter } from './routes/team.js'
import { createUserApprovalDecisionsRouter } from './routes/userApprovalDecisions.js'
import { createWorkflowApprovalMediumsRouter } from './routes/workflowApprovalMediums.js'
import { createExternalWorkflowsRouter } from './routes/workflows.js'

export function createApp() {
  const app = express()
  app.set('trust proxy', 1)
  app.use(
    cors({
      origin: config.corsOrigin === '*' ? true : config.corsOrigin,
      credentials: true,
    })
  )
  app.use(express.json({ limit: config.jsonBodyLimit }))
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
  const correlationId =
    String(req.header('x-correlation-id') || '').trim() || Math.random().toString(36).slice(2, 12)
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
            : 'invalid_request'
    res.status(status).json({
      error: {
        code,
        message:
          status === 404 ? 'The resource was not found.' : 'The request could not be completed.',
        correlationId,
        retryable: false,
      },
    })
    return
  }

  if (status === 503) {
    res.status(503).json({
      error: {
        code: 'authority_unavailable',
        message: 'Authorization is temporarily unavailable.',
        correlationId,
        retryable: true,
      },
    })
    return
  }

  res.status(500).json({
    error: {
      code: 'internal_error',
      message: 'The request could not be completed.',
      correlationId,
      retryable: false,
    },
  })
}
