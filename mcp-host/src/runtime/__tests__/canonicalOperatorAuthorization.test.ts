import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  V1Job,
  V1PersistentVolumeClaim,
  V1Pod,
  V1SelfSubjectReview,
} from '@kubernetes/client-node'
import {
  type CanonicalOperatorHost,
  type CanonicalOperatorReaders,
  type CanonicalOperatorRequest,
  type CanonicalOperatorResolveInput,
  authorizeCanonicalOperator,
  computeCanonicalOperatorRequestHash,
  resolveCanonicalOperatorRequest,
  resolveCanonicalOperatorRequestForTesting,
} from '../canonicalOperatorAuthorization'

const sdk = vi.hoisted(() => ({
  loadFromCluster: vi.fn(),
  loadFromDefault: vi.fn(),
  makeApiClient: vi.fn(),
}))
vi.mock('@kubernetes/client-node', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    KubeConfig: class {
      loadFromCluster() {
        sdk.loadFromCluster()
      }
      loadFromDefault() {
        sdk.loadFromDefault()
      }
      makeApiClient() {
        return sdk.makeApiClient()
      }
    },
  }
})

const HOST = 'host-current'
const PVC = 'pvc-current'
const POD = 'pod-current'
const JOB = 'job-current'
const REQUEST = '10000000-0000-4000-8000-000000000001'
const MAINTENANCE = '10000000-0000-4000-8000-000000000002'
const MIGRATION = '10000000-0000-4000-8000-000000000003'
const STORE = '10000000-0000-4000-8000-000000000004'
const BIRTH = '2026-09-30T10:00:00.000Z'
const HASH = 'a'.repeat(64)
const IMAGE = `example.invalid/mcp-host@sha256:${'b'.repeat(64)}`
const context = { hostName: 'chatllm', namespace: 'mcp-host', podUid: POD }

function fixture(
  input: CanonicalOperatorResolveInput = {
    requestId: REQUEST,
    operation: 'adopt',
    action: 'adopt',
  },
  sourceClass = 'sqlite-pvc',
  storageContract: 'legacy-floor' | 'canonical' = 'canonical'
) {
  const readonly = input.action === 'verify-preparation'
  const phase = readonly
    ? 'preparation'
    : input.action === 'verify-current'
      ? 'current'
      : input.action
  const request: Record<string, unknown> = {
    schemaVersion: 1,
    requestId: REQUEST,
    operation: input.operation,
    storageContract,
    hostUid: HOST,
    pvcUid: PVC,
    maintenanceId: MAINTENANCE,
    principal: { kind: 'control-admin', subject: 'operator-current' },
  }
  if (input.operation === 'adopt')
    Object.assign(request, { migrationId: MIGRATION, manifestHash: HASH, candidateHash: HASH })
  if (input.operation === 'prepare')
    Object.assign(request, {
      targetImage: IMAGE,
      templateRevision: HASH,
      sourceClass,
      ...(sourceClass === 'new-host' ? {} : { manifestHash: HASH }),
    })
  if (input.operation === 'release')
    Object.assign(request, {
      ...(storageContract === 'canonical'
        ? { expectedStoreId: STORE }
        : { expectedMigrationId: MIGRATION }),
      expectedCurrentCatalogHash: HASH,
    })
  const requestHash = computeCanonicalOperatorRequestHash(
    request as unknown as CanonicalOperatorRequest
  )
  const spec = {
    serviceAccountName: 'cs-current',
    containers: [
      {
        name: 'conversation-store-operator',
        image: IMAGE,
        volumeMounts: [{ name: 'workspace', mountPath: '/mnt/workspace-root', readOnly: readonly }],
      },
    ],
    volumes: [{ name: 'workspace', persistentVolumeClaim: { claimName: 'chatllm-workspace' } }],
  }
  const job: V1Job = {
    metadata: {
      name: 'cs-current',
      namespace: context.namespace,
      uid: JOB,
      resourceVersion: 'job-1',
      ownerReferences: [
        {
          apiVersion: 'clerum.io/v1alpha1',
          kind: 'Host',
          name: context.hostName,
          uid: HOST,
          controller: true,
        },
      ],
      annotations: {
        'clerum.io/conversation-store-request-id': REQUEST,
        'clerum.io/conversation-store-request-hash': requestHash,
        'clerum.io/host-uid': HOST,
        'clerum.io/conversation-store-template-revision': HASH,
      },
    },
    spec: { template: { spec } },
    status: { active: 1 },
  }
  const pod: V1Pod = {
    metadata: {
      name: 'cs-current-pod',
      namespace: context.namespace,
      uid: POD,
      resourceVersion: 'pod-1',
      ownerReferences: [
        { apiVersion: 'batch/v1', kind: 'Job', name: 'cs-current', uid: JOB, controller: true },
      ],
    },
    spec: structuredClone(spec),
    status: { phase: 'Running' },
  }
  const pvc: V1PersistentVolumeClaim = {
    metadata: {
      name: 'chatllm-workspace',
      namespace: context.namespace,
      uid: PVC,
      resourceVersion: 'pvc-1',
      creationTimestamp: new Date(BIRTH),
    },
    status: { phase: 'Bound' },
  }
  const review: V1SelfSubjectReview = {
    status: {
      userInfo: {
        username: 'system:serviceaccount:mcp-host:cs-current',
        uid: 'service-account-current',
        extra: {
          'authentication.kubernetes.io/pod-name': ['cs-current-pod'],
          'authentication.kubernetes.io/pod-uid': [POD],
        },
      },
    },
  }
  const finalizing = input.action === 'verify-current' && input.operation !== 'release'
  const host: CanonicalOperatorHost = {
    metadata: {
      name: context.hostName,
      namespace: context.namespace,
      uid: HOST,
      resourceVersion: 'host-1',
      ...(storageContract === 'canonical'
        ? { annotations: { 'clerum.io/canonical-store': 'enabled' } }
        : {}),
      creationTimestamp: BIRTH,
    },
    status: {
      conversationStore: {
        request,
        requestResult: { requestId: REQUEST, hostUid: HOST, pvcUid: PVC, state: 'accepted' },
        maintenance: {
          maintenanceId: MAINTENANCE,
          hostUid: HOST,
          pvcUid: PVC,
          phase:
            input.operation === 'release'
              ? 'completed'
              : finalizing
                ? 'completing'
                : readonly
                  ? 'quiescing'
                  : 'fenced',
        },
        execution: {
          requestId: REQUEST,
          operation: input.operation,
          phase,
          storageContract,
          requestHash,
          hostUid: HOST,
          pvcUid: PVC,
          maintenanceId: MAINTENANCE,
          jobName: 'cs-current',
          jobUid: JOB,
          image: IMAGE,
          templateRevision: HASH,
        },
        ...(input.operation === 'release'
          ? storageContract === 'canonical'
            ? { layout: { version: 1, hostUid: HOST, pvcUid: PVC, state: 'ready', storeId: STORE } }
            : {
                compatibility: {
                  storageContract: 'legacy-floor',
                  hostUid: HOST,
                  pvcUid: PVC,
                  layoutVersion: 1,
                  migrationId: MIGRATION,
                  catalogHash: HASH,
                  databasePath: 'state/state.db',
                  writerFenceRoot: 'state',
                },
              }
          : {}),
        ...(sourceClass === 'new-host'
          ? {
              provisioningIntent: {
                schemaVersion: 1,
                hostUid: HOST,
                hostCreatedAt: BIRTH,
                source: 'watch-added',
                observedResourceVersion: 'host-born',
                watchResourceVersion: 'watch-born',
                recordedAt: BIRTH,
              },
              provisioning: { hostUid: HOST, pvcUid: PVC, createdAt: BIRTH },
            }
          : {}),
      },
    },
  }
  const previous = new Map<string, V1Job>()
  function successfulJob(name: string, uid: string, readonlyRoot: boolean) {
    const completed = structuredClone(job)
    completed.metadata!.name = name
    completed.metadata!.uid = uid
    completed.metadata!.resourceVersion = `${uid}-1`
    completed.spec!.template.spec!.containers[0].volumeMounts![0].readOnly = readonlyRoot
    completed.status = {
      succeeded: 1,
      active: 0,
      conditions: [{ type: 'Complete', status: 'True' }],
    }
    previous.set(name, completed)
    return completed
  }
  if (
    input.operation === 'prepare' &&
    (input.action === 'migrate' || input.action === 'layout-precheck')
  ) {
    successfulJob('cs-preparation', 'preparation-job', true)
    host.status!.conversationStore!.preparation = {
      storageContract,
      requestId: REQUEST,
      hostUid: HOST,
      pvcUid: PVC,
      maintenanceId: MAINTENANCE,
      sourceClass,
      templateRevision: HASH,
      image: IMAGE,
      manifestHash: HASH,
      provenance: sourceClass === 'new-host' ? 'new' : 'existing',
      verificationJobName: 'cs-preparation',
      verificationJobUid: 'preparation-job',
    }
  }
  if (finalizing) {
    successfulJob('cs-mutator', 'mutator-job', false)
    host.status!.conversationStore!.operationOutcome = {
      storageContract,
      requestId: REQUEST,
      operation: input.operation,
      hostUid: HOST,
      pvcUid: PVC,
      maintenanceId: MAINTENANCE,
      catalogHash: HASH,
      ...(storageContract === 'canonical'
        ? { storeId: STORE }
        : {
            migrationId: MIGRATION,
            layoutVersion: 1,
            databasePath: 'state/state.db',
            writerFenceRoot: 'state',
          }),
      reason: input.operation === 'adopt' ? 'Adopted' : 'Created',
      jobName: 'cs-mutator',
      jobUid: 'mutator-job',
    }
  }
  const readers = {
    selfSubjectReview: vi.fn(async () => structuredClone(review)),
    readHost: vi.fn(async (name: string, namespace: string) => {
      if (name !== context.hostName || namespace !== context.namespace)
        throw new Error('unexpected Host read')
      return structuredClone(host)
    }),
    readPod: vi.fn(async (name: string, namespace: string) => {
      if (name !== 'cs-current-pod' || namespace !== context.namespace)
        throw new Error('unexpected Pod read')
      return structuredClone(pod)
    }),
    readJob: vi.fn(async (name: string, namespace: string) => {
      if (namespace !== context.namespace) throw new Error('unexpected Job namespace')
      return structuredClone(name === 'cs-current' ? job : previous.get(name)!)
    }),
    readPvc: vi.fn(async (name: string, namespace: string) => {
      if (name !== 'chatllm-workspace' || namespace !== context.namespace)
        throw new Error('unexpected PVC read')
      return structuredClone(pvc)
    }),
  } satisfies CanonicalOperatorReaders
  function refreshRequestHash() {
    const hash = computeCanonicalOperatorRequestHash(request as unknown as CanonicalOperatorRequest)
    ;(host.status!.conversationStore!.execution as Record<string, unknown>).requestHash = hash
    for (const current of [job, ...previous.values()])
      current.metadata!.annotations!['clerum.io/conversation-store-request-hash'] = hash
  }
  return {
    input,
    context,
    host,
    pod,
    job,
    pvc,
    review,
    previous,
    readers,
    request,
    refreshRequestHash,
  }
}
const resolve = (f: ReturnType<typeof fixture>) =>
  resolveCanonicalOperatorRequestForTesting(f.input, { context: f.context, readers: f.readers })

beforeEach(() => {
  sdk.loadFromCluster.mockReset()
  sdk.loadFromDefault.mockReset()
  sdk.makeApiClient.mockReset()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('fresh canonical operator authorization', () => {
  it('issues adoption authority only after fresh authenticated ownership checks', async () => {
    const f = fixture()
    const result = await resolve(f)
    expect(result.operation).toBe('adopt')
    expect(result.action).toBe('adopt')
    if (result.action !== 'adopt') throw new Error('wrong capability')
    expect(result.authorization).toMatchObject({
      authorized: true,
      kind: 'canonical-adoption',
      storageContract: 'canonical',
      principal: 'operator-current',
      hostUid: HOST,
      pvcUid: PVC,
      maintenanceId: MAINTENANCE,
      requestId: REQUEST,
    })
    expect(result.request).not.toHaveProperty('principal')
    expect(result.proof.rootMountPath).toBe('/mnt/workspace-root')
    expect(f.readers.readHost).toHaveBeenCalledTimes(2)
    expect(f.readers.selfSubjectReview).toHaveBeenCalledTimes(2)
  })
  it.each(['missing-pod', 'wrong-pod', 'foreign-namespace', 'different-service-account'])(
    'refuses a claimed environment identity without its authenticated Pod binding: %s',
    async fault => {
      const f = fixture()
      if (fault === 'missing-pod') f.review.status!.userInfo!.extra = {}
      if (fault === 'wrong-pod')
        f.review.status!.userInfo!.extra!['authentication.kubernetes.io/pod-uid'] = ['pod-other']
      if (fault === 'foreign-namespace')
        f.review.status!.userInfo!.username = 'system:serviceaccount:other:cs-current'
      if (fault === 'different-service-account')
        f.review.status!.userInfo!.username = 'system:serviceaccount:mcp-host:cs-other'
      await expect(resolve(f)).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
    }
  )
  it.each(['Host', 'PVC', 'Pod', 'Job'])(
    'refuses a same-name replaced physical %s',
    async target => {
      const f = fixture()
      const resource = { Host: f.host, PVC: f.pvc, Pod: f.pod, Job: f.job }[target]!
      resource.metadata!.uid = 'replaced-uid'
      await expect(resolve(f)).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
    }
  )
  it.each(['principal', 'request-id', 'operation', 'phase', 'execution-id', 'image', 'mount'])(
    'rejects forged or stale authority pins: %s',
    async fault => {
      const f = fixture()
      const store = f.host.status!.conversationStore!
      if (fault === 'principal')
        f.request.principal = { kind: 'tenant', subject: 'operator-current' }
      if (fault === 'request-id') f.request.requestId = MAINTENANCE
      if (fault === 'operation') f.request.operation = 'prepare'
      if (fault === 'phase') (store.maintenance as Record<string, unknown>).phase = 'quiescing'
      if (fault === 'execution-id')
        (store.execution as Record<string, unknown>).requestId = MAINTENANCE
      if (fault === 'image') f.pod.spec!.containers[0].image = 'example.invalid/untrusted'
      if (fault === 'mount') f.pod.spec!.containers[0].volumeMounts![0].subPath = 'state'
      await expect(resolve(f)).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
    }
  )
  it('does not let caller booleans or absent authorized records create capability', async () => {
    const f = fixture()
    delete f.host.status!.conversationStore!.request
    await expect(
      resolveCanonicalOperatorRequestForTesting({ ...f.input, authorized: true } as never, {
        context,
        readers: f.readers,
      })
    ).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
  })
  it('rejects a request replacement while physical resources are being resolved', async () => {
    const f = fixture()
    f.readers.readPvc.mockImplementation(async () => {
      f.host.metadata!.resourceVersion = 'host-2'
      f.request.candidateHash = 'c'.repeat(64)
      return structuredClone(f.pvc)
    })
    await expect(resolve(f)).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
  })
  it('rejects a last-read authentication or physical resource replacement', async () => {
    const f = fixture()
    f.readers.readPod
      .mockImplementationOnce(async () => structuredClone(f.pod))
      .mockImplementation(async () => ({
        ...structuredClone(f.pod),
        metadata: { ...f.pod.metadata, resourceVersion: 'pod-2' },
      }))
    await expect(resolve(f)).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
  })
  it('carries the complete recovery pair and refuses a stale current-store ID', async () => {
    const f = fixture()
    Object.assign(f.request, { expectedStoreId: STORE, expectedCurrentCatalogHash: HASH })
    f.refreshRequestHash()
    f.host.status!.conversationStore!.layout = {
      hostUid: HOST,
      pvcUid: PVC,
      storeId: STORE,
      state: 'ready',
    }
    const result = await resolve(f)
    if (result.action !== 'adopt') throw new Error('wrong capability')
    expect(result.request).toMatchObject({
      expectedStoreId: STORE,
      expectedCurrentCatalogHash: HASH,
    })
    ;(f.host.status!.conversationStore!.layout as Record<string, unknown>).storeId = REQUEST
    await expect(resolve(f)).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
  })
  it('uses a distinct readonly preparation capability and does not infer quiescence', async () => {
    const f = fixture({ requestId: REQUEST, operation: 'prepare', action: 'verify-preparation' })
    const result = await resolve(f)
    expect(result.authorization).toMatchObject({
      kind: 'canonical-preparation-verification',
      operation: 'prepare',
      action: 'verify-preparation',
    })
    expect(result.authorization).not.toHaveProperty('authorized')
    expect(result.proof.rootReadOnly).toBe(true)
    f.pod.spec!.containers[0].volumeMounts![0].readOnly = false
    f.job.spec!.template.spec!.containers[0].volumeMounts![0].readOnly = false
    await expect(resolve(f)).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
  })
  it('requires a real successful preparation predecessor before migration', async () => {
    const f = fixture({ requestId: REQUEST, operation: 'prepare', action: 'migrate' })
    expect((await resolve(f)).authorization).toMatchObject({
      kind: 'canonical-migration',
      verifiedManifestHash: HASH,
    })
    f.previous.get('cs-preparation')!.status!.conditions = [{ type: 'Failed', status: 'True' }]
    await expect(resolve(f)).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
  })
  it('separates new-host initialization and requires actual Host/PVC birth receipts', async () => {
    const f = fixture({ requestId: REQUEST, operation: 'prepare', action: 'migrate' }, 'new-host')
    const result = await resolve(f)
    expect(result.authorization).toMatchObject({
      kind: 'canonical-new-host-initialization',
      verifiedManifestHash: HASH,
      provisioning: { hostUid: HOST, pvcUid: PVC, createdAt: BIRTH },
    })
    f.pvc.metadata!.creationTimestamp = new Date('2026-09-30T11:00:00Z')
    await expect(resolve(f)).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
  })
  it.each(['cold-list', 'retained', 'established'])(
    'does not turn a new-host request into positive provenance for %s',
    async fault => {
      const f = fixture({ requestId: REQUEST, operation: 'prepare', action: 'migrate' }, 'new-host')
      const store = f.host.status!.conversationStore!
      if (fault === 'cold-list') delete store.provisioningIntent
      if (fault === 'retained') delete store.provisioning
      if (fault === 'established') store.compatibility = { contractVersion: 1 }
      await expect(resolve(f)).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
    }
  )
  it.each(['prepare', 'adopt'] as const)(
    'grants final verification only from a real successful %s mutator while completing',
    async operation => {
      const f = fixture({ requestId: REQUEST, operation, action: 'verify-current' })
      const result = await resolve(f)
      expect(result.authorization).toMatchObject({
        kind: 'canonical-finalization-verification',
        expectedStoreId: STORE,
        mutatorJobUid: 'mutator-job',
      })
      expect(result.authorization).not.toHaveProperty('authorized')
      f.previous.get('cs-mutator')!.metadata!.uid = 'mutator-recreated'
      await expect(resolve(f)).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
    }
  )
  it('does not conflate finalization and release verification', async () => {
    const f = fixture({ requestId: REQUEST, operation: 'release', action: 'verify-current' })
    expect((await resolve(f)).authorization).toMatchObject({
      kind: 'canonical-verification',
      operation: 'release',
      action: 'verify-current',
    })
    ;(f.host.status!.conversationStore!.maintenance as Record<string, unknown>).phase = 'completing'
    await expect(resolve(f)).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
  })
  it('waits only for the exact authenticated own-Pod read grant, without widening authority', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.readers.readPod.mockRejectedValueOnce({ code: 403 })
    const pending = resolveCanonicalOperatorRequestForTesting(f.input, {
      context,
      readers: f.readers,
      bootstrapWaitMs: 500,
    })
    await vi.advanceTimersByTimeAsync(250)
    expect((await pending).action).toBe('adopt')
    expect(
      f.readers.readPod.mock.calls.every(
        call => call[0] === 'cs-current-pod' && call[1] === 'mcp-host'
      )
    ).toBe(true)
  })
  it('does not leak SDK errors or turn unavailable API state into authority', async () => {
    const f = fixture()
    f.readers.readHost.mockRejectedValue(new Error('fixture upstream failure'))
    await expect(resolve(f)).rejects.toMatchObject({
      reason: 'AdoptUnauthorized',
      message: 'AdoptUnauthorized',
    })
  })
  it('the real default uses in-cluster SDK identity and compares principal and full pins', async () => {
    const f = fixture()
    vi.stubEnv('CLERUM_HOST_NAME', context.hostName)
    vi.stubEnv('CLERUM_HOST_NAMESPACE', context.namespace)
    vi.stubEnv('CLERUM_CANONICAL_POD_UID', context.podUid)
    sdk.makeApiClient.mockReturnValue({
      createSelfSubjectReview: () => f.readers.selfSubjectReview(),
      getNamespacedCustomObject: () => f.readers.readHost(context.hostName, context.namespace),
      readNamespacedPod: () => f.readers.readPod('cs-current-pod', context.namespace),
      readNamespacedJob: ({ name }: { name: string }) => f.readers.readJob(name, context.namespace),
      readNamespacedPersistentVolumeClaim: () =>
        f.readers.readPvc('chatllm-workspace', context.namespace),
    })
    const resolved = await resolveCanonicalOperatorRequest(f.input)
    if (resolved.action !== 'adopt') throw new Error('wrong capability')
    expect(sdk.loadFromCluster).toHaveBeenCalledOnce()
    expect(sdk.loadFromDefault).not.toHaveBeenCalled()
    await expect(
      authorizeCanonicalOperator({
        binding: resolved.binding,
        request: resolved.request,
        maintenanceId: MAINTENANCE,
        principal: 'forged-operator',
        operation: 'adopt',
      })
    ).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
    await expect(
      authorizeCanonicalOperator({
        binding: resolved.binding,
        request: { ...resolved.request, candidateHash: 'd'.repeat(64) },
        maintenanceId: MAINTENANCE,
        principal: resolved.principal,
        operation: 'adopt',
      })
    ).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
  })
  it.each(['request', 'execution', 'job'] as const)(
    'requires complete immutable request hash binding at %s',
    async target => {
      const f = fixture()
      if (target === 'request')
        f.request.principal = { kind: 'control-admin', subject: 'other-current-administrator' }
      if (target === 'execution')
        (f.host.status!.conversationStore!.execution as Record<string, unknown>).requestHash =
          'f'.repeat(64)
      if (target === 'job')
        f.job.metadata!.annotations!['clerum.io/conversation-store-request-hash'] = 'f'.repeat(64)
      await expect(resolve(f)).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
    }
  )
  it('uses the same immutable request identity regardless of JSON field order', () => {
    const f = fixture()
    const reversed = Object.fromEntries(
      Object.entries(f.request).reverse()
    ) as unknown as CanonicalOperatorRequest
    reversed.principal = { subject: 'operator-current', kind: 'control-admin' }
    expect(computeCanonicalOperatorRequestHash(reversed)).toBe(
      computeCanonicalOperatorRequestHash(f.request as unknown as CanonicalOperatorRequest)
    )
    reversed.storageContract = 'legacy-floor'
    expect(computeCanonicalOperatorRequestHash(reversed)).not.toBe(
      computeCanonicalOperatorRequestHash(f.request as unknown as CanonicalOperatorRequest)
    )
  })
  it('grants a distinct floor preparation capability only for the physical readonly Job', async () => {
    const f = fixture(
      { requestId: REQUEST, operation: 'prepare', action: 'verify-preparation' },
      'sqlite-pvc',
      'legacy-floor'
    )
    const result = await resolve(f)
    expect(result).toMatchObject({
      storageContract: 'legacy-floor',
      authorization: {
        kind: 'legacy-floor-preparation-verification',
        storageContract: 'legacy-floor',
      },
    })
    expect(result.authorization).not.toHaveProperty('authorized')
    f.pod.spec!.containers[0].volumeMounts![0].readOnly = false
    f.job.spec!.template.spec!.containers[0].volumeMounts![0].readOnly = false
    await expect(resolve(f)).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
  })
  it('grants only the floor layout-precheck mutation after verified preparation', async () => {
    const f = fixture(
      { requestId: REQUEST, operation: 'prepare', action: 'layout-precheck' },
      'sqlite-pvc',
      'legacy-floor'
    )
    expect(await resolve(f)).toMatchObject({
      storageContract: 'legacy-floor',
      action: 'layout-precheck',
      authorization: { kind: 'legacy-floor-migration', verifiedManifestHash: HASH },
    })
    f.previous.get('cs-preparation')!.metadata!.annotations![
      'clerum.io/conversation-store-request-hash'
    ] = 'f'.repeat(64)
    await expect(resolve(f)).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
  })
  it('keeps real-new-PVC provenance separate from a floor migration capability', async () => {
    const f = fixture(
      { requestId: REQUEST, operation: 'prepare', action: 'layout-precheck' },
      'new-host',
      'legacy-floor'
    )
    expect((await resolve(f)).authorization).toMatchObject({
      kind: 'legacy-floor-new-host-initialization',
      provisioning: { hostUid: HOST, pvcUid: PVC, createdAt: BIRTH },
    })
    delete f.host.status!.conversationStore!.provisioningIntent
    await expect(resolve(f)).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
  })
  it.each(['canonical-with-floor-action', 'floor-with-canonical-action'])(
    'refuses mutation capabilities from the other storage contract: %s',
    async mismatch => {
      const f =
        mismatch === 'canonical-with-floor-action'
          ? fixture({ requestId: REQUEST, operation: 'prepare', action: 'layout-precheck' })
          : fixture(
              { requestId: REQUEST, operation: 'prepare', action: 'migrate' },
              'sqlite-pvc',
              'legacy-floor'
            )
      await expect(resolve(f)).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
    }
  )
  it.each(['annotation', 'durable-layout', 'canonical-outcome'])(
    'cannot resolve a floor capability after canonical commitment from %s',
    async source => {
      const f = fixture(
        { requestId: REQUEST, operation: 'prepare', action: 'layout-precheck' },
        'sqlite-pvc',
        'legacy-floor'
      )
      if (source === 'annotation')
        f.host.metadata!.annotations = { 'clerum.io/canonical-store': 'enabled' }
      if (source === 'durable-layout') f.host.status!.conversationStore!.layout = { version: 1 }
      if (source === 'canonical-outcome')
        f.host.status!.conversationStore!.operationOutcome = {
          storageContract: 'canonical',
          storeId: STORE,
        }
      await expect(resolve(f)).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
    }
  )
  it.each(['prepare', 'adopt'] as const)(
    'pins complete floor finalization to a real successful %s mutator without a store ID',
    async operation => {
      const f = fixture(
        { requestId: REQUEST, operation, action: 'verify-current' },
        'sqlite-pvc',
        'legacy-floor'
      )
      const result = await resolve(f)
      expect(result).toMatchObject({
        storageContract: 'legacy-floor',
        expectedMigrationId: MIGRATION,
        expectedCurrentCatalogHash: HASH,
        authorization: {
          kind: 'legacy-floor-finalization-verification',
          mutatorJobUid: 'mutator-job',
        },
      })
      expect(result).not.toHaveProperty('expectedStoreId')
      ;(f.host.status!.conversationStore!.operationOutcome as Record<string, unknown>).storeId =
        STORE
      await expect(resolve(f)).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
    }
  )
  it.each(['prepare', 'adopt'] as const)(
    'verifies an archived floor %s retry only from its complete AlreadyLegacy outcome',
    async operation => {
      const f = fixture(
        { requestId: REQUEST, operation, action: 'verify-current' },
        'sqlite-pvc',
        'legacy-floor'
      )
      ;(f.host.status!.conversationStore!.operationOutcome as Record<string, unknown>).reason =
        'AlreadyLegacy'
      expect(await resolve(f)).toMatchObject({
        storageContract: 'legacy-floor',
        expectedMigrationId: MIGRATION,
        expectedCurrentCatalogHash: HASH,
        authorization: {
          kind: 'legacy-floor-finalization-verification',
          mutatorJobUid: 'mutator-job',
        },
      })
    }
  )
  it.each([
    'canonical',
    'host-binding',
    'pvc-binding',
    'missing-layout-version',
    'catalog-format',
    'mutator-request-hash',
    'changed-current-catalog',
  ])('rejects an AlreadyLegacy outcome with invalid %s proof', async fault => {
    const f = fixture(
      { requestId: REQUEST, operation: 'prepare', action: 'verify-current' },
      'sqlite-pvc',
      fault === 'canonical' ? 'canonical' : 'legacy-floor'
    )
    const completed = f.host.status!.conversationStore!.operationOutcome as Record<string, unknown>
    completed.reason = 'AlreadyLegacy'
    if (fault === 'host-binding') completed.hostUid = 'host-other'
    if (fault === 'pvc-binding') completed.pvcUid = 'pvc-other'
    if (fault === 'missing-layout-version') delete completed.layoutVersion
    if (fault === 'catalog-format') completed.catalogHash = 'invalid-hash'
    if (fault === 'mutator-request-hash')
      f.previous.get('cs-mutator')!.metadata!.annotations![
        'clerum.io/conversation-store-request-hash'
      ] = 'e'.repeat(64)
    if (fault === 'changed-current-catalog') {
      f.readers.readHost
        .mockImplementationOnce(async () => structuredClone(f.host))
        .mockImplementation(async () => {
          const changed = structuredClone(f.host)
          ;(
            changed.status!.conversationStore!.operationOutcome as Record<string, unknown>
          ).catalogHash = 'e'.repeat(64)
          return changed
        })
    }
    await expect(resolve(f)).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
  })
  it.each(['migration', 'path', 'fence-root', 'identity'])(
    'refuses invalid completed floor release evidence: %s',
    async fault => {
      const f = fixture(
        { requestId: REQUEST, operation: 'release', action: 'verify-current' },
        'sqlite-pvc',
        'legacy-floor'
      )
      expect((await resolve(f)).authorization).toMatchObject({ kind: 'legacy-floor-verification' })
      const compatibility = f.host.status!.conversationStore!.compatibility as Record<
        string,
        unknown
      >
      if (fault === 'migration') compatibility.migrationId = REQUEST
      if (fault === 'path') compatibility.databasePath = 'state.db'
      if (fault === 'fence-root') compatibility.writerFenceRoot = 'workspace'
      if (fault === 'identity') compatibility.storeId = STORE
      await expect(resolve(f)).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
    }
  )
  it('keeps a fresh floor current hash bound to the request after the establishment snapshot becomes historical', async () => {
    const f = fixture(
      { requestId: REQUEST, operation: 'release', action: 'verify-current' },
      'sqlite-pvc',
      'legacy-floor'
    )
    // The full SQLite accepted-write/physical verification witness lives in
    // db/canonicalStore/__tests__/legacyFloor.test.ts. This boundary proves
    // the readonly release capability retains the operator's fresh current pin.
    f.request.expectedCurrentCatalogHash = 'e'.repeat(64)
    f.refreshRequestHash()
    const result = await resolve(f)
    expect(result).toMatchObject({
      storageContract: 'legacy-floor',
      request: { expectedMigrationId: MIGRATION, expectedCurrentCatalogHash: 'e'.repeat(64) },
    })
    expect(result.authorization).toMatchObject({ kind: 'legacy-floor-verification' })
    expect(result.authorization).not.toHaveProperty('authorized')
  })
  it('keeps floor adoption and recovery authority separate from canonical identities', async () => {
    const f = fixture(
      { requestId: REQUEST, operation: 'adopt', action: 'adopt' },
      'sqlite-pvc',
      'legacy-floor'
    )
    expect(await resolve(f)).toMatchObject({
      storageContract: 'legacy-floor',
      authorization: { kind: 'legacy-floor-adoption', authorized: true },
    })
    Object.assign(f.request, { expectedMigrationId: MIGRATION, expectedCurrentCatalogHash: HASH })
    f.refreshRequestHash()
    f.host.status!.conversationStore!.compatibility = {
      storageContract: 'legacy-floor',
      hostUid: HOST,
      pvcUid: PVC,
      layoutVersion: 1,
      migrationId: MIGRATION,
      catalogHash: HASH,
      databasePath: 'state/state.db',
      writerFenceRoot: 'state',
    }
    const recovery = await resolve(f)
    if (recovery.action !== 'adopt' || recovery.storageContract !== 'legacy-floor')
      throw new Error('wrong floor adoption capability')
    expect(recovery.request).toMatchObject({
      expectedMigrationId: MIGRATION,
      expectedCurrentCatalogHash: HASH,
    })
    expect(recovery.request).not.toHaveProperty('expectedStoreId')
    delete f.request.expectedMigrationId
    delete f.request.expectedCurrentCatalogHash
    f.refreshRequestHash()
    await expect(resolve(f)).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
  })
  it('outside cluster or without explicit namespace has no local kubeconfig fallback', async () => {
    vi.stubEnv('CLERUM_HOST_NAME', context.hostName)
    vi.stubEnv('CLERUM_HOST_NAMESPACE', '')
    vi.stubEnv('CLERUM_CANONICAL_POD_UID', context.podUid)
    await expect(resolveCanonicalOperatorRequest(fixture().input)).rejects.toMatchObject({
      reason: 'AdoptUnauthorized',
    })
    expect(sdk.loadFromCluster).not.toHaveBeenCalled()
    vi.stubEnv('CLERUM_HOST_NAMESPACE', context.namespace)
    sdk.loadFromCluster.mockImplementation(() => {
      throw new Error('fixture outside cluster')
    })
    await expect(resolveCanonicalOperatorRequest(fixture().input)).rejects.toMatchObject({
      reason: 'AdoptUnauthorized',
    })
    expect(sdk.loadFromDefault).not.toHaveBeenCalled()
  })
})
