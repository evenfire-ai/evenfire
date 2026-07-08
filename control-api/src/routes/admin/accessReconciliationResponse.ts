import type { K8sGateway } from '../../k8s.js'
import {
  listActiveAgentNames,
  listActiveContextIds,
} from '../../services/directory/accessReconciliation.js'

type JsonResponse = {
  status: (code: number) => { json: (body: unknown) => unknown }
}

class AdminAccessReconciliationError extends Error {
  kind: 'agent' | 'context'

  constructor(kind: 'agent' | 'context', cause: unknown) {
    super(`${kind} reconciliation unavailable`)
    this.name = 'AdminAccessReconciliationError'
    this.kind = kind
    this.cause = cause
  }
}

export async function loadAdminActiveAgentNames(gateway: K8sGateway): Promise<string[]> {
  try {
    return await listActiveAgentNames(gateway)
  } catch (error) {
    throw new AdminAccessReconciliationError('agent', error)
  }
}

export async function loadAdminActiveContextIds(gateway: K8sGateway): Promise<string[]> {
  try {
    return await listActiveContextIds(gateway)
  } catch (error) {
    throw new AdminAccessReconciliationError('context', error)
  }
}

export function sendAdminAccessReconciliationError(res: JsonResponse, error: unknown): boolean {
  if (!(error instanceof AdminAccessReconciliationError)) return false
  res.status(503).json({
    error:
      error.kind === 'context'
        ? 'context_reconciliation_unavailable'
        : 'agent_reconciliation_unavailable',
  })
  return true
}
