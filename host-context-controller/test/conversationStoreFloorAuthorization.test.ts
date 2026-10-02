import { describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import {
  ConversationStoreOperator,
  type ConversationStoreOperatorContext,
  type ConversationStoreOperatorPort,
} from '../src/conversationStoreOperator'
import { ConversationStoreKubernetesOperatorPort } from '../src/conversationStoreOperatorKubernetes'
import type { ConversationStoreRequest, HostCRD } from '../src/types'

const HOST = '11111111-1111-4111-8111-111111111111'
const PVC = '22222222-2222-4222-8222-222222222222'
const MAINTENANCE = '33333333-3333-4333-8333-333333333333'
const REQUEST = '44444444-4444-4444-8444-444444444444'
const EXPORT = '55555555-5555-4555-8555-555555555555'
const MIGRATION = '66666666-6666-4666-8666-666666666666'
const HASH = 'a'.repeat(64)
const CATALOG = 'b'.repeat(64)
const IMAGE = `ghcr.io/evenfire/mcp-host@sha256:${'c'.repeat(64)}`
const NOW = '2026-10-01T10:00:00.000Z'

type RuntimeAuthorizationInput = {
  requestId: string
  operation: 'prepare'
  action: 'verify-current'
}
type RuntimeAuthorizationResult = {
  authorization: {
    kind: 'legacy-floor-finalization-verification'
    expectedMigrationId: string
    expectedCurrentCatalogHash: string
  }
}
type CanonicalOperatorRuntimeHost = {
  metadata: Pick<HostCRD, 'name' | 'namespace' | 'uid' | 'resourceVersion'>
  spec: HostCRD['spec']
  status: HostCRD['status']
}
type CanonicalOperatorRuntimeModule = {
  resolveCanonicalOperatorRequestForTesting: (
    input: RuntimeAuthorizationInput,
    boundary: Awaited<ReturnType<typeof producedStatus>>['boundary']
  ) => Promise<RuntimeAuthorizationResult>
}

// Load the real resolver at runtime so HCC's typecheck does not compile the
// independent MCP Host package. Positive and negative assertions check the
// actual wire contract; the resolver is never mocked.
async function resolveRuntimeAuthorization(
  input: RuntimeAuthorizationInput,
  boundary: Awaited<ReturnType<typeof producedStatus>>['boundary']
) {
  const runtime = await vi.importActual<CanonicalOperatorRuntimeModule>(
    '../../mcp-host/src/runtime/canonicalOperatorAuthorization'
  )
  return runtime.resolveCanonicalOperatorRequestForTesting(input, boundary)
}

async function producedStatus() {
  const request: ConversationStoreRequest = {
    schemaVersion: 1,
    storageContract: 'legacy-floor',
    requestId: REQUEST,
    operation: 'prepare',
    hostUid: HOST,
    pvcUid: PVC,
    maintenanceId: MAINTENANCE,
    principal: { kind: 'control-admin', subject: 'operator-current' },
    targetImage: IMAGE,
    templateRevision: HASH,
    sourceClass: 'sqlite-external-exported',
    exportId: EXPORT,
    manifestHash: HASH,
  }
  let host: HostCRD = {
    name: 'alpha',
    namespace: 'mcp-host',
    uid: HOST,
    resourceVersion: '1',
    spec: { host: 'alpha', contextRef: 'context', secretRef: 'models' },
    status: {
      conversationStore: {
        request,
        maintenance: {
          storageContract: 'legacy-floor',
          hostUid: HOST,
          pvcUid: PVC,
          maintenanceId: MAINTENANCE,
          phase: 'quiescing',
          startedAt: NOW,
          updatedAt: NOW,
        },
      },
    },
  }
  const context: ConversationStoreOperatorContext = {
    host,
    pvcUid: PVC,
    pvcName: 'alpha-workspace',
    image: IMAGE,
    templateRevision: HASH,
    storageContract: 'legacy-floor',
    canonicalRequested: false,
  }
  // Kernel/export facts are the unit boundary. Status serialization and the
  // native Job graph come from actual production HCC producers, not fixtures.
  const jobs = new Map<string, k8s.V1Job>()
  const jobBuilder = new ConversationStoreKubernetesOperatorPort({
    imagePullSecrets: undefined,
  } as any)
  const port: ConversationStoreOperatorPort = {
    now: () => new Date(NOW),
    readFreshHost: async () => host,
    readPvcUid: async () => PVC,
    writeStatus: async (current, _request, fields) => {
      host = {
        ...host,
        resourceVersion: String(Number(host.resourceVersion) + 1),
        status: {
          ...host.status,
          conversationStore: { ...host.status?.conversationStore, ...fields },
        },
      }
      current.host = host
      return host
    },
    verifyStoppedWriter: async () => ({
      verified: true,
      proof: {
        storageContract: 'legacy-floor',
        hostUid: HOST,
        pvcUid: PVC,
        maintenanceId: MAINTENANCE,
        sourcePodUid: 'source-pod',
        sourceImageId: IMAGE,
        sourceRestartCount: 0,
        nodeName: 'owned-node',
        exportId: EXPORT,
        manifestHash: HASH,
        sourceSnapshotHash: HASH,
        verifiedAt: NOW,
      },
    }),
    stopLegacyDeployment: async () => {},
    execute: async (current, active, phase) => {
      const job = (jobBuilder as any).job(current, active, phase) as k8s.V1Job
      job.metadata = { ...job.metadata, uid: `native-${phase}`, resourceVersion: '1' }
      job.status =
        phase === 'current'
          ? { active: 1 }
          : { succeeded: 1, active: 0, conditions: [{ type: 'Complete', status: 'True' }] }
      jobs.set(job.metadata!.name!, job)
      await port.writeStatus(current, active, {
        execution: {
          storageContract: 'legacy-floor',
          requestHash: job.metadata!.annotations!['clerum.io/conversation-store-request-hash'],
          requestId: REQUEST,
          hostUid: HOST,
          pvcUid: PVC,
          maintenanceId: MAINTENANCE,
          jobName: job.metadata!.name!,
          jobUid: job.metadata!.uid!,
          image: IMAGE,
          templateRevision: HASH,
          phase,
          operation: 'prepare',
          createdAt: NOW,
        },
      })
      if (phase === 'current') return { state: 'pending' }
      if (phase === 'preparation')
        return {
          state: 'succeeded',
          outcome: { outcome: 'ok', reason: 'InventoryVerified' },
          proof: {
            proofVersion: 1,
            storageContract: 'legacy-floor',
            hostUid: HOST,
            pvcUid: PVC,
            maintenanceId: MAINTENANCE,
            sourceClass: 'sqlite-external-exported',
            exportId: EXPORT,
            manifestHash: HASH,
            sourceSnapshotHash: HASH,
          },
        }
      return {
        state: 'succeeded',
        outcome: {
          outcome: 'ok',
          reason: 'AlreadyLegacy',
          storageContract: 'legacy-floor',
          layoutVersion: 1,
          migrationId: MIGRATION,
          databasePath: 'state/state.db',
          writerFenceRoot: 'state',
          catalogHash: CATALOG,
        },
      }
    },
  }
  await new ConversationStoreOperator(port).reconcile(context)
  const execution = host.status!.conversationStore!.execution!
  const job = jobs.get(execution.jobName)!
  const pod: k8s.V1Pod = {
    metadata: {
      name: 'current-pod',
      namespace: host.namespace,
      uid: 'current-pod-uid',
      resourceVersion: '1',
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
    spec: structuredClone(job.spec!.template.spec),
    status: { phase: 'Running' },
  }
  const runtimeHost = (): CanonicalOperatorRuntimeHost => ({
    metadata: {
      name: host.name,
      namespace: host.namespace,
      uid: host.uid,
      resourceVersion: host.resourceVersion,
    },
    spec: host.spec,
    status: host.status,
  })
  const boundary = {
    context: { hostName: host.name, namespace: host.namespace, podUid: pod.metadata!.uid! },
    readers: {
      readHost: async () => structuredClone(runtimeHost()),
      readPod: async () => structuredClone(pod),
      readJob: async (name: string) => structuredClone(jobs.get(name)!),
      readPvc: async () => ({
        metadata: {
          name: 'alpha-workspace',
          namespace: host.namespace,
          uid: PVC,
          resourceVersion: '1',
        },
        status: { phase: 'Bound' },
      }),
      selfSubjectReview: async () => ({
        status: {
          userInfo: {
            uid: 'current-service-account-uid',
            username: `system:serviceaccount:mcp-host:${pod.spec!.serviceAccountName}`,
            extra: {
              'authentication.kubernetes.io/pod-name': [pod.metadata!.name!],
              'authentication.kubernetes.io/pod-uid': [pod.metadata!.uid!],
            },
          },
        },
      }),
    },
  }
  return { host, boundary }
}

describe('actual HCC floor outcome crosses runtime finalization authority', () => {
  it('authorizes an archived floor retry from production-produced status and exact native Job graph', async () => {
    const f = await producedStatus()
    expect(f.host.status!.conversationStore!.operationOutcome).toMatchObject({
      layoutVersion: 1,
      storageContract: 'legacy-floor',
      reason: 'AlreadyLegacy',
      migrationId: MIGRATION,
      catalogHash: CATALOG,
    })
    const result = await resolveRuntimeAuthorization(
      {
        requestId: REQUEST,
        operation: 'prepare',
        action: 'verify-current',
      },
      f.boundary
    )
    expect(result.authorization).toMatchObject({
      kind: 'legacy-floor-finalization-verification',
      expectedMigrationId: MIGRATION,
      expectedCurrentCatalogHash: CATALOG,
    })
  })
  it('fails if the HCC producer loses its layoutVersion wire field', async () => {
    const f = await producedStatus()
    delete (f.host.status!.conversationStore!.operationOutcome as Partial<{ layoutVersion: 1 }>)
      .layoutVersion
    await expect(
      resolveRuntimeAuthorization(
        {
          requestId: REQUEST,
          operation: 'prepare',
          action: 'verify-current',
        },
        f.boundary
      )
    ).rejects.toMatchObject({ reason: 'AdoptUnauthorized' })
  })
})
