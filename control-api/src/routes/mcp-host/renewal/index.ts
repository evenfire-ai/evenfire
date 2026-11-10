import { Router } from 'express'
import type { RenewalHostGateway } from './hostBinding.js'
import { createMcpHostRefreshRoutes } from './refresh.routes.js'
import { createMcpHostReissueRoutes } from './reissue.routes.js'

export function createMcpHostRenewalRoutes(gateway: RenewalHostGateway): Router {
  const router = Router()
  router.use(createMcpHostRefreshRoutes(gateway))
  router.use(createMcpHostReissueRoutes(gateway))
  return router
}
