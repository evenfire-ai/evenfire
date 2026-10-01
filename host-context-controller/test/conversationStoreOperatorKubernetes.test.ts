import { describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { CONVERSATION_STORE_BOOTSTRAP_VERIFY_PROGRAM } from '../src/conversationStoreBootstrapProgram'
import { computeConversationStoreRequestHash } from '../src/conversationStoreObservation'
import type { ConversationStoreOperatorContext } from '../src/conversationStoreOperator'
import { ConversationStoreKubernetesOperatorPort } from '../src/conversationStoreOperatorKubernetes'
import type { ConversationStoreRequest, HostCRD } from '../src/types'

const HOST = '11111111-1111-4111-8111-111111111111'
const PVC = '22222222-2222-4222-8222-222222222222'
const MAINT = '33333333-3333-4333-8333-333333333333'
const REQUEST = '44444444-4444-4444-8444-444444444444'
const EXPORT = '55555555-5555-4555-8555-555555555555'
const JOB = '66666666-6666-4666-8666-666666666666'
const HASH = 'a'.repeat(64)
const SNAPSHOT = 'b'.repeat(64)
const IMAGE = `ghcr.io/palmeradao/mcp-host@sha256:${'c'.repeat(64)}`
const REVISION = 'd'.repeat(64)
const NOW = '2026-09-30T12:00:00.000Z'
const clone = <T>(value: T): T => structuredClone(value)
const missing = () => Promise.reject({ code: 404 })

function fixture() {
  const request: ConversationStoreRequest = {
    schemaVersion: 1,
    storageContract: 'canonical',
    requestId: REQUEST,
    operation: 'prepare',
    hostUid: HOST,
    pvcUid: PVC,
    maintenanceId: MAINT,
    principal: { kind: 'control-admin', subject: 'operator' },
    targetImage: IMAGE,
    templateRevision: REVISION,
    sourceClass: 'sqlite-external-exported',
    exportId: EXPORT,
    manifestHash: HASH,
  }
  let host = {
    name: 'alpha',
    namespace: 'mcp-host',
    uid: HOST,
    resourceVersion: '1',
    spec: {},
    status: {
      conversationStore: {
        request,
        maintenance: {
          storageContract: 'canonical',
          hostUid: HOST,
          pvcUid: PVC,
          maintenanceId: MAINT,
          phase: 'quiescing',
          startedAt: NOW,
          updatedAt: NOW,
        },
        requestResult: {
          storageContract: 'canonical',
          requestId: REQUEST,
          hostUid: HOST,
          pvcUid: PVC,
          state: 'accepted',
          updatedAt: NOW,
        },
      },
    },
  } as HostCRD
  const jobs = new Map<string, k8s.V1Job>()
  const pods = new Map<string, k8s.V1Pod>()
  const accounts = new Map<string, k8s.V1ServiceAccount>()
  const roles = new Map<string, k8s.V1Role>()
  const bindings = new Map<string, k8s.V1RoleBinding>()
  const get = <T>(map: Map<string, T>, name: string): Promise<T> =>
    map.has(name) ? Promise.resolve(clone(map.get(name)!)) : missing()
  const put = <T extends { metadata?: k8s.V1ObjectMeta }>(
    map: Map<string, T>,
    body: T
  ): Promise<T> => {
    const value = {
      ...clone(body),
      metadata: { ...body.metadata, uid: body.metadata?.uid ?? JOB, resourceVersion: '1' },
    } as T
    map.set(body.metadata!.name!, value)
    return Promise.resolve(clone(value))
  }
  const core = {
    readNamespacedPersistentVolumeClaim: vi.fn(async () => ({
      metadata: { name: 'alpha-workspace', namespace: 'mcp-host', uid: PVC, resourceVersion: '1' },
    })),
    readNamespacedServiceAccount: vi.fn(({ name }: { name: string }) => get(accounts, name)),
    createNamespacedServiceAccount: vi.fn(({ body }: { body: k8s.V1ServiceAccount }) =>
      put(accounts, body)
    ),
    listNamespacedPod: vi.fn(async ({ labelSelector }: { labelSelector?: string }) => ({
      items: [...pods.values()]
        .filter(
          pod =>
            !labelSelector ||
            (labelSelector.startsWith('batch.kubernetes.io/job-name=')
              ? pod.metadata?.labels?.['batch.kubernetes.io/job-name'] ===
                labelSelector.split('=')[1]
              : pod.metadata?.labels?.app === 'alpha')
        )
        .map(clone),
    })),
    readNamespacedPod: vi.fn(({ name }: { name: string }) => get(pods, name)),
  } as unknown as k8s.CoreV1Api
  const batch = {
    readNamespacedJob: vi.fn(({ name }: { name: string }) => get(jobs, name)),
    createNamespacedJob: vi.fn(async ({ body }: { body: k8s.V1Job }) => {
      const created = await put(jobs, body)
      return created
    }),
  } as unknown as k8s.BatchV1Api
  const rbac = {
    readNamespacedRole: vi.fn(({ name }: { name: string }) => get(roles, name)),
    createNamespacedRole: vi.fn(({ body }: { body: k8s.V1Role }) => put(roles, body)),
    replaceNamespacedRole: vi.fn(({ body }: { body: k8s.V1Role }) => put(roles, body)),
    readNamespacedRoleBinding: vi.fn(({ name }: { name: string }) => get(bindings, name)),
    createNamespacedRoleBinding: vi.fn(({ body }: { body: k8s.V1RoleBinding }) =>
      put(bindings, body)
    ),
  } as unknown as k8s.RbacAuthorizationV1Api
  const deployment = {
    metadata: {
      name: 'alpha',
      namespace: 'mcp-host',
      uid: 'deployment',
      resourceVersion: '1',
      annotations: { 'clerum.io/host-uid': HOST },
    },
    spec: { replicas: 0 },
  } as k8s.V1Deployment
  const apps = {
    readNamespacedDeployment: vi.fn(async () => clone(deployment)),
    replaceNamespacedDeployment: vi.fn(async ({ body }) => body),
    listNamespacedReplicaSet: vi.fn(async () => ({
      items: [
        {
          metadata: {
            name: 'alpha-rs',
            uid: 'replica-set',
            ownerReferences: [{ name: 'alpha', uid: 'deployment', controller: true }],
          },
        },
      ],
    })),
  } as unknown as k8s.AppsV1Api
  const execProgram = vi.fn(async () =>
    JSON.stringify({
      proofVersion: 1,
      storageContract: 'canonical',
      outcome: 'ok',
      hostUid: HOST,
      pvcUid: PVC,
      maintenanceId: MAINT,
      sourcePodUid: 'source-pod',
      requestId: REQUEST,
      requestHash: computeConversationStoreRequestHash(request),
      exportId: EXPORT,
      manifestHash: HASH,
      sourceSnapshotHash: SNAPSHOT,
    })
  )
  const port = new ConversationStoreKubernetesOperatorPort({
    kubeConfig: {} as k8s.KubeConfig,
    coreApi: core,
    appsApi: apps,
    rbacApi: rbac,
    batchApi: () => batch,
    now: () => new Date(NOW),
    readFreshHost: async () => clone(host),
    execProgram,
    writeStatus: async (context, activeRequest, fields) => {
      expect(activeRequest).toEqual(host.status?.conversationStore?.request)
      host = {
        ...host,
        status: {
          ...host.status,
          conversationStore: { ...host.status?.conversationStore, ...fields },
        },
      }
      context.host = clone(host)
      return clone(host)
    },
  })
  const context: ConversationStoreOperatorContext = {
    host: clone(host),
    pvcName: 'alpha-workspace',
    pvcUid: PVC,
    image: IMAGE,
    templateRevision: REVISION,
    canonicalRequested: true,
    storageContract: 'canonical',
  }
  function helperPod(job: k8s.V1Job, message?: Record<string, unknown>, exitCode = 0) {
    const pod = {
      metadata: {
        name: `${job.metadata!.name}-pod`,
        namespace: 'mcp-host',
        uid: 'helper-pod',
        resourceVersion: '1',
        annotations: clone(job.spec!.template.metadata!.annotations),
        labels: {
          ...job.spec!.template.metadata!.labels,
          'batch.kubernetes.io/job-name': job.metadata!.name!,
        },
        ownerReferences: [
          {
            apiVersion: 'batch/v1',
            kind: 'Job',
            name: job.metadata!.name!,
            uid: job.metadata!.uid!,
            controller: true,
          },
        ],
      },
      spec: clone(job.spec!.template.spec),
      status: {
        phase: message ? 'Succeeded' : 'Running',
        containerStatuses: [
          {
            name: 'conversation-store-operator',
            image: IMAGE,
            imageID: `docker-pullable://${IMAGE}`,
            restartCount: 0,
            ready: false,
            state: message
              ? {
                  terminated: {
                    exitCode,
                    finishedAt: new Date(NOW),
                    message: JSON.stringify(message),
                  },
                }
              : { running: {} },
          },
        ],
      },
    } as k8s.V1Pod
    pods.set(pod.metadata!.name!, pod)
    return pod
  }
  function physical(job: k8s.V1Job, overrides = {}) {
    return {
      outcome: 'ok',
      storageContract: 'canonical',
      reason: 'NoCollision',
      proofVersion: 1,
      hostUid: HOST,
      pvcUid: PVC,
      maintenanceId: MAINT,
      sourceClass: 'sqlite-external-exported',
      exportId: EXPORT,
      manifestHash: HASH,
      sourceSnapshotHash: SNAPSHOT,
      requestId: REQUEST,
      requestHash: computeConversationStoreRequestHash(request),
      controllerUid: HOST,
      capabilityId: job.metadata!.uid!,
      ...overrides,
    }
  }
  function sourcePod() {
    const pod = {
      metadata: {
        name: 'alpha-pod',
        namespace: 'mcp-host',
        uid: 'source-pod',
        resourceVersion: '1',
        labels: { app: 'alpha' },
        ownerReferences: [{ name: 'alpha-rs', uid: 'replica-set', controller: true }],
      },
      spec: {
        nodeName: 'test-node',
        volumes: [{ name: 'workspace', persistentVolumeClaim: { claimName: 'alpha-workspace' } }],
        containers: [
          {
            name: 'mcp-host',
            image: IMAGE,
            volumeMounts: [{ name: 'workspace', mountPath: '/workspace' }],
          },
        ],
      },
      status: {
        phase: 'Running',
        containerStatuses: [
          {
            name: 'mcp-host',
            image: IMAGE,
            imageID: IMAGE,
            restartCount: 0,
            ready: true,
            state: { running: {} },
          },
        ],
      },
    } as k8s.V1Pod
    pods.set(pod.metadata!.name!, pod)
    return pod
  }
  return {
    port,
    context,
    request,
    jobs,
    pods,
    roles,
    accounts,
    bindings,
    core,
    batch,
    apps,
    execProgram,
    helperPod,
    physical,
    sourcePod,
    deployment,
    get host() {
      return host
    },
    setHost(value: HostCRD) {
      host = value
    },
  }
}

describe('concrete Kubernetes operator transport', () => {
  it('creates a finite controller-owned diagnostic Job with read-only PVC and private scratch', async () => {
    const f = fixture()
    expect(await f.port.execute(f.context, f.request, 'preparation')).toEqual({ state: 'pending' })
    const job = [...f.jobs.values()][0]
    expect(job.metadata!.ownerReferences).toMatchObject([
      { kind: 'Host', uid: HOST, controller: true },
    ])
    expect(job.spec).toMatchObject({ backoffLimit: 0, activeDeadlineSeconds: 240 })
    expect(job.spec!.template.spec!.volumes).toContainEqual({
      name: 'workspace',
      persistentVolumeClaim: { claimName: 'alpha-workspace', readOnly: true },
    })
    expect(job.spec!.template.spec!.containers![0]).toMatchObject({
      image: IMAGE,
      terminationMessagePolicy: 'File',
      securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true },
    })
    expect(f.host.status?.conversationStore?.execution).toMatchObject({
      jobUid: JOB,
      requestId: REQUEST,
      phase: 'preparation',
      operation: 'prepare',
    })
    expect(
      [...f.roles.values()][0].rules?.find(rule => rule.resources?.includes('pods'))
    ).toBeUndefined()
    expect(f.apps.replaceNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('accepts physical output only from the exact native Host→Job→Pod chain and grants only that Pod name', async () => {
    const f = fixture()
    await f.port.execute(f.context, f.request, 'preparation')
    const job = [...f.jobs.values()][0]
    job.status = { succeeded: 1 }
    const pod = f.helperPod(job, f.physical(job))
    const result = await f.port.execute(f.context, f.request, 'preparation')
    expect(result).toMatchObject({
      state: 'succeeded',
      proof: { manifestHash: HASH, sourceSnapshotHash: SNAPSHOT },
    })
    const rules = [...f.roles.values()][0].rules!
    expect(rules.find(rule => rule.resources?.includes('pods'))).toEqual({
      apiGroups: [''],
      resources: ['pods'],
      resourceNames: [pod.metadata!.name],
      verbs: ['get'],
    })
    expect(rules.every(rule => rule.resourceNames?.length)).toBe(true)
  })

  it.each(['binding', 'owner', 'image', 'extra-container', 'read-only'])(
    'rejects altered native helper %s',
    async kind => {
      const f = fixture()
      await f.port.execute(f.context, f.request, 'preparation')
      const job = [...f.jobs.values()][0]
      job.status = { succeeded: 1 }
      const pod = f.helperPod(job, f.physical(job))
      if (kind === 'binding')
        pod.spec!.containers![0].env!.find(value => value.name === 'CLERUM_PVC_UID')!.value = HOST
      if (kind === 'owner') pod.metadata!.ownerReferences![0].uid = 'foreign-job'
      if (kind === 'image')
        pod.status!.containerStatuses![0].imageID = 'docker-pullable://host@sha256:wrong'
      if (kind === 'extra-container')
        pod.spec!.containers!.push({ name: 'untrusted', image: IMAGE })
      if (kind === 'read-only') pod.spec!.volumes![0].persistentVolumeClaim!.readOnly = false
      const result = await f.port.execute(f.context, f.request, 'preparation')
      expect(result.state).not.toBe('succeeded')
    }
  )

  it('rejects a stale correlation even when the physical tuple and native owner are valid', async () => {
    const f = fixture()
    await f.port.execute(f.context, f.request, 'preparation')
    const job = [...f.jobs.values()][0]
    job.status = { succeeded: 1 }
    f.helperPod(job, f.physical(job, { capabilityId: HOST }))
    expect(await f.port.execute(f.context, f.request, 'preparation')).toEqual({
      state: 'blocked',
      reason: 'OperatorEvidenceBindingMismatch',
    })
  })

  it('retains the real domain reason from a terminated helper after Kubernetes marks its Job failed', async () => {
    const f = fixture()
    await f.port.execute(f.context, f.request, 'migrate')
    const job = [...f.jobs.values()][0]
    job.status = { failed: 1, conditions: [{ type: 'Failed', status: 'True' }] }
    f.helperPod(job, { outcome: 'blocked', reason: 'DivergentCandidates' }, 3)
    expect(await f.port.execute(f.context, f.request, 'migrate')).toEqual({
      state: 'blocked',
      reason: 'DivergentCandidates',
    })
  })

  it('rejects local report claims unless the trusted inline program and a stable current source Pod validate them', async () => {
    const f = fixture()
    const source = f.sourcePod()
    const verified = await f.port.verifyStoppedWriter(f.context, f.request)
    expect(verified).toMatchObject({
      verified: true,
      proof: { sourcePodUid: 'source-pod', sourceRestartCount: 0 },
    })
    expect(f.execProgram.mock.calls[0][3]).toBe(CONVERSATION_STORE_BOOTSTRAP_VERIFY_PROGRAM)
    expect(f.apps.replaceNamespacedDeployment).not.toHaveBeenCalled()
    f.execProgram.mockImplementationOnce(async () => {
      source.status!.containerStatuses![0].restartCount = 1
      return JSON.stringify({
        proofVersion: 1,
        storageContract: 'canonical',
        outcome: 'ok',
        hostUid: HOST,
        pvcUid: PVC,
        maintenanceId: MAINT,
        sourcePodUid: 'source-pod',
        requestId: REQUEST,
        requestHash: computeConversationStoreRequestHash(f.request),
        exportId: EXPORT,
        manifestHash: HASH,
        sourceSnapshotHash: SNAPSHOT,
      })
    })
    expect(await f.port.verifyStoppedWriter(f.context, f.request)).toEqual({
      verified: false,
      reason: 'SourceWriterChanged',
    })
  })

  it('keeps source mutation closed when Kubernetes exec authority is unavailable', async () => {
    const f = fixture()
    f.sourcePod()
    f.execProgram.mockRejectedValue({ code: 403 })
    expect(await f.port.verifyStoppedWriter(f.context, f.request)).toEqual({
      verified: false,
      reason: 'BootstrapVerificationUnavailable',
    })
    expect(f.apps.replaceNamespacedDeployment).not.toHaveBeenCalled()
    expect(f.batch.createNamespacedJob).not.toHaveBeenCalled()
  })

  it('does not create a writable helper while an unverified legacy PVC writer exists', async () => {
    const f = fixture()
    f.sourcePod()
    await expect(f.port.execute(f.context, f.request, 'migrate')).rejects.toThrow(
      'UnverifiedPvcWriterPresent'
    )
    expect(f.batch.createNamespacedJob).not.toHaveBeenCalled()
  })
})

it('retains a different OCI config CRI identity without confusing it with the requested manifest', async () => {
  const f = fixture()
  await f.port.execute(f.context, f.request, 'preparation')
  const job = [...f.jobs.values()][0]
  job.status = { succeeded: 1 }
  const pod = f.helperPod(job, f.physical(job))
  const resolved = `containerd://sha256:${'e'.repeat(64)}`
  pod.status!.containerStatuses![0].imageID = resolved
  expect((await f.port.execute(f.context, f.request, 'preparation')).state).toBe('succeeded')
  expect(f.host.status?.conversationStore?.execution).toMatchObject({
    image: IMAGE,
    resolvedImageId: resolved,
    imageProvenance: 'pod-immutable-reference',
    requestHash: computeConversationStoreRequestHash(f.request),
  })
})
