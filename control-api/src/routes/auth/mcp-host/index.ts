import { Router } from 'express'
import { createAuthMcpHostIssueRoutes } from './issue.routes.js'

export function createAuthMcpHostRoutes(): Router {
  const router = Router()
  router.use(createAuthMcpHostIssueRoutes())
  return router
}
