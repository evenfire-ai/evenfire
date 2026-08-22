import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type SharedFileSystemFactoryConfig,
  WFC_MOUNT_PATH,
  pvcName,
  wfcDeploymentName,
  wfcEgressPolicyName,
  wfcIngressPolicyName,
  wfcInitJobNamePrefix,
  wfcServiceName,
} from '../k8s/sharedFileSystemFactory'
import { SharedFileSystemReconciler } from '../sharedFileSystemReconciler'
import type { SharedFileSystemCRD } from '../types'

const factoryConfig: SharedFileSystemFactoryConfig = {
  hostNamespace: 'mcp-host',
  controlPlaneNamespace: 'control-plane',
  wfcImage: 'registry.example/clerum/workspace-files-controller:0.1.0',
  wfcImagePullPolicy: 'IfNotPresent',
  wfcImagePullSecretName: 'clerum',
  wfcPort: 8086,
  wfcInitImage: 'busybox:1.36',
  wfcResources: {
    requests: { memory: '64Mi', cpu: '50m' },
    limits: { memory: '128Mi', cpu: '200m' },
  },
  wfcJwtPublicKeyConfigMapName: 'mcp-host-config',
  wfcJwtPublicKeyConfigMapKey: 'CLERUM_AUTH_JWT_PUBLIC_KEY',
  wfcMaxUploadBytes: 100 * 1024 * 1024,
  wfcMaxListEntries: 5000,
  wfcMaxPathDepth: 32,
}

function makeSfs(overrides: Partial<SharedFileSystemCRD> = {}): SharedFileSystemCRD {
  return {
    name: 'team-mission',
    namespace: 'mcp-host',
    spec: {
      size: '5Gi',
      directories: ['docs', 'runbooks'],
      security: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
    },
    ...overrides,
  }
}

function err(code: number, msg = 'k8s error'): Error & { code: number } {
  return Object.assign(new Error(msg), { code })
}
const notFound = () => err(404, 'not found')
const alreadyExists = () => err(409, 'already exists')

function makeMocks() {
  const appsApi = {
    createNamespacedDeployment: vi.fn().mockResolvedValue({}),
    // Truthful status (#592) reads readyReplicas; conflict-retry reads metadata.
    readNamespacedDeployment: vi.fn().mockResolvedValue({
      metadata: { resourceVersion: '1' },
      status: { readyReplicas: 1, availableReplicas: 1 },
    }),
    replaceNamespacedDeployment: vi.fn().mockResolvedValue({}),
    deleteNamespacedDeployment: vi.fn().mockResolvedValue({}),
  }
  const coreApi = {
    createNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({}),
    deleteNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({}),
    createNamespacedService: vi.fn().mockResolvedValue({}),
    deleteNamespacedService: vi.fn().mockResolvedValue({}),
    // Truthful status (#592): assessReadiness reads the PVC bind state, and
    // detectWfcWedge lists the wfc Pod. Defaults = happy path (PVC Bound, no
    // wedged pod) so existing tests reach phase=Ready.
    readNamespacedPersistentVolumeClaim: vi
      .fn()
      .mockResolvedValue({ status: { phase: 'Bound', capacity: { storage: '5Gi' } } }),
    listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
  }
  const batchApi = {
    // Legacy init-Job cleanup surface (replaces createNamespacedJob).
    listNamespacedJob: vi.fn().mockResolvedValue({ items: [] }),
    deleteNamespacedJob: vi.fn().mockResolvedValue({}),
    createNamespacedJob: vi.fn().mockResolvedValue({}), // must NEVER be called now
  }
  const networkingApi = {
    createNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    readNamespacedNetworkPolicy: vi.fn().mockResolvedValue({ metadata: { resourceVersion: '1' } }),
    replaceNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
    deleteNamespacedNetworkPolicy: vi.fn().mockResolvedValue({}),
  }
  const customApi = {
    patchNamespacedCustomObjectStatus: vi.fn().mockResolvedValue({}),
  }
  return { appsApi, coreApi, batchApi, networkingApi, customApi }
}

function makeReconciler(mocks: ReturnType<typeof makeMocks>, now?: () => Date) {
  return new SharedFileSystemReconciler(null, {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    appsApi: mocks.appsApi as any,
    coreApi: mocks.coreApi as any,
    batchApi: mocks.batchApi as any,
    networkingApi: mocks.networkingApi as any,
    customApi: mocks.customApi as any,
    /* eslint-enable @typescript-eslint/no-explicit-any */
    now: now ?? (() => new Date('2026-04-30T12:00:00Z')),
    factoryConfig,
  })
}

/** A legacy init Job manifest, optionally with a mismatching name/label. */
function legacyJob(sfs: SharedFileSystemCRD, name?: string) {
  return {
    metadata: {
      name: name ?? `${wfcInitJobNamePrefix(sfs)}g0001`,
      labels: {
        'clerum.io/sharedfilesystem': sfs.name,
        'clerum.io/sharedfilesystem-namespace': sfs.namespace,
      },
    },
  }
}

describe('SharedFileSystemReconciler — monotonic status on re-reconcile (#592 race)', () => {
  it('does not transiently downgrade an already-Ready SFS below Ready while re-reconciling', async () => {
    const mocks = makeMocks()
    const reconciler = makeReconciler(mocks)
    const sfs = makeSfs()

    // First reconcile reaches Ready (happy-path mocks: PVC Bound, wfc ready).
    await reconciler.reconcile(sfs)
    expect(reconciler.getStatus(sfs).phase).toBe('Ready')

    // Capture the in-memory phase observed MID-reconcile — this is the exact
    // window resolveContextMounts() reads to gate the RO mount. The earlier bug
    // wrote phase=Provisioning (before ensurePvc) and phase=Initializing (before
    // ensureService) unconditionally, so a concurrent Host reconcile saw a
    // not-Ready SFS and deferred the mount forever. ensurePvc + ensureService run
    // before assessReadiness restores the truthful phase, so they are the probes.
    const phasesSeenMidReconcile: Array<string | undefined> = []
    mocks.coreApi.createNamespacedPersistentVolumeClaim.mockImplementation(async () => {
      phasesSeenMidReconcile.push(reconciler.getStatus(sfs).phase)
      return {}
    })
    mocks.coreApi.createNamespacedService.mockImplementation(async () => {
      phasesSeenMidReconcile.push(reconciler.getStatus(sfs).phase)
      return {}
    })

    // Re-reconcile the already-Ready SFS (mirrors a Context-change re-reconcile).
    await reconciler.reconcile(sfs)

    expect(reconciler.getStatus(sfs).phase).toBe('Ready')
    expect(phasesSeenMidReconcile.length).toBeGreaterThan(0)
    for (const phase of phasesSeenMidReconcile) {
      expect(phase).toBe('Ready')
    }
  })
})

describe('SharedFileSystemReconciler — happy path', () => {
  let mocks: ReturnType<typeof makeMocks>
  let reconciler: SharedFileSystemReconciler

  beforeEach(() => {
    mocks = makeMocks()
    reconciler = makeReconciler(mocks)
  })

  it('creates PVC, Service, Deployment, and both NetworkPolicies — and NEVER an init Job', async () => {
    const sfs = makeSfs()
    await reconciler.reconcile(sfs)

    expect(mocks.coreApi.createNamespacedPersistentVolumeClaim).toHaveBeenCalledTimes(1)
    expect(mocks.coreApi.createNamespacedService).toHaveBeenCalledTimes(1)
    expect(mocks.appsApi.createNamespacedDeployment).toHaveBeenCalledTimes(1)
    expect(mocks.appsApi.createNamespacedDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          metadata: expect.objectContaining({ name: wfcDeploymentName(sfs) }),
        }),
      })
    )
    expect(mocks.networkingApi.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(2)
    // The separate init Job is gone; seeding is the Deployment's initContainer.
    expect(mocks.batchApi.createNamespacedJob).not.toHaveBeenCalled()
  })

  it('builds the Deployment with a root initContainer that seeds the PVC in the same pod', async () => {
    const sfs = makeSfs()
    await reconciler.reconcile(sfs)
    const dep = mocks.appsApi.createNamespacedDeployment.mock.calls[0][0].body
    const podSpec = dep.spec.template.spec
    expect(podSpec.initContainers).toHaveLength(1)
    expect(podSpec.initContainers[0].name).toBe('init')
    expect(podSpec.initContainers[0].securityContext.runAsUser).toBe(0)
    expect(podSpec.initContainers[0].securityContext.runAsNonRoot).toBe(false)
    expect(podSpec.containers).toHaveLength(1)
  })

  it('writes status with phase=Ready and does NOT fabricate a lastInitJob', async () => {
    const sfs = makeSfs()
    await reconciler.reconcile(sfs)
    const call = mocks.customApi.patchNamespacedCustomObjectStatus.mock.calls.at(-1)![0]
    expect(call.body[0]).toMatchObject({ op: 'replace', path: '/status' })
    expect(call.body[0].value).toMatchObject({
      phase: 'Ready',
      pvcName: pvcName(sfs),
      serviceName: wfcServiceName(sfs),
    })
    expect(call.body[0].value.lastInitJob).toBeUndefined()
  })

  it('reaches phase=Ready after the wfc resources are applied', async () => {
    const sfs = makeSfs()
    await reconciler.reconcile(sfs)
    expect(reconciler.getStatus(sfs).phase).toBe('Ready')
  })
})

describe('SharedFileSystemReconciler — legacy init-Job cleanup', () => {
  it('lists Jobs by the SFS label and deletes only those matching the wfc-init-<hash>- prefix', async () => {
    const mocks = makeMocks()
    const sfs = makeSfs()
    mocks.batchApi.listNamespacedJob.mockResolvedValue({
      items: [
        legacyJob(sfs), // our init Job → delete
        legacyJob(sfs, 'some-other-job'), // shares label, wrong prefix → KEEP
      ],
    })
    const reconciler = makeReconciler(mocks)
    await reconciler.reconcile(sfs)

    expect(mocks.batchApi.listNamespacedJob).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'mcp-host',
        // Clear scoping by the SFS's own name + namespace labels.
        labelSelector: `clerum.io/sharedfilesystem=${sfs.name},clerum.io/sharedfilesystem-namespace=${sfs.namespace}`,
      })
    )
    expect(mocks.batchApi.deleteNamespacedJob).toHaveBeenCalledTimes(1)
    expect(mocks.batchApi.deleteNamespacedJob).toHaveBeenCalledWith(
      expect.objectContaining({ name: `${wfcInitJobNamePrefix(sfs)}g0001` })
    )
  })

  it('never deletes a foreign Job that merely shares the label (double guard)', async () => {
    const mocks = makeMocks()
    const sfs = makeSfs()
    mocks.batchApi.listNamespacedJob.mockResolvedValue({
      items: [legacyJob(sfs, wfcDeploymentName(sfs)), legacyJob(sfs, 'unrelated')],
    })
    const reconciler = makeReconciler(mocks)
    await reconciler.reconcile(sfs)
    expect(mocks.batchApi.deleteNamespacedJob).not.toHaveBeenCalled()
  })

  it('is non-fatal: a cleanup list failure does NOT block the Deployment rewrite', async () => {
    const mocks = makeMocks()
    mocks.batchApi.listNamespacedJob.mockRejectedValue(err(500, 'list boom'))
    const reconciler = makeReconciler(mocks)
    await expect(reconciler.reconcile(makeSfs())).resolves.toBeUndefined()
    expect(mocks.appsApi.createNamespacedDeployment).toHaveBeenCalledTimes(1)
    expect(reconciler.getStatus(makeSfs()).phase).toBe('Ready')
  })

  it('swallows 404/409 on individual Job deletes', async () => {
    const mocks = makeMocks()
    const sfs = makeSfs()
    mocks.batchApi.listNamespacedJob.mockResolvedValue({
      items: [
        legacyJob(sfs, `${wfcInitJobNamePrefix(sfs)}a`),
        legacyJob(sfs, `${wfcInitJobNamePrefix(sfs)}b`),
      ],
    })
    mocks.batchApi.deleteNamespacedJob
      .mockRejectedValueOnce(notFound())
      .mockRejectedValueOnce(alreadyExists())
    const reconciler = makeReconciler(mocks)
    await expect(reconciler.reconcile(sfs)).resolves.toBeUndefined()
    expect(reconciler.getStatus(sfs).phase).toBe('Ready')
  })

  it('requests Background propagation so the Job pod is reaped too', async () => {
    const mocks = makeMocks()
    const sfs = makeSfs()
    mocks.batchApi.listNamespacedJob.mockResolvedValue({ items: [legacyJob(sfs)] })
    const reconciler = makeReconciler(mocks)
    await reconciler.reconcile(sfs)
    expect(mocks.batchApi.deleteNamespacedJob).toHaveBeenCalledWith(
      expect.objectContaining({ propagationPolicy: 'Background' })
    )
  })
})

describe('SharedFileSystemReconciler — idempotence', () => {
  it('PVC 409 (already exists) is treated as success — no replace attempt', async () => {
    const mocks = makeMocks()
    mocks.coreApi.createNamespacedPersistentVolumeClaim.mockRejectedValueOnce(alreadyExists())
    const reconciler = makeReconciler(mocks)
    await expect(reconciler.reconcile(makeSfs())).resolves.toBeUndefined()
    expect(reconciler.getStatus(makeSfs()).phase).toBe('Ready')
  })

  it('Deployment 409 (already exists) triggers a replace via the conflict-retry helper', async () => {
    const mocks = makeMocks()
    mocks.appsApi.createNamespacedDeployment.mockRejectedValueOnce(alreadyExists())
    const reconciler = makeReconciler(mocks)
    await reconciler.reconcile(makeSfs())
    expect(mocks.appsApi.readNamespacedDeployment).toHaveBeenCalled()
    expect(mocks.appsApi.replaceNamespacedDeployment).toHaveBeenCalled()
  })

  it('preserves an external pod-template restart marker during HCC replacement', async () => {
    const mocks = makeMocks()
    mocks.appsApi.createNamespacedDeployment.mockRejectedValueOnce(alreadyExists())
    mocks.appsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: { resourceVersion: '7', annotations: { 'operator.example/keep': 'yes' } },
      spec: {
        template: {
          metadata: {
            annotations: {
              'kubectl.kubernetes.io/restartedAt': '2026-08-22T12:00:00Z',
              'operator.example/pod-marker': 'keep',
            },
          },
        },
      },
      status: { readyReplicas: 1, availableReplicas: 1 },
    })
    const reconciler = makeReconciler(mocks)

    await reconciler.reconcile(makeSfs())

    const replaceBody = mocks.appsApi.replaceNamespacedDeployment.mock.calls[0][0].body
    expect(replaceBody.metadata.annotations).toMatchObject({ 'operator.example/keep': 'yes' })
    expect(replaceBody.spec.template.metadata.annotations).toEqual({
      'kubectl.kubernetes.io/restartedAt': '2026-08-22T12:00:00Z',
      'operator.example/pod-marker': 'keep',
    })
  })

  it('never creates a Job across repeated reconciles', async () => {
    const mocks = makeMocks()
    const reconciler = makeReconciler(mocks)
    const sfs = makeSfs()
    await reconciler.reconcile(sfs)
    await reconciler.reconcile(sfs)
    expect(mocks.batchApi.createNamespacedJob).not.toHaveBeenCalled()
  })
})

describe('SharedFileSystemReconciler — failure handling', () => {
  it('writes phase=Failed with a Reconciled=False condition when PVC create errors (non-409)', async () => {
    const mocks = makeMocks()
    mocks.coreApi.createNamespacedPersistentVolumeClaim.mockRejectedValueOnce(
      err(500, 'cluster down')
    )
    const reconciler = makeReconciler(mocks)
    await expect(reconciler.reconcile(makeSfs())).rejects.toThrow('cluster down')
    const status = reconciler.getStatus(makeSfs())
    expect(status.phase).toBe('Failed')
    expect(status.conditions?.[0]).toMatchObject({
      type: 'Reconciled',
      status: 'False',
      reason: 'ReconcileError',
    })
    expect(mocks.customApi.patchNamespacedCustomObjectStatus).toHaveBeenCalled()
  })

  it('fails the reconcile on a hostile directory (validation in the wfc builder)', async () => {
    const mocks = makeMocks()
    const reconciler = makeReconciler(mocks)
    const sfs = makeSfs({ spec: { directories: ['../escape'] } })
    await expect(reconciler.reconcile(sfs)).rejects.toThrow(/SharedFileSystem director/i)
  })
})

describe('SharedFileSystemReconciler — reconcileDelete', () => {
  it('deletes Deployment, Service, and both NetworkPolicies but RETAINS PVC by default', async () => {
    const mocks = makeMocks()
    const reconciler = makeReconciler(mocks)
    await reconciler.reconcileDelete('team-mission', 'mcp-host', { retainOnDelete: true })
    expect(mocks.networkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: wfcIngressPolicyName({ name: 'team-mission', namespace: 'mcp-host' }),
      })
    )
    expect(mocks.networkingApi.deleteNamespacedNetworkPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: wfcEgressPolicyName({ name: 'team-mission', namespace: 'mcp-host' }),
      })
    )
    expect(mocks.coreApi.deleteNamespacedService).toHaveBeenCalled()
    expect(mocks.appsApi.deleteNamespacedDeployment).toHaveBeenCalled()
    expect(mocks.coreApi.deleteNamespacedPersistentVolumeClaim).not.toHaveBeenCalled()
    // Also reaps any leftover legacy init Jobs on delete.
    expect(mocks.batchApi.listNamespacedJob).toHaveBeenCalled()
  })

  it('deletes the PVC when retainOnDelete=false', async () => {
    const mocks = makeMocks()
    const reconciler = makeReconciler(mocks)
    await reconciler.reconcileDelete('team-mission', 'mcp-host', { retainOnDelete: false })
    expect(mocks.coreApi.deleteNamespacedPersistentVolumeClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        name: pvcName({ name: 'team-mission', namespace: 'mcp-host' }),
        namespace: 'mcp-host',
      })
    )
  })

  it('reaps legacy init Jobs BEFORE deleting the PVC (retainOnDelete=false)', async () => {
    // A still-running legacy init pod holding the RWO PVC would block reclaim
    // (pvc-protection finalizer) if the PVC were deleted first. Seed a matching
    // legacy Job so the actual delete is issued, and assert its order.
    const mocks = makeMocks()
    const sfs = makeSfs()
    mocks.batchApi.listNamespacedJob.mockResolvedValue({ items: [legacyJob(sfs)] })
    const reconciler = makeReconciler(mocks)
    await reconciler.reconcileDelete('team-mission', 'mcp-host', { retainOnDelete: false })
    expect(mocks.batchApi.deleteNamespacedJob).toHaveBeenCalled()
    expect(mocks.coreApi.deleteNamespacedPersistentVolumeClaim).toHaveBeenCalled()
    const reapOrder = mocks.batchApi.deleteNamespacedJob.mock.invocationCallOrder[0]
    const pvcDeleteOrder =
      mocks.coreApi.deleteNamespacedPersistentVolumeClaim.mock.invocationCallOrder[0]
    expect(reapOrder).toBeLessThan(pvcDeleteOrder)
  })

  it('treats any 404 during teardown as success (resource already gone)', async () => {
    const mocks = makeMocks()
    mocks.coreApi.deleteNamespacedService.mockRejectedValueOnce(notFound())
    mocks.appsApi.deleteNamespacedDeployment.mockRejectedValueOnce(notFound())
    mocks.networkingApi.deleteNamespacedNetworkPolicy.mockRejectedValue(notFound())
    const reconciler = makeReconciler(mocks)
    await expect(
      reconciler.reconcileDelete('team-mission', 'mcp-host', { retainOnDelete: true })
    ).resolves.toBeUndefined()
  })

  it('clears in-memory status so a subsequent re-create starts fresh', async () => {
    const mocks = makeMocks()
    const reconciler = makeReconciler(mocks)
    const sfs = makeSfs()
    await reconciler.reconcile(sfs)
    expect(reconciler.getStatus(sfs).phase).toBe('Ready')
    await reconciler.reconcileDelete(sfs.name, sfs.namespace, { retainOnDelete: true })
    expect(reconciler.getStatus(sfs).phase).toBe('Provisioning')
  })
})

describe('SharedFileSystemReconciler — fullReconcile', () => {
  it('reconciles every desired SFS and continues past errors on individual SFSes', async () => {
    const mocks = makeMocks()
    mocks.coreApi.createNamespacedPersistentVolumeClaim
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(err(500, 'cluster down'))
      .mockResolvedValueOnce({})
    const reconciler = makeReconciler(mocks)
    const desired = [
      makeSfs({ name: 'sfs-a' }),
      makeSfs({ name: 'sfs-b' }),
      makeSfs({ name: 'sfs-c' }),
    ]
    await expect(reconciler.fullReconcile(desired)).resolves.toBeUndefined()
    expect(mocks.coreApi.createNamespacedPersistentVolumeClaim).toHaveBeenCalledTimes(3)
    expect(reconciler.getStatus(desired[0]).phase).toBe('Ready')
    expect(reconciler.getStatus(desired[1]).phase).toBe('Failed')
    expect(reconciler.getStatus(desired[2]).phase).toBe('Ready')
  })
})

describe('SharedFileSystemReconciler — wfc env wiring (sanity)', () => {
  it('passes WSF_MOUNT_PATH=/workspace and SFS identity into the Deployment env', async () => {
    const mocks = makeMocks()
    const reconciler = makeReconciler(mocks)
    await reconciler.reconcile(makeSfs())
    const dep = mocks.appsApi.createNamespacedDeployment.mock.calls[0][0].body
    const env = dep.spec.template.spec.containers[0].env
    const byName = Object.fromEntries(env.map((e: { name: string; value?: string }) => [e.name, e]))
    expect(byName.WSF_MOUNT_PATH.value).toBe(WFC_MOUNT_PATH)
    expect(byName.WSF_SHARED_FILESYSTEM_NAME.value).toBe('team-mission')
    expect(byName.WSF_SHARED_FILESYSTEM_NAMESPACE.value).toBe('mcp-host')
  })
})

describe('SharedFileSystemReconciler — truthful status (#592)', () => {
  let mocks: ReturnType<typeof makeMocks>
  let reconciler: SharedFileSystemReconciler

  beforeEach(() => {
    mocks = makeMocks()
    reconciler = makeReconciler(mocks)
  })

  // PVC Pending under WaitForFirstConsumer while the wfc pod is still scheduling
  // is the NORMAL warm-up path — must report Initializing, never a false Degraded.
  it('reports Initializing (not Degraded) while the PVC is Pending and no pod is wedged', async () => {
    mocks.coreApi.readNamespacedPersistentVolumeClaim.mockResolvedValue({
      status: { phase: 'Pending' },
    })
    mocks.appsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: { resourceVersion: '1' },
      status: { readyReplicas: 0 },
    })
    mocks.coreApi.listNamespacedPod.mockResolvedValue({ items: [] }) // pod not created yet
    const sfs = makeSfs()
    await reconciler.reconcile(sfs)
    expect(reconciler.getStatus(sfs).phase).toBe('Initializing')
  })

  it('reports Degraded (PVCUnbound) when the wfc Pod is Unschedulable', async () => {
    mocks.coreApi.readNamespacedPersistentVolumeClaim.mockResolvedValue({
      status: { phase: 'Pending' },
    })
    mocks.appsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: { resourceVersion: '1' },
      status: { readyReplicas: 0 },
    })
    mocks.coreApi.listNamespacedPod.mockResolvedValue({
      items: [
        {
          status: {
            conditions: [
              {
                type: 'PodScheduled',
                status: 'False',
                reason: 'Unschedulable',
                message: '0/2 nodes are available: 2 node(s) had volume node affinity conflict.',
              },
            ],
          },
        },
      ],
    })
    const sfs = makeSfs()
    await reconciler.reconcile(sfs)
    const status = reconciler.getStatus(sfs)
    expect(status.phase).toBe('Degraded')
    expect(status.conditions?.[0]).toMatchObject({
      type: 'Reconciled',
      status: 'False',
      reason: 'PVCUnbound',
    })
  })

  // An Unschedulable that is NOT a volume/PVC problem (taint, insufficient CPU)
  // must NOT be mislabeled PVCUnbound, and must NOT carry the "check the PVC
  // accessModes" hint that would misdirect the operator. (Review fix #592.)
  it('reports Degraded (Unschedulable, NOT PVCUnbound) for a non-volume scheduling failure', async () => {
    mocks.coreApi.readNamespacedPersistentVolumeClaim.mockResolvedValue({
      status: { phase: 'Pending' },
    })
    mocks.appsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: { resourceVersion: '1' },
      status: { readyReplicas: 0 },
    })
    mocks.coreApi.listNamespacedPod.mockResolvedValue({
      items: [
        {
          status: {
            conditions: [
              {
                type: 'PodScheduled',
                status: 'False',
                reason: 'Unschedulable',
                message:
                  '0/2 nodes are available: 2 Insufficient cpu, 2 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }.',
              },
            ],
          },
        },
      ],
    })
    const sfs = makeSfs()
    await reconciler.reconcile(sfs)
    const status = reconciler.getStatus(sfs)
    expect(status.phase).toBe('Degraded')
    expect(status.conditions?.[0]?.reason).toBe('Unschedulable')
    expect(status.conditions?.[0]?.message ?? '').not.toMatch(/accessModes/i)
  })

  it('reports Degraded (WfcNotReady) when the wfc container is CrashLoopBackOff', async () => {
    mocks.coreApi.readNamespacedPersistentVolumeClaim.mockResolvedValue({
      status: { phase: 'Bound' },
    })
    mocks.appsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: { resourceVersion: '1' },
      status: { readyReplicas: 0 },
    })
    mocks.coreApi.listNamespacedPod.mockResolvedValue({
      items: [
        {
          status: {
            containerStatuses: [
              {
                name: 'workspace-files-controller',
                state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 5m0s' } },
              },
            ],
          },
        },
      ],
    })
    const sfs = makeSfs()
    await reconciler.reconcile(sfs)
    const status = reconciler.getStatus(sfs)
    expect(status.phase).toBe('Degraded')
    expect(status.conditions?.[0]).toMatchObject({ reason: 'WfcNotReady' })
  })

  // The sfsResyncTimer re-runs reconcile; a transient Initializing must converge
  // to Ready once the PVC binds and the wfc pod serves — no manual intervention.
  it('auto-recovers to Ready on a later reconcile once the PVC binds and the wfc is ready', async () => {
    const sfs = makeSfs()
    mocks.coreApi.readNamespacedPersistentVolumeClaim.mockResolvedValueOnce({
      status: { phase: 'Pending' },
    })
    mocks.appsApi.readNamespacedDeployment.mockResolvedValueOnce({
      metadata: { resourceVersion: '1' },
      status: { readyReplicas: 0 },
    })
    await reconciler.reconcile(sfs)
    expect(reconciler.getStatus(sfs).phase).toBe('Initializing')
    // Second reconcile falls through to the default happy-path mocks.
    await reconciler.reconcile(sfs)
    expect(reconciler.getStatus(sfs).phase).toBe('Ready')
  })

  it('populates status.capacity from the bound PVC', async () => {
    const sfs = makeSfs()
    await reconciler.reconcile(sfs)
    expect(reconciler.getStatus(sfs).capacity).toBe('5Gi')
  })
})

describe('SharedFileSystemReconciler — status-write dirty check + lastTransitionTime (#592 oscillation)', () => {
  it('skips the no-op /status patch when re-reconciling a steady Ready SFS', async () => {
    const mocks = makeMocks()
    const reconciler = makeReconciler(mocks)
    const sfs = makeSfs()

    await reconciler.reconcile(sfs)
    expect(reconciler.getStatus(sfs).phase).toBe('Ready')
    const writesAfterFirst = mocks.customApi.patchNamespacedCustomObjectStatus.mock.calls.length
    expect(writesAfterFirst).toBe(1)

    // Re-reconciling an unchanged Ready SFS must NOT issue another /status patch
    // — a write would bump resourceVersion, fire a MODIFIED watch event, and
    // re-trigger reconcile, spinning a tight loop.
    await reconciler.reconcile(sfs)
    await reconciler.reconcile(sfs)
    expect(mocks.customApi.patchNamespacedCustomObjectStatus.mock.calls.length).toBe(
      writesAfterFirst
    )
  })

  it('preserves lastTransitionTime across re-reconciles of an unchanged condition (real clock)', async () => {
    const mocks = makeMocks()
    let nowIdx = 0
    const times = [new Date('2026-04-30T12:00:00Z'), new Date('2026-04-30T12:05:00Z')]
    const reconciler = makeReconciler(mocks, () => times[nowIdx])
    const sfs = makeSfs()

    await reconciler.reconcile(sfs)
    const writesAfterFirst = mocks.customApi.patchNamespacedCustomObjectStatus.mock.calls.length
    expect(reconciler.getStatus(sfs).conditions?.[0]?.lastTransitionTime).toBe(
      '2026-04-30T12:00:00.000Z'
    )

    // Clock advances 5 minutes; the condition is still Ready (unchanged), so its
    // lastTransitionTime must be PRESERVED (K8s convention) — which is exactly
    // what keeps the serialized status identical so the dirty check can skip.
    nowIdx = 1
    await reconciler.reconcile(sfs)
    expect(reconciler.getStatus(sfs).conditions?.[0]?.lastTransitionTime).toBe(
      '2026-04-30T12:00:00.000Z'
    )
    expect(mocks.customApi.patchNamespacedCustomObjectStatus.mock.calls.length).toBe(
      writesAfterFirst
    )
  })

  it('writes again (and bumps lastTransitionTime) when the phase actually transitions', async () => {
    const mocks = makeMocks()
    let nowIdx = 0
    const times = [new Date('2026-04-30T12:00:00Z'), new Date('2026-04-30T12:05:00Z')]
    const reconciler = makeReconciler(mocks, () => times[nowIdx])
    const sfs = makeSfs()

    // First reconcile: PVC still Pending, no wedged pod → Initializing.
    mocks.coreApi.readNamespacedPersistentVolumeClaim.mockResolvedValueOnce({
      status: { phase: 'Pending' },
    })
    mocks.appsApi.readNamespacedDeployment.mockResolvedValueOnce({
      metadata: { resourceVersion: '1' },
      status: { readyReplicas: 0 },
    })
    await reconciler.reconcile(sfs)
    expect(reconciler.getStatus(sfs).phase).toBe('Initializing')
    const writesAfterFirst = mocks.customApi.patchNamespacedCustomObjectStatus.mock.calls.length

    // Second reconcile (clock advanced): falls through to happy-path mocks → Ready.
    // The phase transitioned, so the status differs and MUST be written, with a
    // fresh lastTransitionTime reflecting the real transition.
    nowIdx = 1
    await reconciler.reconcile(sfs)
    expect(reconciler.getStatus(sfs).phase).toBe('Ready')
    expect(mocks.customApi.patchNamespacedCustomObjectStatus.mock.calls.length).toBeGreaterThan(
      writesAfterFirst
    )
    expect(reconciler.getStatus(sfs).conditions?.[0]?.lastTransitionTime).toBe(
      '2026-04-30T12:05:00.000Z'
    )
  })
})

describe('SharedFileSystemReconciler — mountability decoupled from wfc readiness (#592 mount resilience)', () => {
  let mocks: ReturnType<typeof makeMocks>
  let reconciler: SharedFileSystemReconciler

  beforeEach(() => {
    mocks = makeMocks()
    reconciler = makeReconciler(mocks)
  })

  it('isMountable is TRUE while Ready (PVC Bound + wfc serving)', async () => {
    const sfs = makeSfs()
    await reconciler.reconcile(sfs)
    expect(reconciler.getStatus(sfs).phase).toBe('Ready')
    expect(reconciler.isMountable(sfs)).toBe(true)
  })

  // The core resilience guarantee: a transient wfc HTTP outage (readyReplicas→0)
  // drops the SFS out of Ready, but the PVC stays Bound — so the RO mount MUST
  // remain mountable and never be ripped out of a running consumer pod.
  it('isMountable STAYS TRUE when the wfc is not serving but the PVC is Bound (Initializing)', async () => {
    mocks.coreApi.readNamespacedPersistentVolumeClaim.mockResolvedValue({
      status: { phase: 'Bound', capacity: { storage: '5Gi' } },
    })
    mocks.appsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: { resourceVersion: '1' },
      status: { readyReplicas: 0 },
    })
    mocks.coreApi.listNamespacedPod.mockResolvedValue({ items: [] }) // pod restarting
    const sfs = makeSfs()
    await reconciler.reconcile(sfs)
    expect(reconciler.getStatus(sfs).phase).toBe('Initializing')
    expect(reconciler.isMountable(sfs)).toBe(true)
  })

  it('isMountable STAYS TRUE on a Bound PVC even when the wfc container is CrashLoopBackOff (Degraded)', async () => {
    mocks.coreApi.readNamespacedPersistentVolumeClaim.mockResolvedValue({
      status: { phase: 'Bound', capacity: { storage: '5Gi' } },
    })
    mocks.appsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: { resourceVersion: '1' },
      status: { readyReplicas: 0 },
    })
    mocks.coreApi.listNamespacedPod.mockResolvedValue({
      items: [
        {
          status: {
            containerStatuses: [
              {
                name: 'workspace-files-controller',
                state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 5m0s' } },
              },
            ],
          },
        },
      ],
    })
    const sfs = makeSfs()
    await reconciler.reconcile(sfs)
    expect(reconciler.getStatus(sfs).phase).toBe('Degraded')
    expect(reconciler.isMountable(sfs)).toBe(true)
  })

  it('isMountable is FALSE while the PVC is not Bound (Pending) — nothing to mount', async () => {
    mocks.coreApi.readNamespacedPersistentVolumeClaim.mockResolvedValue({
      status: { phase: 'Pending' },
    })
    mocks.appsApi.readNamespacedDeployment.mockResolvedValue({
      metadata: { resourceVersion: '1' },
      status: { readyReplicas: 0 },
    })
    mocks.coreApi.listNamespacedPod.mockResolvedValue({ items: [] })
    const sfs = makeSfs()
    await reconciler.reconcile(sfs)
    expect(reconciler.isMountable(sfs)).toBe(false)
  })

  it('isMountable defaults to FALSE for an unknown SFS', () => {
    expect(reconciler.isMountable(makeSfs({ name: 'never-seen' }))).toBe(false)
  })

  it('clears mountability on delete', async () => {
    const sfs = makeSfs()
    await reconciler.reconcile(sfs)
    expect(reconciler.isMountable(sfs)).toBe(true)
    await reconciler.reconcileDelete(sfs.name, sfs.namespace, { retainOnDelete: true })
    expect(reconciler.isMountable(sfs)).toBe(false)
  })
})
