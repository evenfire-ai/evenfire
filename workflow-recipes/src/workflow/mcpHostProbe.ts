/** Issue #1016 — one-GET liveness probe for the eager SDK mcp-host (restartPolicy Never). */
import type * as k8s from '@kubernetes/client-node'
import { getErrorCode } from '../reconciler/k8sErrors'
import type { WorkflowRecipeCRD } from '../types'
import { inspectPodReadiness } from './crashRecovery'

export type McpHostPodState =
  | { kind: 'absent' }
  | { kind: 'present'; phase?: string; uid?: string; deleting: boolean; ready: boolean }

export async function readMcpHostPod(
  coreApi: k8s.CoreV1Api,
  recipeName: string,
  namespace: string
): Promise<McpHostPodState> {
  try {
    const pod = await coreApi.readNamespacedPod({ name: `${recipeName}-mcp-host`, namespace })
    return {
      kind: 'present',
      phase: pod.status?.phase,
      uid: pod.metadata?.uid,
      deleting: Boolean(pod.metadata?.deletionTimestamp),
      // Running alone is not enough: the readiness (bootstrap) probe can fail
      // while liveness still passes, so use the canonical Ready interpretation.
      ready: inspectPodReadiness(pod).ready,
    }
  } catch (error) {
    if (getErrorCode(error) === 404) return { kind: 'absent' }
    throw error
  }
}

export function sdkLivenessNeedsReconcile(
  recipe: WorkflowRecipeCRD,
  pod: McpHostPodState
): boolean {
  const sdkStatus = recipe.status?.pluginWorkloadSdk
  const state = sdkStatus?.state
  const stepless = (recipe.spec.steps ?? []).length === 0
  if (state === 'disabled') return stepless && pod.kind === 'present'
  if (pod.kind === 'absent' || pod.deleting || pod.phase !== 'Running' || !pod.ready) return true
  if (state !== 'validated') return true
  if (sdkStatus?.bootstrapPodUid && pod.uid && sdkStatus.bootstrapPodUid !== pod.uid) return true
  return false
}
