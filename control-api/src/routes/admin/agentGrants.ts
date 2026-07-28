import { Router } from 'express'
import type { K8sGateway } from '../../k8s.js'
import type { UiAuthedRequest } from '../../middleware/controlUIAuth.js'
import {
  DeletedAgentHistoryLimitError,
  MAX_DELETED_ACCESS_HISTORY,
  accessValueSetsEqual,
  mergeActiveAgentUpdateWithDeletedHistory,
  partitionAccessValues,
} from '../../services/directory/accessReconciliation.js'
import { AgentGrantPreconditionError } from '../../services/directory/index.js'
import {
  loadAdminActiveAgentNames,
  sendAdminAccessReconciliationError,
} from './accessReconciliationResponse.js'

type AgentGrantSnapshot = { agentNames: string[] } & Record<string, unknown>

export type AgentGrantRouteDefinition = {
  path: string
  idParameter: string
  getCurrent: (id: string) => Promise<AgentGrantSnapshot>
  replace: (
    id: string,
    replacement: string[],
    operatorSub: string,
    expectedCurrent: string[]
  ) => Promise<AgentGrantSnapshot>
}

function readGrantRequest(
  body: unknown
): { agentNames: string[]; expectedCurrent: string[] } | null {
  const value = body && typeof body === 'object' ? (body as Record<string, unknown>) : null
  if (!value || !Object.prototype.hasOwnProperty.call(value, 'expectedCurrentAgentNames'))
    return null
  if (
    !Array.isArray(value.agentNames) ||
    !Array.isArray(value.expectedCurrentAgentNames) ||
    !value.agentNames.every(item => typeof item === 'string') ||
    !value.expectedCurrentAgentNames.every(item => typeof item === 'string')
  ) {
    throw new TypeError('invalid_agent_grant_precondition')
  }
  return { agentNames: value.agentNames, expectedCurrent: value.expectedCurrentAgentNames }
}

export function registerAdminAgentGrantRoutes(
  router: Router,
  gateway: K8sGateway,
  definition: AgentGrantRouteDefinition
): void {
  const getId = (params: Record<string, string | undefined>) =>
    String(params[definition.idParameter] || '')

  router.get(definition.path, async (req, res, next) => {
    try {
      const base = await definition.getCurrent(getId(req.params))
      const partition = partitionAccessValues(
        base.agentNames,
        await loadAdminActiveAgentNames(gateway)
      )
      res.status(200).json({
        ...base,
        agentNames: partition.active,
        deletedAgentNames: partition.deleted,
        deletedHistoryLimit: MAX_DELETED_ACCESS_HISTORY,
      })
    } catch (error) {
      if (sendAdminAccessReconciliationError(res, error)) return
      next(error)
    }
  })

  router.put(definition.path, async (req, res, next) => {
    try {
      const request = readGrantRequest(req.body)
      if (!request) {
        res.status(428).json({ error: 'agent_grant_precondition_required' })
        return
      }

      const id = getId(req.params)
      const [existing, activeAgentNames] = await Promise.all([
        definition.getCurrent(id),
        loadAdminActiveAgentNames(gateway),
      ])
      // This preliminary read supplies deleted-host history only after proving
      // it matches the complete client snapshot. The setter repeats the CAS
      // while holding the table lock, closing both ordinary races and ABA.
      if (!accessValueSetsEqual(existing.agentNames, request.expectedCurrent)) {
        throw new AgentGrantPreconditionError()
      }
      const replacement = mergeActiveAgentUpdateWithDeletedHistory(
        request.agentNames,
        activeAgentNames,
        partitionAccessValues(existing.agentNames, activeAgentNames).deleted
      )
      const updated = await definition.replace(
        id,
        replacement,
        (req as UiAuthedRequest).adminAuth!.sub,
        request.expectedCurrent
      )
      const partition = partitionAccessValues(updated.agentNames, activeAgentNames)
      res.status(200).json({
        ...updated,
        agentNames: partition.active,
        deletedAgentNames: partition.deleted,
        deletedHistoryLimit: MAX_DELETED_ACCESS_HISTORY,
      })
    } catch (error) {
      if (error instanceof TypeError && error.message === 'invalid_agent_grant_precondition') {
        res.status(400).json({ error: 'invalid_agent_grant_precondition' })
        return
      }
      if (error instanceof DeletedAgentHistoryLimitError) {
        res.status(409).json({
          error: 'deleted_agent_history_limit_exceeded',
          deletedHistoryLimit: error.limit,
        })
        return
      }
      if (error instanceof AgentGrantPreconditionError) {
        res.status(412).json({ error: 'precondition_failed' })
        return
      }
      if (sendAdminAccessReconciliationError(res, error)) return
      next(error)
    }
  })
}
