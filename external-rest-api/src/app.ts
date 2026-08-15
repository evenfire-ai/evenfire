import express, { NextFunction, Request, Response } from 'express'
import cors from 'cors'
import { config } from './config.js'
import { withExternalRequestContext } from './requestContext.js'
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
  app.use(express.json({ limit: config.jsonBodyLimit }))

  app.use(createHealthRouter())

  const api = express.Router()
  api.use(createAuthRouter())
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

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status =
      err instanceof Error && typeof (err as Error & { status?: unknown }).status === 'number'
        ? (err as Error & { status: number }).status
        : undefined
    if (status !== undefined && status >= 400 && status < 500) {
      res.status(status).json({
        error: err instanceof Error ? err.message : 'Bad Request',
      })
      return
    }

    res.status(500).json({
      error: 'Internal Server Error',
      message: err instanceof Error ? err.message : 'Unknown error',
    })
  })

  return app
}
