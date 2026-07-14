/**
 * Crash recovery for workflow Pods.
 *
 * Detects Pod failures, creates replacement Pods, manages attempt counters,
 * and transitions workflow phase to `recovering`.
 *
 * Max 3 attempts, 120s recovery timeout.
 * */
import * as k8s from '@kubernetes/client-node'
import { getErrorCode } from '../reconciler/k8sErrors'
import { WorkflowExecutionStatus, WorkflowPhase } from './types'

const MAX_ATTEMPTS = 3
const RECOVERABLE_WAITING_REASONS = new Set([
  'CreateContainerConfigError',
  'CreateContainerError',
  'ImagePullBackOff',
  'ErrImagePull',
  'InvalidImageName',
  'CrashLoopBackOff',
])

export interface CrashRecoveryResult {
  action: 'none' | 'replace' | 'fail'
  message: string
  newPhase?: WorkflowPhase
  newAttempt?: number
}

export interface PodReadiness {
  phase?: string
  ready: boolean
  waitingReason?: string
  schedulingReason?: string
  /** Pod UID — changes on recreate, lets callers detect a restarted pod. */
  uid?: string
}

export function evaluateCompletedRuntimePodRecovery(
  currentExecution: WorkflowExecutionStatus | undefined,
  componentName: string
): CrashRecoveryResult {
  const attempt = currentExecution?.attempt ?? 0
  if (attempt >= MAX_ATTEMPTS) {
    return {
      action: 'fail',
      message: `${componentName} pod completed before workflow became terminal after ${MAX_ATTEMPTS} recovery attempts`,
      newPhase: 'failed',
    }
  }

  return {
    action: 'replace',
    message: `${componentName} pod completed before workflow became terminal; creating replacement (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
    newPhase: 'recovering',
    newAttempt: attempt + 1,
  }
}

export function isRecoverableContainerWaitingReason(
  podPhase: string | undefined,
  containerWaitingReason: string | undefined
): boolean {
  if (!containerWaitingReason || !RECOVERABLE_WAITING_REASONS.has(containerWaitingReason)) {
    return false
  }
  return (
    podPhase === 'Pending' ||
    (podPhase === 'Running' && containerWaitingReason === 'CrashLoopBackOff')
  )
}

export function evaluateCrashRecovery(
  podPhase: string | undefined,
  currentExecution: WorkflowExecutionStatus | undefined,
  containerWaitingReason?: string
): CrashRecoveryResult {
  // Pending image/config errors and Running CrashLoopBackOff pods will not
  // become ready without replacing the pod, so keep them bounded.
  if (isRecoverableContainerWaitingReason(podPhase, containerWaitingReason)) {
    const attempt = currentExecution?.attempt ?? 0
    if (attempt >= MAX_ATTEMPTS) {
      return {
        action: 'fail',
        message: `Pod in ${podPhase} with ${containerWaitingReason} after ${MAX_ATTEMPTS} recovery attempts`,
        newPhase: 'failed',
      }
    }
    return {
      action: 'replace',
      message: `Pod in ${podPhase} with ${containerWaitingReason}; creating replacement (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
      newPhase: 'recovering',
      newAttempt: attempt + 1,
    }
  }

  if (!podPhase || podPhase === 'Running' || podPhase === 'Pending') {
    return { action: 'none', message: 'Pod is healthy' }
  }

  const attempt = currentExecution?.attempt ?? 0

  if (podPhase === 'Succeeded') {
    return { action: 'none', message: 'Pod completed successfully' }
  }

  // Pod is Failed or Unknown
  if (attempt >= MAX_ATTEMPTS) {
    return {
      action: 'fail',
      message: `Pod failed after ${MAX_ATTEMPTS} recovery attempts`,
      newPhase: 'failed',
    }
  }

  return {
    action: 'replace',
    message: `Pod in phase '${podPhase}' — creating replacement (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
    newPhase: 'recovering',
    newAttempt: attempt + 1,
  }
}

export async function deletePodIfExists(
  coreApi: k8s.CoreV1Api,
  name: string,
  namespace: string
): Promise<void> {
  try {
    await coreApi.deleteNamespacedPod({ name, namespace })
  } catch (error: unknown) {
    if (getErrorCode(error) !== 404) throw error
    // 404 = already gone, safe to proceed
  }
}

const DEFAULT_POD_DELETE_WAIT_MS = 30_000
const POD_DELETE_POLL_MS = 250

/** Poll until the pod is gone (404) or timeout. Returns true when deleted. */
export async function waitForPodDeletion(
  coreApi: k8s.CoreV1Api,
  name: string,
  namespace: string,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {}
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_POD_DELETE_WAIT_MS
  const pollIntervalMs = options.pollIntervalMs ?? POD_DELETE_POLL_MS
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await getPodPhase(coreApi, name, namespace)) === undefined) return true
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
  }
  return (await getPodPhase(coreApi, name, namespace)) === undefined
}

export async function getPodPhase(
  coreApi: k8s.CoreV1Api,
  name: string,
  namespace: string
): Promise<string | undefined> {
  try {
    const pod = await coreApi.readNamespacedPod({ name, namespace })
    return pod.status?.phase
  } catch (error: unknown) {
    if (getErrorCode(error) === 404) return undefined
    throw error
  }
}

export async function getPodReadiness(
  coreApi: k8s.CoreV1Api,
  name: string,
  namespace: string
): Promise<PodReadiness> {
  try {
    const pod = await coreApi.readNamespacedPod({ name, namespace })
    return inspectPodReadiness(pod)
  } catch (error: unknown) {
    if (getErrorCode(error) === 404) return { ready: false }
    throw error
  }
}

export function inspectPodReadiness(pod: k8s.V1Pod): PodReadiness {
  const phase = pod.status?.phase
  const readyCondition = pod.status?.conditions?.find(condition => condition.type === 'Ready')
  const scheduledCondition = pod.status?.conditions?.find(
    condition => condition.type === 'PodScheduled' && condition.status !== 'True'
  )
  const waitingReason = firstContainerWaitingReason(pod)

  return {
    phase,
    ready: phase === 'Running' && readyCondition?.status === 'True',
    ...(waitingReason && { waitingReason }),
    ...(scheduledCondition?.reason && { schedulingReason: scheduledCondition.reason }),
    ...(pod.metadata?.uid && { uid: pod.metadata.uid }),
  }
}

/**
 * Returns the first container waiting reason that should influence recovery.
 * Pending image/config errors and Running CrashLoopBackOff are actionable.
 */
export async function getContainerWaitingReason(
  coreApi: k8s.CoreV1Api,
  name: string,
  namespace: string
): Promise<string | undefined> {
  try {
    const pod = await coreApi.readNamespacedPod({ name, namespace })
    const reason = firstContainerWaitingReason(pod)
    if (pod.status?.phase === 'Pending') return reason
    if (pod.status?.phase === 'Running' && reason === 'CrashLoopBackOff') return reason
    return undefined
  } catch (error: unknown) {
    if (getErrorCode(error) === 404) return undefined
    throw error
  }
}

function firstContainerWaitingReason(pod: k8s.V1Pod): string | undefined {
  const containerStatuses = pod.status?.containerStatuses ?? []
  for (const cs of containerStatuses) {
    const reason = (cs.state as { waiting?: { reason?: string } })?.waiting?.reason
    if (reason) return reason
  }
  return undefined
}
