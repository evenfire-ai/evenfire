import { Router } from 'express'
import type { K8sGateway } from '../../../k8s.js'
import { createAdminWorkflowGrantRoutes } from './grants.routes.js'
import { createAdminWorkflowReadRoutes } from './read.routes.js'
import { createAdminWorkflowRunsRoutes } from './runs.routes.js'
import { createAdminWorkflowTriggerRoutes } from './trigger.routes.js'

export interface AdminWorkflowRoutesOptions {
  runsStreamAutoCloseMs?: number
  runsStreamKeepAliveMs?: number
}

export function createWorkflowsAdminRouter(
  gateway: K8sGateway,
  options: AdminWorkflowRoutesOptions = {}
): Router {
  const router = Router()
  router.use(createAdminWorkflowRunsRoutes(gateway, options))
  router.use(createAdminWorkflowTriggerRoutes(gateway))
  router.use(createAdminWorkflowGrantRoutes(gateway))
  router.use(createAdminWorkflowReadRoutes(gateway))
  return router
}
