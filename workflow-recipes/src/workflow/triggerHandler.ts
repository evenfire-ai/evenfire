/**
 * Direct trigger handler for scheduled workflow executions.
 *
 * Called by the DB-backed schedule worker through
 * POST /api/v1/workflow/{parent}/trigger. It orchestrates concurrency checks,
 * child WorkflowRecipe creation, and history pruning. The canonical run row is
 * created before this handler runs; this path only materializes the child
 * execution artifact.
 */
import * as k8s from '@kubernetes/client-node'
import { createLogger } from '../observability/logger'
import { CRD_GROUP, CRD_VERSION, WORKFLOWRECIPE_PLURAL } from '../reconciler/crdConstants'
import { getErrorCode } from '../reconciler/k8sErrors'
import { type ParentRecipe, buildChildRecipe, resolveExecutionIndex } from './childRecipeFactory'
import { type HistoryLimits, pruneHistory } from './historyManager'
import { checkConcurrency } from './rateLimiter'
import { enqueueSignal } from './signalStore'
import type { SchedulingSpec } from './types'

export interface TriggerResult {
  status: number
  body: Record<string, unknown>
}

export async function handleTrigger(
  customApi: k8s.CustomObjectsApi,
  parentName: string,
  namespace: string
): Promise<TriggerResult> {
  // 1. Fetch parent WorkflowRecipe
  let parent: Record<string, unknown>
  try {
    parent = (await customApi.getNamespacedCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      namespace,
      plural: WORKFLOWRECIPE_PLURAL,
      name: parentName,
    })) as Record<string, unknown>
  } catch (err: unknown) {
    // Only treat 404 as "not found" — rethrow 5xx/network errors so the CronJob
    // Pod's restartPolicy:OnFailure can retry. Swallowing non-404 errors silently
    // drops scheduled executions on transient K8s API failures.
    if (getErrorCode(err) === 404) {
      return { status: 404, body: { error: `WorkflowRecipe '${parentName}' not found` } }
    }
    throw err
  }

  // 2. Verify parent has spec.scheduling
  const spec = parent.spec as Record<string, unknown> | undefined
  const scheduling = spec?.scheduling as SchedulingSpec | undefined
  if (!scheduling) {
    return { status: 400, body: { error: 'Recipe does not have spec.scheduling' } }
  }

  // 3. Verify not suspended
  if (scheduling.suspend) {
    return { status: 409, body: { error: 'Recipe scheduling is suspended' } }
  }

  // 4. Check concurrency
  const policy = scheduling.concurrencyPolicy ?? 'Forbid'
  const concurrency = await checkConcurrency(customApi, parentName, namespace, policy)

  if (concurrency.decision === 'skip') {
    return { status: 202, body: { skipped: true, reason: concurrency.reason } }
  }

  if (concurrency.decision === 'replace' && concurrency.runningChildren) {
    await Promise.allSettled(
      concurrency.runningChildren.map(async child => {
        const runningChildName = child.metadata.name
        try {
          const childStatus = (child as unknown as Record<string, unknown>).status as
            | Record<string, unknown>
            | undefined
          const existingExecution = childStatus?.workflowExecution as
            | Record<string, unknown>
            | undefined
          await customApi.patchNamespacedCustomObjectStatus(
            {
              group: CRD_GROUP,
              version: CRD_VERSION,
              namespace,
              plural: WORKFLOWRECIPE_PLURAL,
              name: runningChildName,
              body: {
                status: { workflowExecution: { ...(existingExecution ?? {}), phase: 'cancelled' } },
              },
            },
            {
              middleware: [k8s.setHeaderMiddleware('Content-Type', 'application/merge-patch+json')],
            }
          )
        } catch (patchErr) {
          createLogger('wrc', 'trigger-handler').warn('Failed to patch status of cancelled child', {
            childName: runningChildName,
            error: patchErr instanceof Error ? patchErr.message : String(patchErr),
          })
        }
        enqueueSignal(runningChildName, {
          type: 'cancel',
          requestId: `replace-policy-${Date.now()}-${runningChildName}`,
          receivedAt: new Date().toISOString(),
        })
      })
    )
  }

  // 5. Resolve execution index and build child
  const executionIndex = await resolveExecutionIndex(customApi, parentName, namespace)
  const metadata = parent.metadata as { name: string; namespace: string; uid: string }
  const parentRecipe: ParentRecipe = {
    metadata: { name: metadata.name, namespace: metadata.namespace, uid: metadata.uid },
    spec: spec as ParentRecipe['spec'],
  }
  const child = buildChildRecipe(parentRecipe, executionIndex)

  // 6. Create child CRD — handle 409 from concurrent same-second triggers
  // (resolveExecutionIndex uses second-resolution timestamps, so two simultaneous
  // triggers can produce identical child names and collide on creation).
  try {
    await customApi.createNamespacedCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      namespace,
      plural: WORKFLOWRECIPE_PLURAL,
      body: child,
    })
  } catch (err: unknown) {
    if (getErrorCode(err) === 409) {
      return {
        status: 409,
        body: {
          error:
            'Concurrent trigger conflict — a child with this execution index already exists. Retry after a moment.',
        },
      }
    }
    throw err
  }

  // 7. Best-effort history pruning
  const limits: HistoryLimits = {
    successfulHistoryLimit: scheduling.successfulHistoryLimit ?? 3,
    failedHistoryLimit: scheduling.failedHistoryLimit ?? 1,
  }
  try {
    await pruneHistory(customApi, parentName, namespace, limits)
  } catch {
    // Best-effort — do not fail the trigger on pruning errors
  }

  const childMeta = child.metadata as Record<string, unknown>
  return { status: 202, body: { childName: childMeta.name } }
}
