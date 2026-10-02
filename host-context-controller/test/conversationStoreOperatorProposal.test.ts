import { describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { isDeepStrictEqual } from 'node:util'
import { config } from '../src/config'
import { HostReconciler } from '../src/hostReconciler'
import type { HostCRD } from '../src/types'

const HOST = '11111111-1111-4111-8111-111111111111'
const IMAGE = `ghcr.io/evenfire/mcp-host@sha256:${'a'.repeat(64)}`
const PVC = '22222222-2222-4222-8222-222222222222'
const host: HostCRD = {
  name: 'alpha',
  namespace: 'mcp-host',
  uid: HOST,
  resourceVersion: '1',
  spec: { host: 'alpha', contextRef: 'context', secretRef: 'models' },
}
function fixture() {
  const raw = {
    metadata: { name: host.name, namespace: host.namespace, uid: HOST, resourceVersion: '1' },
    spec: host.spec,
    status: undefined as HostCRD['status'],
  }
  const source = {
    metadata: {
      name: config.hostConfigMapName,
      namespace: host.namespace,
      uid: 'config-uid',
      resourceVersion: '1',
    },
    data: { PRODUCT: 'one' } as Record<string, string>,
  }
  const core = {
    readNamespacedPersistentVolumeClaim: vi.fn(async () => ({
      metadata: { name: 'alpha-workspace', uid: PVC, resourceVersion: '1' },
    })),
    readNamespacedConfigMap: vi.fn(async () => source),
  } as unknown as k8s.CoreV1Api
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
      raw.metadata.resourceVersion = String(Number(raw.metadata.resourceVersion) + 1)
      return structuredClone(raw)
    }),
  } as unknown as k8s.CustomObjectsApi
  const reconciler = new HostReconciler({} as k8s.KubeConfig, {
    coreApi: core,
    customApi: custom,
    appsApi: {} as k8s.AppsV1Api,
    rbacApi: {} as k8s.RbacAuthorizationV1Api,
    networkingApi: {} as k8s.NetworkingV1Api,
  })
  const observe = (effective = { stateless: false, state: 'active' }) =>
    (reconciler as any).observeConversationStoreOperatorProposal(
      host,
      PVC,
      IMAGE,
      effective,
      [],
      () => {}
    )
  return { core, custom, raw, source, reconciler, observe }
}

describe('readonly controller operator target diagnostic', () => {
  it('publishes exact floor pins without minting preparation or canonical commitment', async () => {
    const f = fixture()
    const result = await f.observe()
    expect(result.proposal).toMatchObject({
      schemaVersion: 1,
      state: 'ready',
      hostUid: HOST,
      pvcUid: PVC,
      storageContract: 'legacy-floor',
      image: IMAGE,
      templateRevision: expect.stringMatching(/^[0-9a-f]{64}$/),
      effectiveLifecycle: 'stateful',
    })
    expect(f.raw.status?.conversationStore?.preparation).toBeUndefined()
    expect(f.raw.status?.conversationStore?.layout).toBeUndefined()
    expect(f.custom.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
    await f.observe()
    f.source.data.PRODUCT = 'changed'
    await f.observe()
    expect(f.custom.patchNamespacedCustomObjectStatus).toHaveBeenCalledTimes(1)
  })
  it('removes target pins when current source key names or authority are unproven', async () => {
    const f = fixture()
    await f.observe()
    f.source.data.NODE_OPTIONS = 'configured'
    const unsafe = await f.observe()
    expect(unsafe.proposal).toMatchObject({ state: 'blocked', reason: 'SourceEnvironmentUnsafe' })
    expect(unsafe.proposal.templateRevision).toBeUndefined()
    delete f.source.data.NODE_OPTIONS
    const held = await f.observe({
      stateless: false,
      state: 'active',
      suspensionBlocked: true,
    } as any)
    expect(held.proposal).toMatchObject({
      state: 'blocked',
      reason: 'TemplateAuthorityUnavailable',
    })
    expect(held.proposal.templateRevision).toBeUndefined()
  })
  it('cannot publish a target for a rebound PVC', async () => {
    const f = fixture()
    vi.mocked(f.core.readNamespacedPersistentVolumeClaim).mockResolvedValue({
      metadata: { uid: HOST, resourceVersion: '2' },
    } as k8s.V1PersistentVolumeClaim)
    await expect(f.observe()).rejects.toThrow('OperatorBindingChanged')
    expect(f.custom.patchNamespacedCustomObjectStatus).not.toHaveBeenCalled()
  })
})
