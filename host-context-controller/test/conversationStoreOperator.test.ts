import { describe, expect, it, vi } from 'vitest'
import { isDeepStrictEqual } from 'node:util'
import {
  type ConversationStoreExecution,
  ConversationStoreOperator,
  type ConversationStoreOperatorContext,
  type ConversationStoreOperatorPort,
  type ConversationStorePhysicalProof,
  type ConversationStoreWriterProof,
} from '../src/conversationStoreOperator'
import type { ConversationStoreRequest, HostCRD } from '../src/types'

const HOST = '11111111-1111-4111-8111-111111111111'
const PVC = '22222222-2222-4222-8222-222222222222'
const MAINTENANCE = '33333333-3333-4333-8333-333333333333'
const EXPORT = '44444444-4444-4444-8444-444444444444'
const MIGRATION = '55555555-5555-4555-8555-555555555555'
const STORE = '66666666-6666-4666-8666-666666666666'
const REQUEST = '77777777-7777-4777-8777-777777777777'
const JOB = '88888888-8888-4888-8888-888888888888'
const HASH = 'a'.repeat(64)
const SNAPSHOT = 'b'.repeat(64)
const CATALOG = 'c'.repeat(64)
const IMAGE = `ghcr.io/palmeradao/mcp-host@sha256:${'d'.repeat(64)}`
const REVISION = 'e'.repeat(64)
const NOW = '2026-09-30T12:00:00.000Z'

function request(
  operation: ConversationStoreRequest['operation'],
  fields: Partial<ConversationStoreRequest> = {}
): ConversationStoreRequest {
  return {
    schemaVersion: 1,
    storageContract: 'canonical',
    requestId: REQUEST,
    hostUid: HOST,
    pvcUid: PVC,
    maintenanceId: MAINTENANCE,
    operation,
    principal: { kind: 'control-admin', subject: 'operator-test' },
    ...fields,
  }
}
function proof(
  fields: Partial<ConversationStorePhysicalProof> = {}
): ConversationStorePhysicalProof {
  return {
    proofVersion: 1,
    storageContract: 'canonical',
    hostUid: HOST,
    pvcUid: PVC,
    maintenanceId: MAINTENANCE,
    sourceClass: 'sqlite-external-exported',
    exportId: EXPORT,
    manifestHash: HASH,
    sourceSnapshotHash: SNAPSHOT,
    migrationId: MIGRATION,
    candidateHash: SNAPSHOT,
    storeId: STORE,
    currentCatalogHash: CATALOG,
    ...fields,
  }
}
function writer(): ConversationStoreWriterProof {
  return {
    storageContract: 'canonical',
    hostUid: HOST,
    pvcUid: PVC,
    maintenanceId: MAINTENANCE,
    sourcePodUid: 'source-pod',
    sourceImageId: IMAGE,
    sourceRestartCount: 0,
    nodeName: 'test-node',
    exportId: EXPORT,
    manifestHash: HASH,
    sourceSnapshotHash: SNAPSHOT,
    verifiedAt: NOW,
  }
}
function fixture(req: ConversationStoreRequest, phase?: 'quiescing' | 'failed' | 'completed') {
  // The port is the unit boundary. Physical witnesses are supplied by the
  // separately tested Kubernetes helper transport, not caller booleans in production.
  let host = {
    name: 'alpha',
    namespace: 'mcp-host',
    uid: HOST,
    resourceVersion: '1',
    annotations:
      req.storageContract === 'canonical' ? { 'clerum.io/canonical-store': 'enabled' } : {},
    spec: {},
    status: {
      conversationStore: {
        request: req,
        ...(phase
          ? {
              maintenance: {
                storageContract: req.storageContract,
                phase,
                hostUid: HOST,
                pvcUid: PVC,
                maintenanceId: MAINTENANCE,
                startedAt: NOW,
                updatedAt: NOW,
              },
            }
          : {}),
      },
    },
  } as HostCRD
  const writes: unknown[] = []
  const physical: ConversationStoreExecution = {
    state: 'succeeded',
    outcome: { outcome: 'ok', reason: 'NoCollision' },
    proof: proof(),
  }
  const mutation: ConversationStoreExecution = {
    state: 'succeeded',
    outcome: {
      outcome: 'ok',
      storageContract: 'canonical',
      reason: 'SingleCandidate',
      layoutVersion: 1,
      storeId: STORE,
    },
  }
  const outputs = new Map<string, ConversationStoreExecution>([
    ['preparation', physical],
    ['migrate', mutation],
    [
      'adopt',
      {
        ...mutation,
        outcome: {
          outcome: 'ok',
          storageContract: 'canonical',
          reason: 'Adopted',
          layoutVersion: 1,
          storeId: STORE,
        },
      },
    ],
    ['current', physical],
  ])
  const port: ConversationStoreOperatorPort = {
    readFreshHost: vi.fn(async () => host),
    readPvcUid: vi.fn(async () => PVC),
    now: () => new Date(NOW),
    writeStatus: vi.fn(async (context, activeRequest, fields) => {
      if (!isDeepStrictEqual(host.status?.conversationStore?.request, activeRequest))
        throw new Error('OperatorBindingChanged')
      writes.push(fields)
      host = {
        ...host,
        resourceVersion: String(Number(host.resourceVersion) + 1),
        status: {
          ...host.status,
          conversationStore: { ...host.status?.conversationStore, ...fields },
        },
      }
      context.host = host
      return host
    }),
    verifyStoppedWriter: vi.fn(async () => ({ verified: true as const, proof: writer() })),
    stopLegacyDeployment: vi.fn(async () => {}),
    execute: vi.fn(async (context, activeRequest, step) => {
      const value = outputs.get(step)!
      if (value.state === 'succeeded') {
        host.status!.conversationStore!.execution = {
          storageContract: activeRequest.storageContract,
          requestHash: REVISION,
          requestId: activeRequest.requestId,
          hostUid: HOST,
          pvcUid: PVC,
          maintenanceId: MAINTENANCE,
          jobName: `job-${step}`,
          jobUid: JOB,
          image: IMAGE,
          templateRevision: REVISION,
          operation: activeRequest.operation as 'prepare' | 'adopt' | 'release',
          phase: step,
          createdAt: NOW,
        }
        context.host = host
      }
      return value
    }),
  }
  return {
    port,
    outputs,
    writes,
    get host() {
      return host
    },
    setHost(value: HostCRD) {
      host = value
    },
    context: {
      host,
      pvcName: 'alpha-workspace',
      pvcUid: PVC,
      image: IMAGE,
      templateRevision: REVISION,
      canonicalRequested: true,
      storageContract: req.storageContract,
    } as ConversationStoreOperatorContext,
    operator: new ConversationStoreOperator(port),
  }
}
const PREPARE = {
  sourceClass: 'sqlite-external-exported' as const,
  exportId: EXPORT,
  targetImage: IMAGE,
  templateRevision: REVISION,
  manifestHash: HASH,
}

describe('production canonical operator coordinator', () => {
  it('completes maintenance acknowledgement while latching quiescing and admitting no migration', async () => {
    const f = fixture(request('maintenance'))
    const result = await f.operator.reconcile(f.context)
    expect(result.held).toBe(true)
    expect(result.host.status?.conversationStore?.maintenance?.phase).toBe('quiescing')
    expect(result.host.status?.conversationStore?.requestResult?.state).toBe('completed')
    expect(f.port.execute).not.toHaveBeenCalled()
    expect(f.port.stopLegacyDeployment).not.toHaveBeenCalled()
    await f.operator.reconcile(f.context)
    expect(f.port.writeStatus).toHaveBeenCalledTimes(1)
  })

  it('verifies immutable physical export before stopping the original deployment, then completes under maintenance', async () => {
    const f = fixture(request('prepare', PREPARE), 'quiescing')
    const result = await f.operator.reconcile(f.context)
    expect(result.held).toBe(true)
    expect(result.host.status?.conversationStore).toMatchObject({
      requestResult: { state: 'completed' },
      preparation: { requestId: REQUEST, image: IMAGE, exportId: EXPORT },
      maintenance: { phase: 'completed' },
      layout: { state: 'ready', storeId: STORE },
      completion: { currentCatalogHash: CATALOG },
    })
    const steps = vi.mocked(f.port.execute).mock.calls.map(call => call[2])
    expect(steps).toEqual(['preparation', 'migrate', 'current'])
    const verificationOrder = vi.mocked(f.port.execute).mock.invocationCallOrder[0]
    expect(vi.mocked(f.port.stopLegacyDeployment).mock.invocationCallOrder[0]).toBeGreaterThan(
      verificationOrder
    )
  })

  it('keeps the source Pod intact while preparation verification is pending and resumes the same request', async () => {
    const f = fixture(request('prepare', PREPARE), 'quiescing')
    f.outputs.set('preparation', { state: 'pending' })
    expect((await f.operator.reconcile(f.context)).held).toBe(true)
    expect(f.port.stopLegacyDeployment).not.toHaveBeenCalled()
    expect(f.host.status?.conversationStore?.preparation).toBeUndefined()
    expect(f.host.status?.conversationStore?.requestResult?.state).toBe('accepted')
    f.outputs.set('preparation', {
      state: 'succeeded',
      outcome: { outcome: 'ok', reason: 'NoCollision' },
      proof: proof(),
    })
    expect(
      (await f.operator.reconcile(f.context)).host.status?.conversationStore?.requestResult?.state
    ).toBe('completed')
  })

  it('never creates a writable helper when source writer death is unknown', async () => {
    const f = fixture(request('prepare', PREPARE), 'quiescing')
    vi.mocked(f.port.verifyStoppedWriter).mockResolvedValue({
      verified: false,
      reason: 'SourceWriterIdentityUnknown',
    })
    const result = await f.operator.reconcile(f.context)
    expect(result.host.status?.conversationStore?.requestResult).toMatchObject({
      state: 'rejected',
      reason: 'SourceWriterIdentityUnknown',
    })
    expect(f.port.execute).not.toHaveBeenCalled()
    expect(f.port.stopLegacyDeployment).not.toHaveBeenCalled()
  })

  it.each([
    { manifestHash: SNAPSHOT },
    { sourceSnapshotHash: HASH },
    { pvcUid: HOST },
    { exportId: MIGRATION },
  ])(
    'rejects altered physical proof before the destructive source transition %j',
    async mismatch => {
      const f = fixture(request('prepare', PREPARE), 'quiescing')
      f.outputs.set('preparation', {
        state: 'succeeded',
        outcome: { outcome: 'ok', reason: 'NoCollision' },
        proof: proof(mismatch),
      })
      const result = await f.operator.reconcile(f.context)
      expect(result.host.status?.conversationStore?.requestResult?.reason).toBe(
        'PreparationEvidenceMismatch'
      )
      expect(f.port.stopLegacyDeployment).not.toHaveBeenCalled()
      expect(vi.mocked(f.port.execute).mock.calls.map(call => call[2])).toEqual(['preparation'])
    }
  )

  it('does not turn a compatible-image preparation into implicit canonical activation', async () => {
    const f = fixture(request('prepare', PREPARE), 'quiescing')
    f.context.canonicalRequested = false
    expect(
      (await f.operator.reconcile(f.context)).host.status?.conversationStore?.requestResult?.reason
    ).toBe('CanonicalActivationNotRequested')
    expect(f.port.verifyStoppedWriter).not.toHaveBeenCalled()
    expect(f.port.execute).not.toHaveBeenCalled()
    expect(f.port.stopLegacyDeployment).not.toHaveBeenCalled()
  })

  it('rejects an image tag and a caller assertion of new-host without actual PVC provisioning', async () => {
    const tag = fixture(request('prepare', { ...PREPARE, targetImage: 'host:v1' }), 'quiescing')
    tag.context.image = 'host:v1'
    expect(
      (await tag.operator.reconcile(tag.context)).host.status?.conversationStore?.requestResult
        ?.reason
    ).toBe('PreparationPinsRequired')
    const f = fixture(
      request('prepare', {
        sourceClass: 'new-host',
        targetImage: IMAGE,
        templateRevision: REVISION,
      }),
      'quiescing'
    )
    expect(
      (await f.operator.reconcile(f.context)).host.status?.conversationStore?.requestResult?.reason
    ).toBe('NewHostProvenanceMissing')
    expect(f.port.execute).not.toHaveBeenCalled()
  })

  it('accepts positive new-PVC provenance with an independently empty physical inventory', async () => {
    const f = fixture(
      request('prepare', {
        sourceClass: 'new-host',
        targetImage: IMAGE,
        templateRevision: REVISION,
      }),
      'quiescing'
    )
    f.host.status!.conversationStore!.provisioning = { hostUid: HOST, pvcUid: PVC, createdAt: NOW }
    f.outputs.set('preparation', {
      state: 'succeeded',
      outcome: { outcome: 'ok', reason: 'NoCollision' },
      proof: {
        proofVersion: 1,
        storageContract: 'canonical',
        hostUid: HOST,
        pvcUid: PVC,
        maintenanceId: MAINTENANCE,
        sourceClass: 'new-host',
        manifestHash: HASH,
      },
    })
    f.outputs.set('migrate', {
      state: 'succeeded',
      outcome: {
        outcome: 'ok',
        storageContract: 'canonical',
        reason: 'Created',
        layoutVersion: 1,
        storeId: STORE,
      },
    })
    expect(
      (await f.operator.reconcile(f.context)).host.status?.conversationStore?.maintenance?.phase
    ).toBe('completed')
    expect(f.port.verifyStoppedWriter).not.toHaveBeenCalled()
    expect(f.port.stopLegacyDeployment).not.toHaveBeenCalled()
  })

  it('preserves a blocked migration for a subsequent exact adoption and consumes no success timeout', async () => {
    const f = fixture(request('prepare', PREPARE), 'quiescing')
    f.outputs.set('migrate', { state: 'blocked', reason: 'DivergentCandidates' })
    const result = await f.operator.reconcile(f.context)
    expect(result.host.status?.conversationStore).toMatchObject({
      maintenance: { phase: 'failed' },
      requestResult: { state: 'rejected' },
    })
    const adopt = request('adopt', {
      requestId: MIGRATION,
      migrationId: MIGRATION,
      manifestHash: HASH,
      candidateHash: SNAPSHOT,
    })
    f.setHost({
      ...f.host,
      status: {
        ...f.host.status,
        conversationStore: { ...f.host.status?.conversationStore, request: adopt },
      },
    })
    const adopted = await f.operator.reconcile(f.context)
    expect(adopted.host.status?.conversationStore?.requestResult).toMatchObject({
      requestId: MIGRATION,
      state: 'completed',
    })
    expect(vi.mocked(f.port.execute).mock.calls.map(call => call[2])).toEqual([
      'preparation',
      'migrate',
      'adopt',
      'current',
    ])
  })

  it('retains a completed mutation across a pending final verification Job', async () => {
    const f = fixture(request('prepare', PREPARE), 'quiescing')
    f.outputs.set('current', { state: 'pending' })
    await f.operator.reconcile(f.context)
    expect(f.host.status?.conversationStore?.operationOutcome?.storeId).toBe(STORE)
    expect(f.host.status?.conversationStore?.requestResult?.state).toBe('accepted')
    f.outputs.set('current', {
      state: 'succeeded',
      outcome: { outcome: 'ok', reason: 'NoCollision' },
      proof: proof(),
    })
    await f.operator.reconcile(f.context)
    expect(vi.mocked(f.port.execute).mock.calls.filter(call => call[2] === 'migrate')).toHaveLength(
      1
    )
  })

  it('fails fresh binding checks if an awaited physical verification observes a different request', async () => {
    const f = fixture(request('prepare', PREPARE), 'quiescing')
    vi.mocked(f.port.execute).mockImplementationOnce(async () => {
      f.setHost({
        ...f.host,
        status: {
          ...f.host.status,
          conversationStore: {
            ...f.host.status?.conversationStore,
            request: request('prepare', { ...PREPARE, requestId: EXPORT }),
          },
        },
      })
      return {
        state: 'succeeded',
        outcome: { outcome: 'ok', reason: 'NoCollision' },
        proof: proof(),
      }
    })
    await expect(f.operator.reconcile(f.context)).rejects.toThrow('OperatorBindingChanged')
    expect(f.port.stopLegacyDeployment).not.toHaveBeenCalled()
  })

  it.each([{ currentCatalogHash: SNAPSHOT }, { storeId: MIGRATION }, { maintenanceId: EXPORT }])(
    'keeps completed maintenance closed on stale release proof %j',
    async mismatch => {
      const f = fixture(
        request('release', { expectedStoreId: STORE, expectedCurrentCatalogHash: CATALOG }),
        'completed'
      )
      f.outputs.set('current', {
        state: 'succeeded',
        outcome: { outcome: 'ok', reason: 'NoCollision' },
        proof: proof(mismatch),
      })
      expect((await f.operator.reconcile(f.context)).held).toBe(true)
      expect(f.host.status?.conversationStore?.maintenance?.phase).toBe('completed')
      expect(f.host.status?.conversationStore?.requestResult?.reason).toBe('ReleaseBindingMismatch')
    }
  )

  it('releases only a freshly verified exact current store and catalog, including Created with no candidate', async () => {
    const f = fixture(
      request('release', { expectedStoreId: STORE, expectedCurrentCatalogHash: CATALOG }),
      'completed'
    )
    f.outputs.set('current', {
      state: 'succeeded',
      outcome: { outcome: 'ok', reason: 'NoCollision' },
      proof: proof({ candidateHash: undefined }),
    })
    expect((await f.operator.reconcile(f.context)).held).toBe(false)
    expect(f.host.status?.conversationStore?.maintenance?.phase).toBe('released')
    expect(f.host.status?.conversationStore?.requestResult?.state).toBe('completed')
  })
})

describe('compatible legacy floor remains distinct from canonical activation', () => {
  function floorFixture(operation: ConversationStoreRequest['operation'] = 'prepare') {
    const req = request(operation, {
      ...PREPARE,
      storageContract: 'legacy-floor',
      ...(operation === 'release'
        ? { expectedMigrationId: MIGRATION, expectedCurrentCatalogHash: CATALOG }
        : {}),
    })
    const f = fixture(req, operation === 'release' ? 'completed' : 'quiescing')
    f.context.canonicalRequested = false
    const current = proof({
      storageContract: 'legacy-floor',
      storeId: undefined,
      layoutVersion: 1,
      databasePath: 'state/state.db',
      writerFenceRoot: 'state',
      catalogHash: CATALOG,
    })
    f.outputs.set('preparation', {
      state: 'succeeded',
      outcome: { outcome: 'ok', reason: 'InventoryVerified' },
      proof: current,
    })
    f.outputs.set('layout-precheck', {
      state: 'succeeded',
      outcome: {
        outcome: 'ok',
        reason: 'SingleCandidate',
        storageContract: 'legacy-floor',
        layoutVersion: 1,
        migrationId: MIGRATION,
        catalogHash: CATALOG,
        databasePath: 'state/state.db',
        writerFenceRoot: 'state',
      },
    })
    f.outputs.set('current', {
      state: 'succeeded',
      outcome: { outcome: 'ok', reason: 'InventoryVerified' },
      proof: current,
    })
    vi.mocked(f.port.verifyStoppedWriter).mockResolvedValue({
      verified: true,
      proof: { ...writer(), storageContract: 'legacy-floor' },
    })
    return f
  }
  it('prepares and proves the floor without opt-in or canonical identity', async () => {
    const f = floorFixture()
    const result = await f.operator.reconcile(f.context)
    expect(result.host.status?.conversationStore).toMatchObject({
      maintenance: { phase: 'completed', storageContract: 'legacy-floor' },
      operationOutcome: { layoutVersion: 1 },
      compatibility: {
        storageContract: 'legacy-floor',
        migrationId: MIGRATION,
        databasePath: 'state/state.db',
        writerFenceRoot: 'state',
        catalogHash: CATALOG,
      },
      ready: { ready: true, reason: 'LayoutReady' },
    })
    expect(result.host.status?.conversationStore?.layout).toBeUndefined()
    expect(result.host.status?.conversationStore?.operationOutcome?.storeId).toBeUndefined()
    expect(vi.mocked(f.port.execute).mock.calls.map(call => call[2])).toEqual([
      'preparation',
      'layout-precheck',
      'current',
    ])
  })
  it('rejects a canonical success returned to the floor mutator', async () => {
    const f = floorFixture()
    f.outputs.set('layout-precheck', {
      state: 'succeeded',
      outcome: {
        outcome: 'ok',
        storageContract: 'canonical',
        reason: 'SingleCandidate',
        layoutVersion: 1,
        storeId: STORE,
      },
    })
    const result = await f.operator.reconcile(f.context)
    expect(result.host.status?.conversationStore?.requestResult?.reason).toBe(
      'OperatorOutcomeMismatch'
    )
    expect(result.host.status?.conversationStore?.layout).toBeUndefined()
    expect(vi.mocked(f.port.execute).mock.calls.map(call => call[2])).toEqual([
      'preparation',
      'layout-precheck',
    ])
  })
  it('releases a current floor catalog after legitimate writes using fresh migration/hash pins', async () => {
    const f = floorFixture('release')
    f.host.status!.conversationStore!.compatibility = {
      schemaVersion: 1,
      storageContract: 'legacy-floor',
      hostUid: HOST,
      pvcUid: PVC,
      contractVersion: 1,
      layoutVersion: 1,
      migrationId: MIGRATION,
      databasePath: 'state/state.db',
      writerFenceRoot: 'state',
      catalogHash: HASH,
      establishedAt: NOW,
    }
    const result = await f.operator.reconcile(f.context)
    expect(result.held).toBe(false)
    expect(result.host.status?.conversationStore?.maintenance?.phase).toBe('released')
    expect(result.host.status?.conversationStore?.ready?.reason).toBe('LayoutReady')
  })
  it.each([{ migrationId: EXPORT }, { currentCatalogHash: HASH }, { storeId: STORE }])(
    'keeps floor maintenance closed on wrong current identity %j',
    async mismatch => {
      const f = floorFixture('release')
      const physical = f.outputs.get('current')!
      if (physical.state !== 'succeeded') throw new Error('Missing test witness')
      f.outputs.set('current', { ...physical, proof: { ...physical.proof!, ...mismatch } })
      expect((await f.operator.reconcile(f.context)).held).toBe(true)
      expect(f.host.status?.conversationStore?.requestResult?.reason).toBe('ReleaseBindingMismatch')
    }
  )
  it('cannot use floor compatibility as permission to prepare canonical without opt-in', async () => {
    const f = fixture(request('prepare', PREPARE), 'quiescing')
    f.context.storageContract = 'legacy-floor'
    f.context.canonicalRequested = false
    const result = await f.operator.reconcile(f.context)
    expect(result.host.status?.conversationStore?.requestResult?.reason).toBe(
      'StorageContractChanged'
    )
    expect(f.port.execute).not.toHaveBeenCalled()
    expect(f.port.stopLegacyDeployment).not.toHaveBeenCalled()
  })
})
