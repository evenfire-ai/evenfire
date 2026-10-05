import { describe, expect, it, vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import type { VerifiedMcpHostPrincipal } from '../mcpApiAuthentication'
import { HostExecutionAuthorization, type HostExecutionHostRecord } from './authorization'
import { type TrustedHostExecutionIdentity, buildHostExecutionJob } from './jobFactory'
import { HostExecutionOperations } from './operations'

const identity: TrustedHostExecutionIdentity = {
  hostName: 'chatllm',
  hostUid: '00000000-1111-4111-8111-000000000001',
  namespace: 'mcp-host',
  hostGeneration: 7,
  operationId: '00000000-1111-4111-8111-000000000002',
  image: 'clerum/mcp-host:dev',
  workspacePvcName: 'chatllm-workspace',
  userKey: '0123456789abcdef',
  workspaceLayoutPrefix: 'workspace/',
}
const principal: VerifiedMcpHostPrincipal = {
  subject: 'mcp-host/standalone',
  hostName: identity.hostName,
  hostUid: identity.hostUid,
  namespace: identity.namespace,
  jti: 'execution-unit-test',
  issuedAt: Math.floor(Date.now() / 1000),
  expiresAt: Math.floor(Date.now() / 1000) + 600,
  audiences: ['host-context-controller'],
  nativeExecutionAllowed: true,
}
const request = {
  kind: 'workspace' as const,
  argv: ['/bin/sh', '-c', 'printf approved'],
  timeoutMs: 1_500_000,
  scratchBytes: 1_048_576,
}
const jobUid = '00000000-1111-4111-8111-000000000003'
const podUid = '00000000-1111-4111-8111-000000000004'
const capturedResult = {
  reason: 'exited',
  exitCode: 0,
  signal: null,
  truncated: false,
  stdout: Buffer.from('approved').toString('base64'),
  stderr: '',
}

function fixture() {
  let host: HostExecutionHostRecord | null = {
    name: identity.hostName,
    namespace: identity.namespace,
    uid: identity.hostUid,
    generation: identity.hostGeneration,
  }
  let job: k8s.V1Job | null = buildHostExecutionJob(identity, request)
  job.metadata!.uid = jobUid
  const pod: k8s.V1Pod = {
    metadata: {
      name: 'host-exec-pod',
      namespace: identity.namespace,
      uid: podUid,
      ownerReferences: [
        {
          apiVersion: 'batch/v1',
          kind: 'Job',
          name: job.metadata!.name!,
          uid: jobUid,
          controller: true,
        },
      ],
    },
    status: {
      containerStatuses: [
        {
          name: 'executor',
          image: identity.image,
          imageID: 'unit-image',
          ready: false,
          restartCount: 0,
          state: { terminated: { exitCode: 0 } },
        },
      ],
    },
  }
  const missing = () => Object.assign(new Error('not found'), { code: 404 })
  const batch = {
    createNamespacedJob: vi.fn(async (_request: unknown) => job!),
    readNamespacedJob: vi.fn(async (_request: unknown) => {
      if (!job) throw missing()
      return job
    }),
    deleteNamespacedJob: vi.fn(async (_request: unknown) => {
      job = null
      return {}
    }),
  }
  let pods = [pod]
  const core = {
    listNamespacedPod: vi.fn(async (_request: unknown) => ({ items: pods })),
    readNamespacedPod: vi.fn(async (_request: unknown) => pod),
    readNamespacedPodLog: vi.fn(async (_request: unknown) => JSON.stringify(capturedResult)),
  }
  const authorization = new HostExecutionAuthorization(async () => host)
  const operations = new HostExecutionOperations(
    batch as unknown as ConstructorParameters<typeof HostExecutionOperations>[0],
    core as unknown as ConstructorParameters<typeof HostExecutionOperations>[1],
    authorization
  )
  return {
    operations,
    batch,
    core,
    pod,
    getJob: () => job!,
    setJob: (value: k8s.V1Job | null) => {
      job = value
    },
    setHost: (value: HostExecutionHostRecord | null) => {
      host = value
    },
    setPods: (value: k8s.V1Pod[]) => {
      pods = value
    },
  }
}

describe('Host execution operations', () => {
  it('creates an approved Job and retains its immutable UID and original authority', async () => {
    const f = fixture()
    const handle = await f.operations.start(principal, identity, request)
    expect(f.batch.createNamespacedJob.mock.calls[0]?.[0]).toEqual({
      namespace: identity.namespace,
      body: buildHostExecutionJob(identity, request),
    })
    expect(handle.jobUid).toBe(jobUid)
    expect(handle.identity.hostGeneration).toBe(7)
    expect(Object.isFrozen(handle)).toBe(true)
    expect(Object.isFrozen(handle.request.argv)).toBe(true)
  })

  it('rejects a caller generation or Host binding mismatch before creating anything', async () => {
    for (const changed of [
      { ...identity, hostGeneration: 8 },
      { ...identity, namespace: 'foreign' },
      { ...identity, hostUid: '00000000-1111-4111-8111-000000000099' },
    ]) {
      const f = fixture()
      await expect(f.operations.start(principal, changed, request)).rejects.toThrow(
        'execution_binding_mismatch'
      )
      expect(f.batch.createNamespacedJob).not.toHaveBeenCalled()
    }
  })

  it('withholds a start receipt if the Host changes while creation is pending', async () => {
    const f = fixture()
    f.batch.createNamespacedJob.mockImplementationOnce(async () => {
      f.setHost({
        name: identity.hostName,
        namespace: identity.namespace,
        uid: identity.hostUid,
        generation: 8,
      })
      return f.getJob()
    })
    await expect(f.operations.start(principal, identity, request)).rejects.toThrow(
      'host_generation_changed'
    )
    expect(f.batch.deleteNamespacedJob).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { propagationPolicy: 'Foreground', preconditions: { uid: jobUid } },
      })
    )
  })

  it('reads bounded output with a renewed same-binding token and never remints the Job', async () => {
    const f = fixture()
    const handle = await f.operations.start(principal, identity, request)
    const renewed = { ...principal, jti: 'renewed-unit-test' }
    const result = await f.operations.inspect(renewed, handle)
    expect(result).toEqual({ state: 'completed', podUid, result: capturedResult })
    expect(f.core.readNamespacedPodLog).toHaveBeenCalledWith(
      expect.objectContaining({
        container: 'executor',
        follow: false,
        limitBytes: 98_305,
      })
    )
    expect(f.batch.createNamespacedJob).toHaveBeenCalledTimes(1)
  })

  it('does not publish output if generation changes during its retrieval', async () => {
    const f = fixture()
    const handle = await f.operations.start(principal, identity, request)
    f.core.readNamespacedPodLog.mockImplementationOnce(async () => {
      f.setHost({
        name: identity.hostName,
        namespace: identity.namespace,
        uid: identity.hostUid,
        generation: 8,
      })
      return 'unpublished private result'
    })
    await expect(f.operations.inspect(principal, handle)).rejects.toThrow('host_generation_changed')
  })

  it('denies a replaced Job or foreign Pod before reading any output', async () => {
    for (const change of ['job', 'pod']) {
      const f = fixture()
      const handle = await f.operations.start(principal, identity, request)
      if (change === 'job') f.getJob().metadata!.uid = 'replaced-job'
      else f.pod.metadata!.ownerReferences![0].uid = 'foreign-job'
      await expect(f.operations.inspect(principal, handle)).rejects.toThrow(
        change === 'job' ? 'job_uid_replaced' : 'pod_owner_mismatch'
      )
      expect(f.core.readNamespacedPodLog).not.toHaveBeenCalled()
    }
  })

  it('reports queued or running without fetching logs', async () => {
    const f = fixture()
    const handle = await f.operations.start(principal, identity, request)
    f.setPods([])
    await expect(f.operations.inspect(principal, handle)).resolves.toEqual({ state: 'queued' })
    f.setPods([f.pod])
    f.pod.status!.containerStatuses![0].state = { running: {} }
    await expect(f.operations.inspect(principal, handle)).resolves.toEqual({
      state: 'running',
      podUid,
    })
    expect(f.core.readNamespacedPodLog).not.toHaveBeenCalled()
  })

  it('refuses an oversized producer frame rather than publishing a partial result', async () => {
    const f = fixture()
    const handle = await f.operations.start(principal, identity, request)
    f.core.readNamespacedPodLog.mockResolvedValueOnce('x'.repeat(100_000))
    await expect(f.operations.inspect(principal, handle)).rejects.toThrow(
      'execution_result_invalid'
    )
  })

  it('reports cleanup pending until the Job and its exact owned Pods are absent', async () => {
    const f = fixture()
    const handle = await f.operations.start(principal, identity, request)
    await expect(f.operations.cancel(principal, handle)).resolves.toEqual({
      state: 'cleanup_pending',
    })
    expect(f.batch.deleteNamespacedJob).toHaveBeenCalledWith({
      namespace: identity.namespace,
      name: 'host-exec-' + identity.operationId,
      body: { propagationPolicy: 'Foreground', preconditions: { uid: jobUid } },
    })
    f.setPods([])
    await expect(f.operations.cancel(principal, handle)).resolves.toEqual({
      state: 'workloads_absent',
    })
    expect(f.batch.deleteNamespacedJob).toHaveBeenCalledTimes(1)
  })

  it('never deletes a replacement and never turns a non-404 failure into absence', async () => {
    const f = fixture()
    const handle = await f.operations.start(principal, identity, request)
    f.getJob().metadata!.uid = 'replacement'
    await expect(f.operations.cancel(principal, handle)).rejects.toThrow('job_uid_replaced')
    expect(f.batch.deleteNamespacedJob).not.toHaveBeenCalled()
    f.batch.readNamespacedJob.mockRejectedValueOnce(
      Object.assign(new Error('API unavailable'), { code: 503 })
    )
    await expect(f.operations.cancel(principal, handle)).rejects.toThrow('API unavailable')
  })

  it('withholds logs when the Pod is replaced while log retrieval is pending', async () => {
    const f = fixture()
    const handle = await f.operations.start(principal, identity, request)
    f.core.readNamespacedPodLog.mockImplementationOnce(async () => {
      f.pod.metadata!.uid = 'replacement-pod'
      return 'output from a replaced pod'
    })
    await expect(f.operations.inspect(principal, handle)).rejects.toThrow('pod_uid_replaced')
  })

  it('does not certify absence from an incomplete Pod inventory', async () => {
    const f = fixture()
    const handle = await f.operations.start(principal, identity, request)
    f.core.listNamespacedPod.mockResolvedValueOnce({
      items: [],
      metadata: { _continue: 'more-pods' },
    } as never)
    await expect(f.operations.inspect(principal, handle)).rejects.toThrow(
      'execution_pod_inventory_ambiguous'
    )
  })
})
