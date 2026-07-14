/**
 * Concurrency control for scheduled workflow triggers.
 *
 * Enforces Forbid, Replace, and Allow policies before creating
 * a child WorkflowRecipe.
 * */
import * as k8s from '@kubernetes/client-node'
import {
  CRD_GROUP,
  CRD_VERSION,
  WORKFLOWRECIPE_PLURAL,
  WORKFLOW_TERMINAL_PHASES,
} from '../reconciler/crdConstants'

const DEFAULT_MAX_CONCURRENT = 3

export type ConcurrencyPolicy = 'Forbid' | 'Replace' | 'Allow'
export type ConcurrencyDecision = 'proceed' | 'skip' | 'replace'

interface RunningChild {
  metadata: { name: string; namespace: string }
  status?: { workflowExecution?: { phase?: string } }
}

function isRunning(child: RunningChild): boolean {
  const phase = child.status?.workflowExecution?.phase
  return !WORKFLOW_TERMINAL_PHASES.has(phase ?? 'pending')
}

export async function listRunningChildren(
  customApi: k8s.CustomObjectsApi,
  parentName: string,
  namespace: string
): Promise<RunningChild[]> {
  const result = (await customApi.listNamespacedCustomObject({
    group: CRD_GROUP,
    version: CRD_VERSION,
    namespace,
    plural: WORKFLOWRECIPE_PLURAL,
    labelSelector: `clerum.io/parent-recipe=${parentName},clerum.io/scheduled=true`,
  })) as { items?: RunningChild[] }
  return (result.items ?? []).filter(isRunning)
}

export interface ConcurrencyResult {
  decision: ConcurrencyDecision
  runningChildren?: RunningChild[]
  reason?: string
}

export async function checkConcurrency(
  customApi: k8s.CustomObjectsApi,
  parentName: string,
  namespace: string,
  concurrencyPolicy: ConcurrencyPolicy,
  maxConcurrent?: number
): Promise<ConcurrencyResult> {
  const running = await listRunningChildren(customApi, parentName, namespace)

  if (running.length === 0) return { decision: 'proceed' }

  if (concurrencyPolicy === 'Forbid') {
    return { decision: 'skip', reason: 'Forbid: child already running' }
  }

  if (concurrencyPolicy === 'Replace') {
    return {
      decision: 'replace',
      runningChildren: running,
      reason: `Replace: cancelling ${running.length} running child(ren)`,
    }
  }

  // Allow — check global cap
  const cap = maxConcurrent ?? DEFAULT_MAX_CONCURRENT
  if (running.length >= cap) {
    return { decision: 'skip', reason: `Allow: at capacity (${running.length}/${cap})` }
  }

  return { decision: 'proceed' }
}
