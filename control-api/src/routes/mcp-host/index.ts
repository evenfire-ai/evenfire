import { Router } from 'express'
import { K8sGateway } from '../../k8s.js'
import type { DirectRunAttributionBindingService } from '../../services/tracing/directRunAttributionBindingService.js'
import { createMcpHostHostsHeartbeatRoutes } from './hosts-heartbeat.routes.js'
import { createMcpHostPluginWorkloadSdkRoutes } from './plugin-workload-sdk.routes.js'
import { createMcpHostRenewalRoutes } from './renewal/index.js'
import { createUserApprovalRequestsRoutes } from './user-approval-requests.routes.js'
import { createMcpHostWorkflowRoutes } from './workflows/index.js'

export function createMcpHostRoutes(
  gateway: K8sGateway,
  directRunAttributionBindingService: DirectRunAttributionBindingService
): Router {
  const router = Router()
  router.use(createMcpHostRenewalRoutes())
  router.use(createUserApprovalRequestsRoutes(gateway, directRunAttributionBindingService))
  router.use(createMcpHostWorkflowRoutes(gateway))
  router.use(createMcpHostPluginWorkloadSdkRoutes())
  router.use(createMcpHostHostsHeartbeatRoutes(gateway))
  return router
}
