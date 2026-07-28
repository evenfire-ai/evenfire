import { Router } from 'express'
import type { K8sGateway } from '../../k8s.js'
import type { UiAuthedRequest } from '../../middleware/controlUIAuth.js'
import {
  mergeActiveUpdateWithDeletedHistory,
  partitionAccessValues,
} from '../../services/directory/accessReconciliation.js'
import { getUserAgents, getUserContexts, setUserAgents, setUserContexts } from '../../services/directory/index.js'
import {
  loadAdminActiveContextIds,
  sendAdminAccessReconciliationError,
} from './accessReconciliationResponse.js'
import { registerAdminAgentGrantRoutes } from './agentGrants.js'

export function registerAdminUserAccessRoutes(router: Router, gateway: K8sGateway): void {
  router.get('/admin/users/:userId/contexts', async (req, res, next) => {
    try {
      const base = await getUserContexts(req.params.userId)
      const partition = partitionAccessValues(base.contextIds, await loadAdminActiveContextIds(gateway))
      res.status(200).json({ ...base, contextIds: partition.active, deletedContextIds: partition.deleted })
    } catch (error) {
      if (sendAdminAccessReconciliationError(res, error)) return
      next(error)
    }
  })

  router.put('/admin/users/:userId/contexts', async (req, res, next) => {
    try {
      const contextIds = Array.isArray(req.body?.contextIds) ? req.body.contextIds.map(String) : []
      const [existing, activeContextIds] = await Promise.all([
        getUserContexts(req.params.userId),
        loadAdminActiveContextIds(gateway),
      ])
      const updated = await setUserContexts(
        req.params.userId,
        mergeActiveUpdateWithDeletedHistory(
          contextIds,
          activeContextIds,
          partitionAccessValues(existing.contextIds, activeContextIds).deleted
        ),
        (req as UiAuthedRequest).adminAuth!.sub
      )
      const partition = partitionAccessValues(updated.contextIds, activeContextIds)
      res.status(200).json({ ...updated, contextIds: partition.active, deletedContextIds: partition.deleted })
    } catch (error) {
      if (sendAdminAccessReconciliationError(res, error)) return
      next(error)
    }
  })

  registerAdminAgentGrantRoutes(router, gateway, {
    path: '/admin/users/:userId/agents',
    idParameter: 'userId',
    getCurrent: getUserAgents,
    replace: setUserAgents,
  })
}
