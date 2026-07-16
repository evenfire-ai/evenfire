import { Router } from 'express'
import { createAuthMcpHostHeartbeatsRoutes } from './heartbeats.routes.js'
import { createAuthMcpHostIssueRoutes } from './issue.routes.js'

export function createAuthMcpHostRoutes(): Router {
  const router = Router()
  router.use(createAuthMcpHostIssueRoutes())
  router.use(createAuthMcpHostHeartbeatsRoutes())
  return router
}
