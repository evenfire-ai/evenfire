import { describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { isDeepStrictEqual } from 'node:util'
import { conversationStoreDispatchKey } from '../src/conversationStoreObservation'
import { HostReconciler } from '../src/hostReconciler'
import type {
  ConversationStoreProvisioningIntent,
  HostCRD,
  HostConversationStoreStatus,
} from '../src/types'

const UID = '11111111-1111-4111-8111-111111111111'
const PVC = '22222222-2222-4222-8222-222222222222'
const BORN = '2026-09-30T12:00:00.000Z'
const intent: Omit<ConversationStoreProvisioningIntent, 'recordedAt'> = {
  schemaVersion: 1,
  hostUid: UID,
  hostCreatedAt: BORN,
  source: 'watch-added',
  observedResourceVersion: '101',
  watchResourceVersion: '100',
}
const host: HostCRD = {
  name: 'alpha',
  namespace: 'mcp-host',
  uid: UID,
  resourceVersion: '101',
  generation: 1,
  spec: { host: 'alpha', contextRef: 'context', secretRef: 'models' },
}
const absent = () => Promise.reject({ code: 404 })

function fixture() {
  const raw = {
    metadata: {
      name: host.name,
      namespace: host.namespace,
      uid: UID,
      resourceVersion: '101',
      creationTimestamp: BORN,
    },
    spec: host.spec,
    status: undefined as HostCRD['status'],
  }
  const writes: Array<Array<{ op: string; path: string; value: unknown }>> = []
  const custom = {
    getNamespacedCustomObject: vi.fn(async () => structuredClone(raw)),
    patchNamespacedCustomObjectStatus: vi.fn(async ({ body }) => {
      for (const operation of body) {
        const parts = operation.path.slice(1).split('/')
        let owner: Record<string, unknown> = raw as unknown as Record<string, unknown>
        for (const key of parts.slice(0, -1)) owner = owner[key] as Record<string, unknown>
        const key = parts.at(-1)!
        if (operation.op === 'test') {
          if (!isDeepStrictEqual(owner[key], operation.value)) throw { code: 409 }
        } else owner[key] = structuredClone(operation.value)
      }
      writes.push(structuredClone(body))
      raw.metadata.resourceVersion = String(Number(raw.metadata.resourceVersion) + 1)
      return structuredClone(raw)
    }),
  } as unknown as k8s.CustomObjectsApi
  const core = {
    readNamespacedPersistentVolumeClaim: vi.fn(absent),
    listNamespacedPod: vi.fn(async () => ({ items: [] })),
    createNamespacedPersistentVolumeClaim: vi.fn(async ({ body }) => ({
      ...body,
      metadata: {
        ...body.metadata,
        uid: PVC,
        resourceVersion: '110',
        creationTimestamp: new Date(BORN),
      },
    })),
  } as unknown as k8s.CoreV1Api
  const apps = { readNamespacedDeployment: vi.fn(absent) } as unknown as k8s.AppsV1Api
  const reconciler = new HostReconciler({} as k8s.KubeConfig, {
    appsApi: apps,
    coreApi: core,
    customApi: custom,
    rbacApi: {} as k8s.RbacAuthorizationV1Api,
    networkingApi: {} as k8s.NetworkingV1Api,
    now: () => new Date(BORN),
  })
  return { raw, writes, custom, core, apps, reconciler }
}

describe('positive native Host birth provenance', () => {
  it('records exact native birth and tests UID/resourceVersion before any PVC creation', async () => {
    const f = fixture()
    const result = await f.reconciler.recordConversationStoreProvisioningIntent(
      host,
      intent,
      () => {}
    )
    expect(result.status?.conversationStore?.provisioningIntent).toEqual({
      ...intent,
      recordedAt: BORN,
    })
    expect(f.writes[0].slice(0, 2)).toEqual([
      { op: 'test', path: '/metadata/uid', value: UID },
      { op: 'test', path: '/metadata/resourceVersion', value: '101' },
    ])
    expect(f.core.createNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
  })

  it.each(['deployment', 'retained-pvc', 'pod', 'layout'])(
    'never infers new Host from an existing %s',
    async obstacle => {
      const f = fixture()
      if (obstacle === 'deployment')
        vi.mocked(f.apps.readNamespacedDeployment).mockResolvedValue({
          metadata: { uid: 'legacy' },
        } as k8s.V1Deployment)
      if (obstacle === 'retained-pvc')
        vi.mocked(f.core.readNamespacedPersistentVolumeClaim).mockResolvedValue({
          metadata: { uid: PVC },
        } as k8s.V1PersistentVolumeClaim)
      if (obstacle === 'pod')
        vi.mocked(f.core.listNamespacedPod).mockResolvedValue({
          items: [{ metadata: { uid: 'legacy-pod' } }],
        } as k8s.V1PodList)
      if (obstacle === 'layout')
        f.raw.status = {
          conversationStore: {
            layout: {
              version: 1,
              hostUid: UID,
              pvcUid: PVC,
              state: 'ready',
              storeId: UID,
              committedAt: BORN,
            },
          },
        }
      await expect(
        f.reconciler.recordConversationStoreProvisioningIntent(host, intent, () => {})
      ).rejects.toThrow('HostSourceHistoryUnknown')
      expect(f.writes).toHaveLength(0)
    }
  )

  it('rejects a recreated Host or retired watch during the awaited absence observations', async () => {
    const f = fixture()
    vi.mocked(f.core.readNamespacedPersistentVolumeClaim).mockImplementationOnce(async () => {
      f.raw.metadata.uid = PVC
      throw { code: 404 }
    })
    await expect(
      f.reconciler.recordConversationStoreProvisioningIntent(host, intent, () => {})
    ).rejects.toThrow('HostBirthIdentityChanged')
    expect(f.writes).toHaveLength(0)
    const retired = fixture()
    let admission = 0
    await expect(
      retired.reconciler.recordConversationStoreProvisioningIntent(host, intent, () => {
        if (++admission === 2) throw new Error('HostBirthWatchAuthorityUnavailable')
      })
    ).rejects.toThrow('HostBirthWatchAuthorityUnavailable')
    expect(retired.writes).toHaveLength(0)
  })

  it('completes provenance only for an actual native PVC create after durable birth intent', async () => {
    const f = fixture()
    await f.reconciler.recordConversationStoreProvisioningIntent(host, intent, () => {})
    const created = {
      metadata: {
        name: 'alpha-workspace',
        namespace: 'mcp-host',
        uid: PVC,
        resourceVersion: '110',
        creationTimestamp: new Date(BORN),
      },
    } as k8s.V1PersistentVolumeClaim
    vi.mocked(f.core.readNamespacedPersistentVolumeClaim).mockResolvedValue(created)
    await (f.reconciler as any).persistConversationStoreProvisioning(host, created)
    expect(f.raw.status?.conversationStore?.provisioning).toEqual({
      hostUid: UID,
      pvcUid: PVC,
      createdAt: BORN,
    })
    expect(f.writes[1]).toContainEqual({
      op: 'test',
      path: '/status/conversationStore/provisioningIntent',
      value: { ...intent, recordedAt: BORN },
    })
    const unknown = fixture()
    vi.mocked(unknown.core.readNamespacedPersistentVolumeClaim).mockResolvedValue(created)
    await (unknown.reconciler as any).persistConversationStoreProvisioning(host, created)
    expect(unknown.raw.status?.conversationStore?.provisioning).toBeUndefined()
    expect(unknown.writes).toHaveLength(0)
  })
})

describe('operator status dispatch identity', () => {
  const state: HostConversationStoreStatus = {
    request: {
      schemaVersion: 1,
      storageContract: 'canonical',
      requestId: UID,
      operation: 'maintenance',
      hostUid: UID,
      pvcUid: PVC,
      maintenanceId: UID,
      principal: { kind: 'control-admin', subject: 'operator' },
    },
    maintenance: {
      storageContract: 'canonical',
      hostUid: UID,
      pvcUid: PVC,
      maintenanceId: UID,
      phase: 'quiescing',
      startedAt: BORN,
      updatedAt: BORN,
    },
    provisioningIntent: { ...intent, recordedAt: BORN },
  }
  it('dispatches same-generation operation, native execution and durable provenance changes', () => {
    for (const changed of [
      {
        ...state,
        request: {
          ...state.request!,
          principal: { kind: 'control-admin' as const, subject: 'another' },
        },
      },
      { ...state, maintenance: { ...state.maintenance!, phase: 'fenced' as const } },
      { ...state, provisioning: { hostUid: UID, pvcUid: PVC, createdAt: BORN } },
      {
        ...state,
        execution: {
          storageContract: 'canonical' as const,
          requestHash: 'a'.repeat(64),
          requestId: UID,
          hostUid: UID,
          pvcUid: PVC,
          maintenanceId: UID,
          operation: 'prepare' as const,
          phase: 'preparation' as const,
          jobName: 'native-job',
          jobUid: PVC,
          image: 'image',
          templateRevision: 'a'.repeat(64),
          createdAt: BORN,
        },
      },
    ])
      expect(conversationStoreDispatchKey(changed)).not.toBe(conversationStoreDispatchKey(state))
  })
  it('ignores observer clocks and display readiness but preserves native creation time', () => {
    expect(
      conversationStoreDispatchKey({
        ...state,
        ready: { ready: true, reason: 'Canonical' },
        maintenance: { ...state.maintenance!, updatedAt: 'later', startedAt: 'later' },
        provisioningIntent: { ...state.provisioningIntent!, recordedAt: 'later' },
      })
    ).toBe(conversationStoreDispatchKey(state))
    expect(conversationStoreDispatchKey({ ready: { ready: false, reason: 'Deferred' } })).toBe(
      conversationStoreDispatchKey(undefined)
    )
    const original = { ...state, provisioning: { hostUid: UID, pvcUid: PVC, createdAt: BORN } }
    expect(
      conversationStoreDispatchKey({
        ...original,
        provisioning: { ...original.provisioning, createdAt: 'different-native-birth' },
      })
    ).not.toBe(conversationStoreDispatchKey(original))
  })
})
