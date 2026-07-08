import { Router } from 'express'
import type { K8sGateway } from '../../../k8s.js'
import { createExternalWorkflowReadRoutes } from './read.routes.js'
import { createExternalWorkflowRunsRoutes } from './runs.routes.js'
import { createExternalWorkflowTriggerRoutes } from './trigger.routes.js'

export function createExternalWorkflowsRouter(gateway: K8sGateway): Router {
  const router = Router()
  router.use(createExternalWorkflowReadRoutes(gateway))
  router.use(createExternalWorkflowRunsRoutes(gateway))
  router.use(createExternalWorkflowTriggerRoutes(gateway))
  return router
}
