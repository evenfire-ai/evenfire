import { Router } from 'express'
import { K8sGateway } from '../../k8s.js'
import { createMcpHostHostsHeartbeatRoutes } from './hosts-heartbeat.routes.js'
import { createMcpHostPluginWorkloadSdkRoutes } from './plugin-workload-sdk.routes.js'
import { createMcpHostRenewalRoutes } from './renewal/index.js'
import { createUserApprovalRequestsRoutes } from './user-approval-requests.routes.js'
import { createMcpHostWorkflowRoutes } from './workflows/index.js'

export function createMcpHostRoutes(gateway: K8sGateway): Router {
  const router = Router()
  router.use(createMcpHostRenewalRoutes())
  router.use(createUserApprovalRequestsRoutes(gateway))
  router.use(createMcpHostWorkflowRoutes(gateway))
  router.use(createMcpHostPluginWorkloadSdkRoutes())
  router.use(createMcpHostHostsHeartbeatRoutes(gateway))
  return router
}
