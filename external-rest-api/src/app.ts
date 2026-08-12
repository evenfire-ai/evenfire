import express, { NextFunction, Request, Response } from 'express'
import cors from 'cors'
import { config } from './config.js'
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

// Upload v2 part bodies are streamed octets and must not pass through the
// global JSON parser (which would buffer/reject the binary payload).
const UUID_PATH = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const GFS_UPLOAD_PART_PATH = new RegExp(`^/api/v1/me/gfs/uploads/${UUID_PATH}/parts/[0-9]+$`, 'i')

export function createApp() {
  const app = express()
  app.set('trust proxy', 1)
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
