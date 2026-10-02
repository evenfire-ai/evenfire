import { describe, expect, it, vi } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { config } from '../src/config'
import { HostReconciler } from '../src/hostReconciler'
import type { HostCRD } from '../src/types'

function fixture() {
  const reconciler = new HostReconciler({} as k8s.KubeConfig, {
    coreApi: {} as k8s.CoreV1Api,
    appsApi: {} as k8s.AppsV1Api,
    rbacApi: {} as k8s.RbacAuthorizationV1Api,
    networkingApi: {} as k8s.NetworkingV1Api,
  })
  const host = {
    name: 'legacy',
    namespace: 'mcp-host',
    uid: '11111111-1111-4111-8111-111111111111',
    generation: 1,
    spec: { host: 'legacy', contextRef: 'context', secretRef: 'models' },
  } as HostCRD
  const existing = reconciler.buildDeployment(host)
  existing.metadata = { ...existing.metadata, uid: 'deployment', resourceVersion: '101' }
  const gate = (desired: k8s.V1Deployment, applied: k8s.V1Deployment | undefined = existing) =>
    (reconciler as any).decideCanonicalRolloutGate({
      host,
      desired,
      existing: applied,
      observedPvcUid: 'pvc',
    })
  return { reconciler, host, existing, gate }
}

describe('legacy source rollout preservation', () => {
  it('fails closed when an unprepared legacy Host has lost its Deployment', () => {
    const f = fixture()
    const verdict = (f.reconciler as any).decideCanonicalRolloutGate({
      host: f.host,
      desired: f.reconciler.buildDeployment(f.host),
      existing: undefined,
      observedPvcUid: 'pvc',
    })
    expect(verdict.status).toBe('fail-closed')
  })
  it.each(['mode', 'path', 'init', 'image', 'credential-revision'])(
    'preserves the full applied template on unprepared %s changes',
    kind => {
      const f = fixture()
      const desired = structuredClone(f.existing)
      const container = desired.spec!.template.spec!.containers![0]
      if (kind === 'mode')
        container.env!.push({ name: 'CLERUM_STATELESS_LIFECYCLE', value: 'true' })
      if (kind === 'path') container.volumeMounts![0].mountPath = '/different-workspace'
      if (kind === 'init')
        desired.spec!.template.spec!.initContainers = [
          {
            name: 'workspace-layout',
            image: container.image,
            command: ['node'],
            args: ['precheck'],
          },
        ]
      if (kind === 'image') container.image = 'different-compatible-image'
      if (kind === 'credential-revision')
        desired.spec!.template.metadata = {
          ...desired.spec!.template.metadata,
          annotations: {
            ...desired.spec!.template.metadata?.annotations,
            'clerum.io/runtime-token-revision': 'renewed',
          },
        }
      expect(f.gate(desired).status).toBe('preserve-applied')
    }
  )
  it('allows unchanged templates and replica-only changes after normalization of Kubernetes defaults', () => {
    const f = fixture()
    f.existing.spec!.template.spec!.restartPolicy = 'Always'
    f.existing.spec!.template.spec!.dnsPolicy = 'ClusterFirst'
    const desired = f.reconciler.buildDeployment(f.host)
    desired.spec!.replicas = 0
    expect(f.gate(desired).status).toBe('proceed')
  })
})

it('floor compatibility admits only floor and requires a new verified preparation for canonical opt-in', () => {
  const f = fixture()
  f.host.status = {
    conversationStore: {
      compatibility: {
        schemaVersion: 1,
        storageContract: 'legacy-floor',
        hostUid: f.host.uid!,
        pvcUid: 'pvc',
        contractVersion: 1,
        layoutVersion: 1,
        migrationId: '33333333-3333-4333-8333-333333333333',
        databasePath: 'state/state.db',
        writerFenceRoot: 'state',
        catalogHash: 'a'.repeat(64),
        establishedAt: '2026-10-01T00:00:00Z',
      },
    },
  }
  const floor = f.reconciler.buildDeployment(f.host, [], '', undefined, undefined, {
    pvcUid: 'pvc',
    storageContract: 'legacy-floor',
    sourceEnvironment: [],
  })
  expect(f.gate(floor).status).toBe('proceed')
  f.host.annotations = { 'clerum.io/canonical-store': 'enabled' }
  const canonical = f.reconciler.buildDeployment(f.host, [], '', undefined, undefined, {
    pvcUid: 'pvc',
    storageContract: 'canonical',
    sourceEnvironment: [],
  })
  expect(f.gate(canonical, floor).status).toBe('preserve-applied')
  expect(f.host.status.conversationStore?.layout).toBeUndefined()
})

it('does not admit a stale preparation revoked while the target diagnostic is persisted', async () => {
  const oldImage = config.hostImage
  config.hostImage = `registry.example/new-source@sha256:${'a'.repeat(64)}`
  try {
    const host = {
      name: 'legacy',
      namespace: 'mcp-host',
      uid: '11111111-1111-4111-8111-111111111111',
      resourceVersion: '1',
      spec: { host: 'legacy', contextRef: 'context', secretRef: 'models' },
      status: {
        conversationStore: {
          provisioning: {
            hostUid: '11111111-1111-4111-8111-111111111111',
            pvcUid: 'pvc',
            createdAt: '2026-10-01T00:00:00Z',
          },
          maintenance: {
            storageContract: 'legacy-floor',
            hostUid: '11111111-1111-4111-8111-111111111111',
            pvcUid: 'pvc',
            maintenanceId: 'episode',
            phase: 'released',
            startedAt: '2026-10-01T00:00:00Z',
            updatedAt: '2026-10-01T00:00:00Z',
          },
        },
      },
    } as HostCRD
    const apps = {
      readNamespacedDeployment: vi.fn(),
      replaceNamespacedDeployment: vi.fn(async ({ body }) => body),
    } as unknown as k8s.AppsV1Api
    const reconciler = new HostReconciler({} as k8s.KubeConfig, {
      appsApi: apps,
      coreApi: {} as k8s.CoreV1Api,
      rbacApi: {} as k8s.RbacAuthorizationV1Api,
      networkingApi: {} as k8s.NetworkingV1Api,
    })
    const lifecycle = { stateless: false, state: 'active' as const }
    const revision = reconciler.conversationStoreTemplateRevision(
      host,
      'pvc',
      config.hostImage,
      lifecycle,
      [],
      []
    )
    host.status!.conversationStore!.preparation = {
      schemaVersion: 1,
      storageContract: 'legacy-floor',
      requestId: 'request',
      hostUid: host.uid!,
      pvcUid: 'pvc',
      image: config.hostImage,
      templateRevision: revision,
      sourceClass: 'new-host',
      maintenanceId: 'episode',
      preparedAt: '2026-10-01T00:00:00Z',
      provenance: 'new',
    }
    const existing = reconciler.buildDeployment(host)
    existing.metadata = { ...existing.metadata, uid: 'deployment', resourceVersion: '7' }
    existing.spec!.template.spec!.containers![0].image = `registry.example/old-source@sha256:${'b'.repeat(64)}`
    vi.mocked(apps.readNamespacedDeployment).mockResolvedValue(existing)
    const fresh = structuredClone(host)
    delete fresh.status!.conversationStore!.preparation
    // Only the diagnostic native-I/O boundary is replaced. The actual admission
    // calculation, preparation matcher and rollout gate all execute.
    vi.spyOn(reconciler as any, 'observeConversationStoreOperatorProposal').mockResolvedValue({
      host: fresh,
      sourceEnvironment: [],
      proposal: { state: 'ready', templateRevision: revision },
    })
    await (reconciler as any).ensureDeployment(host, [], '', lifecycle, undefined, () => {}, 'pvc')
    expect(apps.replaceNamespacedDeployment).not.toHaveBeenCalled()
    expect(reconciler.getConversationStoreReady(host.name)).toMatchObject({
      ready: false,
      reason: 'Deferred',
    })
  } finally {
    config.hostImage = oldImage
  }
})
