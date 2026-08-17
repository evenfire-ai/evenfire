import { describe, expect, it } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import { GfsK8sApi, GfsReconciler, GfsSeedClient } from './gfsReconciler'
import { GfsFactoryConfig } from './k8s/gfsFactory'
import type { GlobalFileSystemCRD, GlobalFileSystemStatus } from './types'

const config: GfsFactoryConfig = {
  gfsNamespace: 'gfs',
  controlPlaneNamespace: 'control-plane',
  postgresPodLabels: { app: 'control-postgres' },
  postgresPort: 5432,
  gfscImage: 'clerum-gfs-controller:test',
  gfscImagePullPolicy: 'IfNotPresent',
  gfscPort: 8087,
  gfscInitImage: 'busybox:1.36',
  gfscResources: {
    requests: { memory: '128Mi', cpu: '100m' },
    limits: { memory: '256Mi', cpu: '500m' },
  },
  jwtPublicKeyConfigMapName: 'gfs-config',
  jwtPublicKeyConfigMapKey: 'jwt-public-key',
  pgSecretName: 'gfs-controller-db',
  pgSecretKey: 'connection-string',
  readerPgSecretName: 'gfs-controller-reader-db',
  readerPgSecretKey: 'connection-string',
  driveName: 'main',
  tokenAudience: 'gfs-controller',
}

const gfs: GlobalFileSystemCRD = {
  name: 'gfs',
  namespace: 'gfs',
  spec: { layout: { rootDirectories: ['/org', '/system/published-workflow-artifacts'] } },
}

class FakeApi implements GfsK8sApi {
  operations: string[] = []
  deployments: string[] = []
  deploymentManifests: k8s.V1Deployment[] = []
  pdbs: string[] = []
  services: string[] = []
  netpols: string[] = []
  pvcs: string[] = []
  deleted: string[] = []
  statuses: GlobalFileSystemStatus[] = []
  writerNeedsUpdate = true
  writerAvailable = true
  writerAvailabilitySequence: boolean[] = []
  failPvc = false
  statusFailuresRemaining = 0

  async applyPvc(pvc: k8s.V1PersistentVolumeClaim): Promise<void> {
    if (this.failPvc) throw new Error('simulated PVC apply failure')
    this.pvcs.push(pvc.metadata?.name ?? '')
    this.operations.push(`pvc/${pvc.metadata?.name ?? ''}`)
  }
  async deploymentNeedsUpdate(dep: k8s.V1Deployment): Promise<boolean> {
    return dep.metadata?.name === 'gfsc-writer' ? this.writerNeedsUpdate : false
  }
  async scaleDeployment(name: string, _namespace: string, replicas: number): Promise<void> {
    this.operations.push(`scale/${name}/${replicas}`)
  }
  async applyDeployment(dep: k8s.V1Deployment): Promise<void> {
    const name = dep.metadata?.name ?? ''
    this.deployments.push(name)
    this.deploymentManifests.push(dep)
    this.operations.push(`deploy/${name}`)
  }
  async applyPodDisruptionBudget(pdb: k8s.V1PodDisruptionBudget): Promise<void> {
    const name = pdb.metadata?.name ?? ''
    this.pdbs.push(name)
    this.operations.push(`pdb/${name}`)
  }
  async applyService(svc: k8s.V1Service): Promise<void> {
    const name = svc.metadata?.name ?? ''
    this.services.push(name)
    this.operations.push(`svc/${name}`)
  }
  async applyNetworkPolicy(np: k8s.V1NetworkPolicy): Promise<void> {
    const name = np.metadata?.name ?? ''
    this.netpols.push(name)
    this.operations.push(`np/${name}`)
  }
  async isDeploymentAvailable(name: string): Promise<boolean> {
    if (name === 'gfsc-writer' && this.writerAvailabilitySequence.length > 0) {
      return this.writerAvailabilitySequence.shift() ?? false
    }
    return name === 'gfsc-writer' ? this.writerAvailable : true
  }
  async deleteDeployment(name: string): Promise<void> {
    this.deleted.push(`deploy/${name}`)
  }
  async deletePodDisruptionBudget(name: string): Promise<void> {
    this.deleted.push(`pdb/${name}`)
  }
  async deleteService(name: string): Promise<void> {
    this.deleted.push(`svc/${name}`)
  }
  async deleteNetworkPolicy(name: string): Promise<void> {
    this.deleted.push(`np/${name}`)
  }
  async deletePvc(name: string): Promise<void> {
    this.deleted.push(`pvc/${name}`)
  }
  async patchStatus(_name: string, _ns: string, status: GlobalFileSystemStatus): Promise<void> {
    if (this.statusFailuresRemaining > 0) {
      this.statusFailuresRemaining--
      throw new Error('simulated status patch failure')
    }
    this.statuses.push(status)
  }
}

class FakeSeed implements GfsSeedClient {
  calls = 0
  async seedRootDirectories(): Promise<void> {
    this.calls++
  }
}

describe('GfsReconciler.reconcile', () => {
  it('ensures the full stack: PVC + writer + reader Deployments + PDB + read/write Services + 2 NetPols', async () => {
    const api = new FakeApi()
    await new GfsReconciler(api, config).reconcile(gfs)
    expect(api.pvcs).toEqual(['gfs-drive'])
    expect(api.deployments).toEqual(['gfsc-writer', 'gfsc-reader'])
    expect(api.pdbs).toEqual(['gfsc-writer-pdb'])
    expect(api.services).toEqual(['gfsc', 'gfsc-writer'])
    expect(api.netpols).toEqual(['gfsc-ingress', 'gfsc-egress'])
    const writer = api.deploymentManifests.find(d => d.metadata?.name === 'gfsc-writer')
    const reader = api.deploymentManifests.find(d => d.metadata?.name === 'gfsc-reader')
    const pgRef = (dep: k8s.V1Deployment | undefined) =>
      dep?.spec?.template.spec?.containers[0].env?.find(variable =>
        Boolean(variable.valueFrom?.secretKeyRef)
      )?.valueFrom?.secretKeyRef?.name
    expect(pgRef(writer)).toBe('gfs-controller-db')
    expect(pgRef(reader)).toBe('gfs-controller-reader-db')
    expect(writer?.spec?.strategy).toEqual({ type: 'Recreate' })
    expect(reader?.spec?.strategy).toEqual({
      type: 'RollingUpdate',
      rollingUpdate: { maxUnavailable: 0, maxSurge: 1 },
    })
  })

  it('does not scale readers down when the writer template is already current', async () => {
    const api = new FakeApi()
    api.writerNeedsUpdate = false
    await new GfsReconciler(api, config).reconcile(gfs)
    expect(api.operations.some(op => op.startsWith('scale/gfsc-reader/'))).toBe(false)
    expect(api.deployments).toEqual(['gfsc-reader'])
  })

  it('scales readers down before a writer rollout and restores them after writer is Ready', async () => {
    const api = new FakeApi()
    api.writerNeedsUpdate = true
    await new GfsReconciler(api, config, undefined, 0, 0).reconcile(gfs)
    expect(api.deployments).toEqual(['gfsc-writer', 'gfsc-reader'])
    expect(api.operations.indexOf('scale/gfsc-reader/0')).toBeLessThan(
      api.operations.indexOf('deploy/gfsc-writer')
    )
    expect(api.operations.indexOf('deploy/gfsc-writer')).toBeLessThan(
      api.operations.indexOf('deploy/gfsc-reader')
    )
  })

  it('scales readers down to recover a current but unavailable writer, then restores them', async () => {
    const api = new FakeApi()
    api.writerNeedsUpdate = false
    api.writerAvailabilitySequence = [false, true]

    await new GfsReconciler(api, config, undefined, 0, 0).reconcile(gfs)

    expect(api.deployments).toEqual(['gfsc-reader'])
    expect(api.operations.indexOf('scale/gfsc-reader/0')).toBeLessThan(
      api.operations.indexOf('deploy/gfsc-reader')
    )
    expect(api.operations).not.toContain('deploy/gfsc-writer')
    expect(api.statuses.at(-1)?.phase).toBe('Ready')
  })

  it('leaves readers scaled down when a current writer is still unavailable', async () => {
    const api = new FakeApi()
    api.writerNeedsUpdate = false
    api.writerAvailable = false
    const seed = new FakeSeed()

    await new GfsReconciler(api, config, seed, 0, 0).reconcile(gfs)

    expect(api.deployments).toEqual([])
    expect(api.operations).toContain('scale/gfsc-reader/0')
    expect(api.statuses.at(-1)?.phase).toBe('Initializing')
    expect(seed.calls).toBe(0)
  })

  it('leaves readers scaled down when a changed writer is not Ready yet', async () => {
    const api = new FakeApi()
    api.writerNeedsUpdate = true
    api.writerAvailable = false
    const seed = new FakeSeed()

    await new GfsReconciler(api, config, seed, 0, 0).reconcile(gfs)

    expect(api.deployments).toEqual(['gfsc-writer'])
    expect(api.operations).toContain('scale/gfsc-reader/0')
    expect(api.statuses.at(-1)?.phase).toBe('Initializing')
    expect(seed.calls).toBe(0)
  })

  it('reports Ready + serviceUrl and seeds rootDirectories ONCE when the writer is available', async () => {
    const api = new FakeApi()
    const seed = new FakeSeed()
    const reconciler = new GfsReconciler(api, config, seed)

    await reconciler.reconcile(gfs)
    await reconciler.reconcile(gfs) // second pass must NOT re-seed

    expect(api.statuses.at(-1)?.phase).toBe('Ready')
    expect(api.statuses.at(-1)?.serviceUrl).toBe('http://gfsc.gfs.svc.cluster.local:8087')
    expect(seed.calls).toBe(1)
  })

  it('does not rewrite unchanged status but still publishes a later phase transition', async () => {
    const api = new FakeApi()
    api.writerNeedsUpdate = false
    const reconciler = new GfsReconciler(api, config, undefined, 0, 0)

    await reconciler.reconcile(gfs)
    const observedReady = { ...gfs, status: api.statuses[0] }
    await reconciler.reconcile(observedReady)

    expect(api.statuses).toHaveLength(1)
    expect(api.statuses[0]?.phase).toBe('Ready')

    api.writerAvailable = false
    await reconciler.reconcile(observedReady)

    expect(api.statuses.map(status => status.phase)).toEqual(['Ready', 'Initializing'])
  })

  it('publishes status for a same-name recreation even when the DELETE watch was missed', async () => {
    const api = new FakeApi()
    const reconciler = new GfsReconciler(api, config)

    await reconciler.reconcile(gfs)
    await reconciler.reconcile({ ...gfs, status: api.statuses[0] })
    await reconciler.reconcile({ ...gfs, status: undefined })

    expect(api.statuses).toHaveLength(2)
  })

  it('repairs status that was removed externally after HCC observed its prior write', async () => {
    const api = new FakeApi()
    const reconciler = new GfsReconciler(api, config)

    await reconciler.reconcile(gfs)
    await reconciler.reconcile({ ...gfs, status: api.statuses[0] })
    await reconciler.reconcile({ ...gfs, status: undefined })

    expect(api.statuses).toHaveLength(2)
    expect(api.statuses.at(-1)?.phase).toBe('Ready')
  })

  it('retries an unchanged status when the previous patch failed', async () => {
    const api = new FakeApi()
    api.statusFailuresRemaining = 1
    const reconciler = new GfsReconciler(api, config)

    await expect(reconciler.reconcile(gfs)).rejects.toThrow('simulated status patch failure')
    await expect(reconciler.reconcile(gfs)).resolves.toBeUndefined()

    expect(api.statuses).toHaveLength(1)
    expect(api.statuses[0]?.phase).toBe('Ready')
  })

  it('reports Initializing and does NOT seed when the writer is not yet available', async () => {
    const api = new FakeApi()
    api.writerAvailable = false
    const seed = new FakeSeed()
    await new GfsReconciler(api, config, seed, 0, 0).reconcile(gfs)
    expect(api.statuses.at(-1)?.phase).toBe('Initializing')
    expect(seed.calls).toBe(0)
  })
})

describe('GfsReconciler.fullReconcile', () => {
  it('reconciles a healthy desired gfs', async () => {
    const api = new FakeApi()
    await new GfsReconciler(api, config).fullReconcile([gfs])
    expect(api.statuses.at(-1)?.phase).toBe('Ready')
  })

  it('does NOT throw when an item fails — the error is logged and the loop converges', async () => {
    const api = new FakeApi()
    api.failPvc = true
    await expect(new GfsReconciler(api, config).fullReconcile([gfs])).resolves.toBeUndefined()
  })
})

describe('GfsReconciler.reconcileDelete', () => {
  it('retains the PVC by default (tears down broker, keeps bytes)', async () => {
    const api = new FakeApi()
    await new GfsReconciler(api, config).reconcileDelete(gfs)
    expect(api.deleted).toContain('deploy/gfsc-writer')
    expect(api.deleted).toContain('deploy/gfsc-reader')
    expect(api.deleted).toContain('pdb/gfsc-writer-pdb')
    expect(api.deleted).toContain('svc/gfsc-writer')
    expect(api.deleted).toContain('svc/gfsc')
    expect(api.deleted).toContain('np/gfsc-ingress')
    expect(api.deleted).toContain('np/gfsc-egress')
    expect(api.deleted.some(d => d.startsWith('pvc/'))).toBe(false)
  })

  it('deletes the PVC last when retainOnDelete is false', async () => {
    const api = new FakeApi()
    await new GfsReconciler(api, config).reconcileDelete({
      ...gfs,
      spec: { ...gfs.spec, retainOnDelete: false },
    })
    expect(api.deleted).toContain('pvc/gfs-drive')
    expect(api.deleted.at(-1)).toBe('pvc/gfs-drive') // bytes removed LAST
  })

  it('publishes status again after delete clears the prior write suppression', async () => {
    const api = new FakeApi()
    const reconciler = new GfsReconciler(api, config)

    await reconciler.reconcile(gfs)
    await reconciler.reconcileDelete(gfs)
    await reconciler.reconcile(gfs)

    expect(api.statuses).toHaveLength(2)
  })
})
