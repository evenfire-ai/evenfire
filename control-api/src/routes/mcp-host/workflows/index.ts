import { Router } from 'express'
import type { K8sGateway } from '../../../k8s.js'
import { createMcpHostWorkflowReadRoutes } from './read.routes.js'
import { createMcpHostWorkflowTriggerRoutes } from './trigger.routes.js'

export function createMcpHostWorkflowRoutes(gateway: K8sGateway): Router {
  const router = Router()
  router.use(createMcpHostWorkflowReadRoutes(gateway))
  router.use(createMcpHostWorkflowTriggerRoutes(gateway))
  return router
}
