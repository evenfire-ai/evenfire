import { Router } from 'express'
import { K8sGateway } from '../../k8s.js'
import type { DirectRunAttributionBindingService } from '../../services/tracing/directRunAttributionBindingService.js'
import { createRpcAccessHostsRouter } from './hosts.js'
import { createRpcAccessTeamsRouter } from './teams.js'
import { createRpcAccessUsersRouter } from './users.js'

export function createRpcAccessRouter(
  gateway: K8sGateway,
  bindingService: Pick<DirectRunAttributionBindingService, 'bind'>
): Router {
  const router = Router()
  router.use(createRpcAccessUsersRouter(gateway, { bindingService }))
  router.use(createRpcAccessTeamsRouter())
  router.use(createRpcAccessHostsRouter(gateway))

  return router
}
