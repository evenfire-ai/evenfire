import { Router } from 'express'
import { createMcpHostRefreshRoutes } from './refresh.routes.js'
import { createMcpHostReissueRoutes } from './reissue.routes.js'

export function createMcpHostRenewalRoutes(): Router {
  const router = Router()
  router.use(createMcpHostRefreshRoutes())
  router.use(createMcpHostReissueRoutes())
  return router
}
