/**
 * Execution history manager for scheduled workflows.
 *
 * Prunes old child WorkflowRecipe CRDs based on successfulHistoryLimit
 * and failedHistoryLimit. Only deletes children in terminal phases.
 * */
import * as k8s from '@kubernetes/client-node'
import {
  CRD_GROUP,
  CRD_VERSION,
  WORKFLOWRECIPE_PLURAL,
  WORKFLOW_TERMINAL_PHASES,
} from '../reconciler/crdConstants'

export interface HistoryLimits {
  successfulHistoryLimit: number
  failedHistoryLimit: number
}

interface ChildRecipe {
  metadata: { name: string; namespace: string; creationTimestamp?: string }
  status?: { workflowExecution?: { phase?: string } }
}

function byCreationTimestampAscending(a: ChildRecipe, b: ChildRecipe): number {
  const ta = a.metadata.creationTimestamp ?? ''
  const tb = b.metadata.creationTimestamp ?? ''
  return ta < tb ? -1 : ta > tb ? 1 : 0
}

export async function listChildren(
  customApi: k8s.CustomObjectsApi,
  parentName: string,
  namespace: string
): Promise<ChildRecipe[]> {
  const result = (await customApi.listNamespacedCustomObject({
    group: CRD_GROUP,
    version: CRD_VERSION,
    namespace,
    plural: WORKFLOWRECIPE_PLURAL,
    labelSelector: `clerum.io/parent-recipe=${parentName},clerum.io/scheduled=true`,
  })) as { items?: ChildRecipe[] }
  return result.items ?? []
}

export async function pruneHistory(
  customApi: k8s.CustomObjectsApi,
  parentName: string,
  namespace: string,
  limits: HistoryLimits
): Promise<string[]> {
  const children = await listChildren(customApi, parentName, namespace)

  const successful = children
    .filter(c => c.status?.workflowExecution?.phase === 'completed')
    .sort(byCreationTimestampAscending)

  // Merge failed and cancelled into one list governed by failedHistoryLimit.
  // Applying the cap independently would allow failed+cancelled to each retain
  // failedHistoryLimit entries, doubling the effective retention (e.g., 2 instead of 1).
  const nonSuccessful = children
    .filter(c => {
      const phase = c.status?.workflowExecution?.phase
      return phase === 'failed' || phase === 'cancelled'
    })
    .sort(byCreationTimestampAscending)

  const toDelete = [
    ...successful.slice(0, Math.max(0, successful.length - limits.successfulHistoryLimit)),
    ...nonSuccessful.slice(0, Math.max(0, nonSuccessful.length - limits.failedHistoryLimit)),
  ]

  const deletedNames: string[] = []
  for (const child of toDelete) {
    try {
      await customApi.deleteNamespacedCustomObject({
        group: CRD_GROUP,
        version: CRD_VERSION,
        namespace,
        plural: WORKFLOWRECIPE_PLURAL,
        name: child.metadata.name,
      })
      deletedNames.push(child.metadata.name)
    } catch {
      // Best-effort deletion — continue with remaining
    }
  }

  return deletedNames
}

export function isTerminalForPruning(phase: string | undefined): boolean {
  return WORKFLOW_TERMINAL_PHASES.has(phase ?? '')
}
