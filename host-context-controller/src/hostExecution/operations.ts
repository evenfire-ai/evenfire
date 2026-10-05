import type * as k8s from '@kubernetes/client-node'
import type { VerifiedMcpHostPrincipal } from '../mcpApiAuthentication'
import { getErrorCode, observeCreate, observeExistenceRead } from '../utils'
import { HostExecutionAuthorization, type HostExecutionBinding } from './authorization'
import {
  type ApprovedExecutionRequest,
  EXECUTION_EXECUTOR_CONTAINER_NAME,
  EXECUTION_INPUT_RECEIVER_CONTAINER_NAME,
  type TrustedHostExecutionIdentity,
  buildHostExecutionJob,
  hostExecutionJobName,
  validateHostExecutionJob,
  validateHostExecutionPod,
} from './jobFactory'
import {
  EXECUTION_RESULT_MAX_BYTES,
  type HostExecutionResult,
  parseHostExecutionResult,
} from './result'

type BatchApi = Pick<
  k8s.BatchV1Api,
  'createNamespacedJob' | 'readNamespacedJob' | 'deleteNamespacedJob'
>
type CoreApi = Pick<
  k8s.CoreV1Api,
  'listNamespacedPod' | 'readNamespacedPod' | 'readNamespacedPodLog'
>

/** Internal receipt retained with the prepared operation, never reconstructed
 * from a new upload or a caller-selected Host name. Contains no bearer token.
 */
export interface HostExecutionHandle {
  readonly identity: Readonly<TrustedHostExecutionIdentity>
  readonly request: Readonly<ApprovedExecutionRequest>
  readonly jobUid: string
}

export type HostExecutionObservation =
  | { state: 'queued' }
  | { state: 'waiting_for_input' | 'running'; podUid: string }
  | { state: 'failed'; podUid: string; reason: 'input_receive_failed' }
  | { state: 'completed'; podUid: string; result: HostExecutionResult }

function bindingFor(identity: TrustedHostExecutionIdentity): HostExecutionBinding {
  return {
    hostName: identity.hostName,
    hostUid: identity.hostUid,
    namespace: identity.namespace,
    generation: identity.hostGeneration,
  }
}

function snapshot(
  identity: TrustedHostExecutionIdentity,
  request: ApprovedExecutionRequest,
  jobUid: string
): HostExecutionHandle {
  const copiedRequest = {
    ...request,
    argv: [...request.argv],
    ...(request.input ? { input: { ...request.input } } : {}),
  }
  Object.freeze(copiedRequest.argv)
  if (copiedRequest.input) Object.freeze(copiedRequest.input)
  return Object.freeze({
    identity: Object.freeze({ ...identity }),
    request: Object.freeze(copiedRequest),
    jobUid,
  })
}

/**
 * Finite Kubernetes clients must use makeHostK8sApiClient at composition time.
 * Each HTTP operation supplies a freshly verified principal. A 25-minute Job
 * therefore does not depend on keeping its original 10-minute JWT alive.
 * This backend does not mint scopes, install routes or activate shell tools.
 */
export class HostExecutionOperations {
  constructor(
    private readonly batch: BatchApi,
    private readonly core: CoreApi,
    private readonly authorization: HostExecutionAuthorization
  ) {}

  async start(
    principal: VerifiedMcpHostPrincipal,
    identity: TrustedHostExecutionIdentity,
    request: ApprovedExecutionRequest
  ): Promise<HostExecutionHandle> {
    const prepared = snapshot(identity, request, '')
    const body = buildHostExecutionJob(prepared.identity, prepared.request)
    const binding = await this.authorization.authorize(principal)
    if (
      binding.hostName !== prepared.identity.hostName ||
      binding.namespace !== prepared.identity.namespace ||
      binding.hostUid !== prepared.identity.hostUid ||
      binding.generation !== prepared.identity.hostGeneration
    ) {
      throw new Error('execution_binding_mismatch')
    }
    const created = await observeCreate('Job', () =>
      this.batch.createNamespacedJob({ namespace: binding.namespace, body })
    )
    validateHostExecutionJob(created, prepared.identity, prepared.request)
    const handle = snapshot(prepared.identity, prepared.request, created.metadata!.uid!)
    try {
      await this.authorization.revalidate(principal, binding)
    } catch (error) {
      // No receipt or output is published under revoked authority. Foreground
      // deletion starts cleanup; it is not a claim that all Pods are gone.
      await this.deleteExactJob(handle)
      throw error
    }
    return handle
  }

  private async readJob(handle: HostExecutionHandle): Promise<k8s.V1Job | null> {
    let job: k8s.V1Job
    try {
      job = await observeExistenceRead('Job', () =>
        this.batch.readNamespacedJob({
          name: hostExecutionJobName(handle.identity.operationId),
          namespace: handle.identity.namespace,
        })
      )
    } catch (error) {
      if (getErrorCode(error) === 404) return null
      throw error
    }
    validateHostExecutionJob(job, handle.identity, handle.request, handle.jobUid)
    return job
  }

  private async readPods(handle: HostExecutionHandle): Promise<k8s.V1Pod[]> {
    const pods = await this.core.listNamespacedPod({
      namespace: handle.identity.namespace,
      labelSelector: `batch.kubernetes.io/controller-uid=${handle.jobUid}`,
      limit: 2,
    })
    // The Job has backoffLimit=0 and no parallelism. An ambiguous or partial
    // inventory must never produce output or a workload-absence receipt.
    if (pods.metadata?._continue || pods.items.length > 1) {
      throw new Error('execution_pod_inventory_ambiguous')
    }
    return pods.items
  }

  async inspect(
    principal: VerifiedMcpHostPrincipal,
    handle: HostExecutionHandle
  ): Promise<HostExecutionObservation> {
    const binding = bindingFor(handle.identity)
    await this.authorization.revalidate(principal, binding)
    const job = await this.readJob(handle)
    if (!job) throw new Error('execution_not_found')
    const pods = await this.readPods(handle)
    await this.authorization.revalidate(principal, binding)
    if (pods.length === 0) return { state: 'queued' }
    const pod = pods[0]
    validateHostExecutionPod(pod, job, handle.identity, handle.request)
    const podUid = pod.metadata!.uid!
    const executor = pod.status?.containerStatuses?.find(
      container => container.name === EXECUTION_EXECUTOR_CONTAINER_NAME
    )
    if (!executor?.state?.terminated) {
      const receiver = pod.status?.initContainerStatuses?.find(
        container => container.name === EXECUTION_INPUT_RECEIVER_CONTAINER_NAME
      )
      if (receiver?.state?.terminated && receiver.state.terminated.exitCode !== 0) {
        return { state: 'failed', podUid, reason: 'input_receive_failed' }
      }
      return {
        state:
          handle.request.kind === 'attachment' && !executor?.state?.running
            ? 'waiting_for_input'
            : 'running',
        podUid,
      }
    }
    const podName = pod.metadata!.name!
    const output = await this.core.readNamespacedPodLog({
      namespace: handle.identity.namespace,
      name: podName,
      container: EXECUTION_EXECUTOR_CONTAINER_NAME,
      follow: false,
      limitBytes: EXECUTION_RESULT_MAX_BYTES + 1,
    })
    // A replaced Job cannot supply a result for the saved operation even if
    // it uses the same name. Check again after retrieving private output.
    const currentJob = await this.readJob(handle)
    if (!currentJob) throw new Error('execution_not_found')
    const currentPod = await this.core.readNamespacedPod({
      namespace: handle.identity.namespace,
      name: podName,
    })
    validateHostExecutionPod(currentPod, currentJob, handle.identity, handle.request, podUid)
    await this.authorization.revalidate(principal, binding)
    return {
      state: 'completed',
      podUid,
      result: parseHostExecutionResult(output),
    }
  }

  private async deleteExactJob(handle: HostExecutionHandle): Promise<void> {
    await this.batch.deleteNamespacedJob({
      name: hostExecutionJobName(handle.identity.operationId),
      namespace: handle.identity.namespace,
      body: { propagationPolicy: 'Foreground', preconditions: { uid: handle.jobUid } },
    })
  }

  async cancel(
    principal: VerifiedMcpHostPrincipal,
    handle: HostExecutionHandle
  ): Promise<{ state: 'cleanup_pending' | 'workloads_absent' }> {
    const binding = bindingFor(handle.identity)
    await this.authorization.revalidate(principal, binding)
    const job = await this.readJob(handle)
    // Job validation includes the original UID; DELETE also carries its UID
    // precondition to close a replacement race after the read.
    if (job && !job.metadata?.deletionTimestamp) await this.deleteExactJob(handle)
    const remainingJob = await this.readJob(handle)
    const pods = await this.readPods(handle)
    await this.authorization.revalidate(principal, binding)
    // API absence is a workload observation. The file-store lifecycle must
    // separately prove removal of staging, cached results and materializations
    // before releasing its physical-cleanup fence or storage reservation.
    return { state: remainingJob || pods.length ? 'cleanup_pending' : 'workloads_absent' }
  }
}
